#!/usr/bin/env node
// Run at 00:05 UTC daily by the platform cron.
// Usage:
//   node scripts/daily-results.js
//   node scripts/daily-results.js --date 20260619
//   node scripts/daily-results.js --date 20260619 --asset BTC

'use strict';

const { Pool } = require('pg');
const { calculatePayouts, fetchClosePrice, closeDateForRound } = require('../lib/settlement');

const ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'TRX', 'HYPE', 'SUI', 'AVAX', 'DOGE', 'ADA', 'DOT', 'MATIC'];
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  TRX: 'tron', HYPE: 'hyperliquid', SUI: 'sui', AVAX: 'avalanche-2',
  DOGE: 'dogecoin', ADA: 'cardano', DOT: 'polkadot', MATIC: 'matic-network',
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
  let closePrice;
  try {
    const cgDate = closeDateForRound(roundDate);
    console.log(`[${asset}] Fetching CoinGecko close price for round ${roundDate} (snapshot ${cgDate})…`);
    closePrice = await fetchClosePrice(cgId, roundDate, { log: (msg) => console.warn(`[${asset}] ${msg}`) });
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
