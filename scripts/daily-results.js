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

// Ensure the daily_closes table exists (the server boot migration normally
// creates it; this keeps the standalone cron safe to run on its own).
async function ensureDailyClosesTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_closes (
      close_date DATE NOT NULL,
      asset VARCHAR(10) NOT NULL,
      close_price NUMERIC(20,8) NOT NULL,
      source TEXT,
      recorded_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (close_date, asset)
    )
  `);
}

async function processAsset(pool, roundDate, asset) {
  const { rows: ex } = await pool.query(
    'SELECT id, close_price FROM results WHERE round_date = $1 AND asset = $2', [roundDate, asset]
  );

  const { rows: guesses } = await pool.query(
    `SELECT user_id, username, price_guess::float, stake_tokens::float FROM guesses WHERE round_date = $1 AND asset = $2`,
    [roundDate, asset]
  );

  // Pot is the real sum of staked tokens (not a head-count).
  const potTotal = guesses.reduce((sum, g) => sum + (g.stake_tokens || 0), 0);

  // Resolve the daily close for EVERY asset (not just guessed ones), reusing an
  // already-stored results close when present to avoid a redundant API call.
  let closePrice = ex.length ? parseFloat(ex[0].close_price) : null;
  if (closePrice == null) {
    const cgId = COINGECKO_IDS[asset];
    try {
      const cgDate = closeDateForRound(roundDate);
      console.log(`[${asset}] Fetching CoinGecko close price for round ${roundDate} (snapshot ${cgDate})…`);
      closePrice = await fetchClosePrice(cgId, roundDate, { log: (msg) => console.warn(`[${asset}] ${msg}`) });
    } catch (e) {
      console.error(`[${asset}] CoinGecko error: ${e.message}`);
      return { asset, status: `error: ${e.message}` };
    }
  }

  if (closePrice == null) {
    console.warn(`[${asset}] No price data returned for ${roundDate}.`);
    return { asset, status: 'no price data' };
  }

  // Comprehensive per-token daily close (all assets, every day).
  await pool.query(
    `INSERT INTO daily_closes (close_date, asset, close_price, source) VALUES ($1, $2, $3, $4)
     ON CONFLICT (close_date, asset) DO NOTHING`,
    [roundDate, asset, closePrice, 'settlement']
  );

  // Results + payouts are gated on participation, exactly as before.
  if (ex.length) {
    console.log(`[${asset}] Already processed — recorded daily close only.`);
    return { asset, status: 'already processed', close_price: closePrice };
  }
  if (!guesses.length) {
    console.log(`[${asset}] No guesses — recorded daily close only.`);
    return { asset, status: 'no guesses', close_price: closePrice };
  }

  console.log(`[${asset}] Close price: $${closePrice}  |  ${guesses.length} guess(es)  |  pot ${potTotal} tokens`);

  const withDist = guesses.map(g => ({ ...g, distance: Math.abs(g.price_guess - closePrice) }));
  withDist.sort((a, b) => a.distance - b.distance);
  const payoutRows = calculatePayouts(withDist, potTotal);

  await pool.query(
    `INSERT INTO results (round_date, asset, close_price, pot_total) VALUES ($1, $2, $3, $4)
     ON CONFLICT (round_date, asset) DO NOTHING`,
    [roundDate, asset, closePrice, potTotal]
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
  return { asset, status: 'ok', close_price: closePrice, pot: potTotal };
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

  await ensureDailyClosesTable(pool);

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
