#!/usr/bin/env node
// Run at 00:05 UTC daily by the platform cron.
// Usage:
//   node scripts/daily-results.js
//   node scripts/daily-results.js --date 20260619
//   node scripts/daily-results.js --date 20260619 --asset BTC

'use strict';

const { Pool } = require('pg');

const ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'TRX', 'HYPE', 'SUI', 'AVAX'];
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  TRX: 'tron', HYPE: 'hyperliquid', SUI: 'sui', AVAX: 'avalanche-2',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      const d = args[++i];
      if (/^\d{8}$/.test(d)) {
        result.date = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        result.date = d;
      } else {
        console.error(`Invalid --date format: ${d}. Use YYYYMMDD or YYYY-MM-DD.`);
        process.exit(1);
      }
    } else if (args[i] === '--asset' && args[i + 1]) {
      result.asset = args[++i].toUpperCase();
      if (!ASSETS.includes(result.asset)) {
        console.error(`Unknown --asset: ${result.asset}. Valid: ${ASSETS.join(', ')}`);
        process.exit(1);
      }
    }
  }
  return result;
}

function calculatePayouts(sortedGuesses, potTotal) {
  const n = sortedGuesses.length;
  if (n === 0) return [];
  if (n === 1) {
    return [{
      ...sortedGuesses[0],
      place: 1,
      prize_tokens: Math.floor(potTotal * 0.95 * 10000) / 10000,
    }];
  }

  const PRIZES = [0.70, 0.20, 0.05];
  const payouts = [];
  const groups = [];
  let cur = [sortedGuesses[0]];
  for (let i = 1; i < n; i++) {
    if (Math.abs(sortedGuesses[i].distance - cur[0].distance) < 0.000001) {
      cur.push(sortedGuesses[i]);
    } else {
      groups.push(cur);
      cur = [sortedGuesses[i]];
    }
  }
  groups.push(cur);

  let placeStart = 0;
  for (const group of groups) {
    if (placeStart >= 3) break;
    const maxTier = Math.min(3, n);
    const tiersEnd = Math.min(placeStart + group.length, maxTier);
    let totalPct = 0;
    for (let t = placeStart; t < tiersEnd; t++) totalPct += PRIZES[t];
    const prizeEach = Math.floor(potTotal * totalPct / group.length * 10000) / 10000;
    for (const g of group) {
      if (placeStart < 3) payouts.push({ ...g, place: placeStart + 1, prize_tokens: prizeEach });
    }
    placeStart += group.length;
  }
  return payouts;
}

async function processAsset(pool, roundDate, asset) {
  const { rows: ex } = await pool.query(
    'SELECT id FROM results WHERE round_date = $1 AND asset = $2', [roundDate, asset]
  );
  if (ex.length) {
    console.log(`[${asset}] Already processed — skipping.`);
    return { asset, status: 'already processed' };
  }

  const { rows: guesses } = await pool.query(
    `SELECT user_id, username, price_guess::float FROM guesses WHERE round_date = $1 AND asset = $2`,
    [roundDate, asset]
  );
  if (!guesses.length) {
    console.log(`[${asset}] No guesses — skipping.`);
    return { asset, status: 'no guesses' };
  }

  const cgId = COINGECKO_IDS[asset];
  const [y, m, d] = roundDate.split('-');
  const cgDate = `${d}-${m}-${y}`;

  let closePrice;
  try {
    const apiKey = process.env.COINGECKO_API_KEY;
    let url = `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${cgDate}&localization=false`;
    if (apiKey) url += `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}`;
    console.log(`[${asset}] Fetching CoinGecko history for ${cgDate}…`);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    closePrice = data?.market_data?.current_price?.usd;
  } catch (e) {
    console.error(`[${asset}] CoinGecko error: ${e.message}`);
    return { asset, status: `error: ${e.message}` };
  }

  if (!closePrice) {
    console.warn(`[${asset}] No price data returned for ${roundDate}.`);
    return { asset, status: 'no price data' };
  }

  console.log(`[${asset}] Close price: $${closePrice}  |  ${guesses.length} guess(es)`);

  const withDist = guesses.map(g => ({ ...g, distance: Math.abs(g.price_guess - closePrice) }));
  withDist.sort((a, b) => a.distance - b.distance);
  const payoutRows = calculatePayouts(withDist, guesses.length);

  await pool.query(
    `INSERT INTO results (round_date, asset, close_price, pot_total) VALUES ($1, $2, $3, $4)
     ON CONFLICT (round_date, asset) DO NOTHING`,
    [roundDate, asset, closePrice, guesses.length]
  );
  for (const p of payoutRows) {
    await pool.query(
      `INSERT INTO payouts (round_date, asset, user_id, username, place, price_guess, prize_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (round_date, asset, user_id) DO NOTHING`,
      [roundDate, asset, p.user_id, p.username, p.place, p.price_guess, p.prize_tokens]
    );
    console.log(`  Place ${p.place}: ${p.username} → ${p.prize_tokens} tokens`);
  }
  return { asset, status: 'ok', close_price: closePrice, pot: guesses.length };
}

async function main() {
  const opts = parseArgs();

  const roundDate = opts.date || (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const assetsToProcess = opts.asset ? [opts.asset] : ASSETS;

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(`Processing round: ${roundDate}`);
  console.log(`Assets: ${assetsToProcess.join(', ')}\n`);

  const summary = [];
  for (const asset of assetsToProcess) {
    const result = await processAsset(pool, roundDate, asset);
    summary.push(result);
    if (assetsToProcess.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n── Summary ─────────────────');
  for (const s of summary) {
    const line = `  ${s.asset.padEnd(5)} ${s.status}` + (s.close_price ? ` | close=$${s.close_price} pot=${s.pot}` : '');
    console.log(line);
  }
  console.log('────────────────────────────\n');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
