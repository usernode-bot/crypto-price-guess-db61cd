const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { verifyGuessTransaction } = require('./lib/tx-match');
const { calculatePayouts, fetchClosePrice } = require('./lib/settlement');
const { STAGING_APP_PUBKEY, paymentsConfigured, buildConfig } = require('./lib/wallet-config');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// On-chain config. Each guess is a 1-token transfer from the player's linked
// Usernode wallet to APP_PUBKEY; CHAIN_ID is used for the explorer/node tx
// lookup during verification.
const APP_PUBKEY = process.env.APP_PUBKEY || '';
const CHAIN_ID = process.env.CHAIN_ID || 'usernode';
// STAGING_APP_PUBKEY (the placeholder destination used when APP_PUBKEY is unset
// in staging) and the app-wallet resolution helpers live in ./lib/wallet-config
// so they can be unit-tested without booting the server.

// Variable stake bounds (whole tokens). A guess stakes between MIN_STAKE and
// MAX_STAKE tokens from the player's wallet; the per-asset pot is the sum of
// stakes and the closest guesses split it. Surfaced via /api/config so the
// frontend chips/validation match the server without duplicating the numbers.
const MIN_STAKE = 1;
const MAX_STAKE = 1000;

const ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'TRX', 'HYPE', 'SUI', 'AVAX', 'DOGE', 'ADA', 'DOT', 'MATIC'];
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  TRX: 'tron', HYPE: 'hyperliquid', SUI: 'sui', AVAX: 'avalanche-2',
  DOGE: 'dogecoin', ADA: 'cardano', DOT: 'polkadot', MATIC: 'matic-network',
};

let priceCache = { data: null, fetchedAt: 0 };
// Per-asset 1-hour intraday history cache: { [asset]: { data, fetchedAt } }
const priceHistoryCache = {};

// Representative spot price per asset for staging synthesis (mirrors seedStaging's
// fakePrices last column). Used only when IS_STAGING and the live fetch is empty.
const STAGING_BASE_PRICE = {
  BTC: 102700, ETH: 2700, SOL: 170, BNB: 675,
  TRX: 0.26, HYPE: 34, SUI: 3.7, AVAX: 27,
};

// /api/admin/daily-results uses x-admin-key instead of JWT.
// In staging, history/leaderboard/prices/predictions are public so proposal tests can verify
// dynamic selectors without the test framework needing to inject auth tokens.
const PUBLIC_API_PATHS = new Set([
  '/health',
  '/api/admin/daily-results',
  // Public so the frontend can read the app wallet / chain id before auth is
  // established and so staging proposal tests can load it without a token.
  '/api/config',
  // In staging these are public so proposal tests can verify dynamic selectors
  // (incl. the reward-boost badge, which sums the round pot) without the test
  // framework needing to inject auth tokens.
  ...(IS_STAGING ? ['/api/prices', '/api/price-history', '/api/history', '/api/leaderboard', '/api/round/current', '/api/user/predictions', '/api/profile'] : []),
]);
const PUBLIC_PREFIXES = ['/explorer-api/'];

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// On-chain config for the frontend: where to send the 1-token guess payment,
// which chain to await it on, and whether we're in staging (mock chain).
app.get('/api/config', (req, res) => {
  // usernode_pubkey is included only when req.user is present so the public
  // (unauthenticated) path never leaks a wallet address. payments_configured
  // tells the frontend whether a real app wallet exists to receive payments.
  res.json({
    ...buildConfig({
      appPubkey: APP_PUBKEY,
      chainId: CHAIN_ID,
      isStaging: IS_STAGING,
      explorerBase: process.env.EXPLORER_TX_URL_BASE || null,
      user: req.user,
    }),
    min_stake: MIN_STAKE,
    max_stake: MAX_STAKE,
  });
});

function getCurrentRoundDate() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchLivePrices() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.fetchedAt < 60000) return priceCache.data;

  const ids = Object.values(COINGECKO_IDS).join(',');
  const apiKey = process.env.COINGECKO_API_KEY;
  let url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  if (apiKey) url += `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return priceCache.data || null;
  const json = await res.json();

  const data = {};
  for (const [ticker, cgId] of Object.entries(COINGECKO_IDS)) {
    if (json[cgId]) {
      data[ticker] = { usd: json[cgId].usd, change24h: json[cgId].usd_24h_change || 0 };
    }
  }
  priceCache = { data, fetchedAt: now };
  return data;
}

app.get('/api/prices', async (_req, res) => {
  try {
    const prices = await fetchLivePrices();
    res.json({ prices: prices || {} });
  } catch {
    res.json({ prices: priceCache.data || {} });
  }
});

// Build a deterministic ~12-point, 60-minute synthetic series around a base price.
// No Math.random so staging output is stable for proposal tests.
function synthHistory(asset) {
  const base = STAGING_BASE_PRICE[asset];
  if (!base) return { asset, points: [], current: null, change_pct: 0 };
  const now = Date.now();
  const points = [];
  const N = 12;
  for (let i = 0; i < N; i++) {
    // Smooth deterministic wiggle: blend two sines keyed on index + asset length.
    const phase = i + asset.length;
    const wiggle = Math.sin(phase * 0.7) * 0.012 + Math.sin(phase * 0.27) * 0.006;
    const p = base * (1 + wiggle);
    const t = now - (N - 1 - i) * 5 * 60 * 1000;
    points.push({ t, p: parseFloat(p.toFixed(8)) });
  }
  const first = points[0].p;
  const last = points[points.length - 1].p;
  return {
    asset,
    points,
    current: last,
    change_pct: first ? ((last - first) / first) * 100 : 0,
  };
}

async function fetchPriceHistory(asset) {
  const now = Date.now();
  const cached = priceHistoryCache[asset];
  if (cached && now - cached.fetchedAt < 60000) return cached.data;

  const cgId = COINGECKO_IDS[asset];
  const apiKey = process.env.COINGECKO_API_KEY;
  let url = `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?vs_currency=usd&days=1`;
  if (apiKey) url += `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}`;

  let data = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json = await res.json();
      const raw = Array.isArray(json?.prices) ? json.prices : [];
      const cutoff = now - 60 * 60 * 1000;
      const recent = raw.filter(([t]) => t >= cutoff).map(([t, p]) => ({ t, p }));
      const points = recent.length >= 2 ? recent : raw.slice(-12).map(([t, p]) => ({ t, p }));
      if (points.length >= 2) {
        const first = points[0].p;
        const last = points[points.length - 1].p;
        data = {
          asset,
          points,
          current: last,
          change_pct: first ? ((last - first) / first) * 100 : 0,
        };
      }
    }
  } catch {
    // fall through to fallback handling below
  }

  // Graceful failure / empty: in staging synthesize a stable series; otherwise
  // return last good cache if present, else an empty series.
  if (!data) {
    if (IS_STAGING) {
      data = synthHistory(asset);
    } else if (cached?.data) {
      return cached.data;
    } else {
      data = { asset, points: [], current: null, change_pct: 0 };
    }
  }

  priceHistoryCache[asset] = { data, fetchedAt: now };
  return data;
}

app.get('/api/price-history', async (req, res) => {
  try {
    const asset = req.query.asset;
    if (!ASSETS.includes(asset)) return res.status(400).json({ error: 'Invalid asset' });
    const data = await fetchPriceHistory(asset);
    res.json(data);
  } catch {
    res.json({ asset: req.query.asset || null, points: [], current: null, change_pct: 0 });
  }
});

app.get('/api/round/current', async (req, res) => {
  try {
    const roundDate = getCurrentRoundDate();
    const { rows: potRows } = await pool.query(
      `SELECT asset, COUNT(*) AS guess_count, COALESCE(SUM(stake_tokens), 0) AS pot_tokens
       FROM guesses WHERE round_date = $1 GROUP BY asset`,
      [roundDate]
    );
    const pots = {};
    for (const a of ASSETS) pots[a] = { guess_count: 0, pot_tokens: 0 };
    for (const r of potRows) {
      pots[r.asset] = { guess_count: parseInt(r.guess_count), pot_tokens: parseFloat(r.pot_tokens) };
    }
    // req.user is absent on the staging-public path (proposal tests); the pot
    // totals above don't need it, and my_guesses is simply empty then.
    let myGuesses = [];
    if (req.user) {
      ({ rows: myGuesses } = await pool.query(
        `SELECT asset, price_guess, stake_tokens, message, tx_hash, submitted_at FROM guesses WHERE round_date = $1 AND user_id = $2`,
        [roundDate, req.user.id]
      ));
    }
    res.json({ round_date: roundDate, pots, my_guesses: myGuesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/guess', async (req, res) => {
  try {
    // Without a real app wallet there is no destination for the 1-token
    // payment, so reject clearly instead of recording an unpayable guess.
    // Staging is always "configured" (placeholder destination + verification
    // skipped); production requires APP_PUBKEY to be set.
    if (!paymentsConfigured(APP_PUBKEY, IS_STAGING)) {
      return res.status(503).json({ error: 'On-chain payments are not configured' });
    }

    const { asset, price_guess, message, tx_hash, stake } = req.body;
    if (!ASSETS.includes(asset)) return res.status(400).json({ error: 'Invalid asset' });
    const pg = parseFloat(price_guess);
    if (isNaN(pg) || pg <= 0) return res.status(400).json({ error: 'Invalid price' });

    // Stake is a whole number of tokens within [MIN_STAKE, MAX_STAKE]. The
    // on-chain payment amount must equal this, and the pot is the sum of stakes.
    const stakeNum = Number(stake);
    if (!Number.isInteger(stakeNum) || stakeNum < MIN_STAKE || stakeNum > MAX_STAKE) {
      return res.status(400).json({ error: `Stake must be a whole number between ${MIN_STAKE} and ${MAX_STAKE} tokens` });
    }

    const now = new Date();
    const secs = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    if (secs >= 86390) return res.status(400).json({ error: 'Round is closing — try again tomorrow' });

    // A guess is an on-chain payment of `stake` tokens from the player's wallet
    // to the app wallet; it is only recorded once that transaction is verified.
    if (!req.user.usernode_pubkey) {
      return res.status(400).json({ error: 'Link your Usernode wallet to play' });
    }
    const txHash = typeof tx_hash === 'string' ? tx_hash.trim() : '';
    if (!txHash) return res.status(400).json({ error: 'Missing transaction' });

    const roundDate = getCurrentRoundDate();
    const priceStr = pg.toFixed(2);

    // Idempotency: a confirmed payment whose POST was retried (e.g. the client
    // stashed the tx_hash after a transient failure) returns the existing row
    // rather than charging again.
    const { rows: existing } = await pool.query(
      `SELECT * FROM guesses WHERE user_id = $1 AND round_date = $2 AND asset = $3`,
      [req.user.id, roundDate, asset]
    );
    if (existing.length && existing[0].tx_hash && existing[0].tx_hash === txHash) {
      return res.json({ ok: true, guess: existing[0] });
    }
    // Lock: one stake per asset per round. A different (new) payment for an asset
    // already staked is rejected so a stake is never silently doubled.
    if (existing.length && existing[0].tx_hash && existing[0].tx_hash !== txHash) {
      return res.status(400).json({ error: "You've already staked on this asset today" });
    }

    // Replay protection: a transaction may back at most one guess row.
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM guesses
       WHERE tx_hash = $1 AND NOT (user_id = $2 AND round_date = $3 AND asset = $4)
       LIMIT 1`,
      [txHash, req.user.id, roundDate, asset]
    );
    if (dup.length) {
      return res.status(400).json({ error: 'This transaction has already been used for a guess' });
    }

    // Memo binds the on-chain payment to this exact guess, including the stake.
    // Built server-side from validated inputs — a client memo is never trusted.
    const expectedMemo = `cpg|v1|${roundDate}|${asset}|${priceStr}|${stakeNum}`;

    // Staging has no real chain (APP_PRIVKEY is a dummy), so the on-chain
    // verification is skipped and the mock tx_hash is accepted as-is.
    if (!IS_STAGING) {
      const verdict = await verifyGuessTransaction({
        txHash,
        chainId: CHAIN_ID,
        expectedTo: APP_PUBKEY,
        expectedFrom: req.user.usernode_pubkey,
        expectedAmount: stakeNum,
        expectedMemo,
      });
      if (!verdict.ok) {
        return res.status(400).json({ error: 'Guess transaction could not be verified' });
      }
    }

    // Insert-or-reject: the lock check above already rejected a re-stake, so the
    // only ON CONFLICT path here is a row that exists with no tx_hash yet (rare
    // legacy state) — fill it in once.
    const { rows } = await pool.query(`
      INSERT INTO guesses (user_id, username, round_date, asset, price_guess, stake_tokens, message, tx_hash, tx_from, tx_confirmed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (user_id, round_date, asset) DO UPDATE
        SET price_guess = EXCLUDED.price_guess,
            stake_tokens = EXCLUDED.stake_tokens,
            message = EXCLUDED.message,
            tx_hash = EXCLUDED.tx_hash,
            tx_from = EXCLUDED.tx_from,
            tx_confirmed_at = NOW(),
            submitted_at = NOW()
      WHERE guesses.tx_hash IS NULL
      RETURNING *
    `, [req.user.id, req.user.username, roundDate, asset, priceStr, stakeNum, message?.slice(0, 140) || null, txHash, req.user.usernode_pubkey]);
    if (!rows.length) {
      // Conflict fell through the WHERE guard — an existing confirmed stake.
      return res.status(400).json({ error: "You've already staked on this asset today" });
    }
    res.json({ ok: true, guess: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conservative tx-hash shape: hex / base58-ish refs, plus the dashed/colon'd
// fake refs we seed in staging. Bounded length to keep junk out of the column.
const TX_HASH_RE = /^[A-Za-z0-9_:-]{8,128}$/;

// Attach an on-chain transaction reference to the caller's guess for today's
// round. Called by the frontend after sendTransaction resolves; best-effort,
// so a guess that never reaches this route simply has a null tx_hash.
app.post('/api/guess/tx', async (req, res) => {
  try {
    const { asset, tx_hash } = req.body;
    if (!ASSETS.includes(asset)) return res.status(400).json({ error: 'Invalid asset' });
    if (typeof tx_hash !== 'string' || !TX_HASH_RE.test(tx_hash)) {
      return res.status(400).json({ error: 'Invalid tx hash' });
    }
    const roundDate = getCurrentRoundDate();
    const { rowCount } = await pool.query(
      `UPDATE guesses SET tx_hash = $1 WHERE user_id = $2 AND round_date = $3 AND asset = $4`,
      [tx_hash, req.user.id, roundDate, asset]
    );
    if (!rowCount) return res.status(404).json({ error: 'No guess to attach to' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseDateParam(d) {
  if (/^\d{8}$/.test(d)) return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return null;
}

app.get('/api/round/:date/guesses', async (req, res) => {
  try {
    const roundDate = parseDateParam(req.params.date);
    if (!roundDate) return res.status(400).json({ error: 'Invalid date' });
    const asset = req.query.asset && ASSETS.includes(req.query.asset) ? req.query.asset : null;

    const params = [roundDate];
    let q = `SELECT user_id, username, asset, price_guess, message, submitted_at
             FROM guesses WHERE round_date = $1`;
    if (asset) { q += ` AND asset = $2`; params.push(asset); }
    q += ` ORDER BY asset, submitted_at ASC`;

    const { rows } = await pool.query(q, params);

    if (asset) {
      try {
        const prices = await fetchLivePrices();
        if (prices?.[asset]) {
          const cp = prices[asset].usd;
          rows.sort((a, b) => Math.abs(a.price_guess - cp) - Math.abs(b.price_guess - cp));
        }
      } catch {}
    }
    res.json({ guesses: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/round/:date/results', async (req, res) => {
  try {
    const roundDate = parseDateParam(req.params.date);
    if (!roundDate) return res.status(400).json({ error: 'Invalid date' });

    const { rows: results } = await pool.query(
      `SELECT * FROM results WHERE round_date = $1 ORDER BY asset`, [roundDate]
    );
    if (!results.length) return res.status(404).json({ error: 'No results yet for this date' });

    // LEFT JOIN the winner's guess to surface how much they staked alongside
    // their prize. (Winnings remain ledger-only; this is display data.)
    const { rows: payouts } = await pool.query(
      `SELECT p.*, g.stake_tokens
       FROM payouts p
       LEFT JOIN guesses g
         ON g.round_date = p.round_date AND g.asset = p.asset AND g.user_id = p.user_id
       WHERE p.round_date = $1 ORDER BY p.asset, p.place`, [roundDate]
    );
    const byAsset = {};
    for (const p of payouts) {
      if (!byAsset[p.asset]) byAsset[p.asset] = [];
      byAsset[p.asset].push(p);
    }
    res.json({ results: results.map(r => ({ ...r, payouts: byAsset[r.asset] || [] })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT round_date, COUNT(DISTINCT asset) AS assets_processed, SUM(pot_total) AS total_pot
      FROM results GROUP BY round_date ORDER BY round_date DESC LIMIT 30
    `);
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const period = req.query.period || 'alltime';
    let cutoffDate = null;
    const now = new Date();

    if (period === 'week') {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      d.setUTCHours(0, 0, 0, 0);
      cutoffDate = d.toISOString().slice(0, 10);
    } else if (period === 'month') {
      cutoffDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    }

    const params = cutoffDate ? [cutoffDate] : [];
    // Period filter applied to both the guesses⋈results accuracy set and the payouts set.
    const accWhere = cutoffDate ? 'AND g.round_date >= $1' : '';
    const payWhere = cutoffDate ? 'WHERE round_date >= $1' : '';

    // Top Guessers: per-player prediction accuracy from settled guesses
    // (a guess whose (round_date, asset) has a results row), LEFT JOINed
    // onto payout totals so accurate players with no prize still appear.
    const { rows } = await pool.query(`
      WITH acc AS (
        SELECT g.user_id,
               MAX(g.username) AS username,
               ROUND((AVG(GREATEST(0, 1 - ABS(g.price_guess - r.close_price) / NULLIF(r.close_price, 0))) * 100)::numeric, 1) AS accuracy_pct,
               COUNT(*) AS guesses_count
        FROM guesses g
        JOIN results r ON r.round_date = g.round_date AND r.asset = g.asset
        WHERE TRUE ${accWhere}
        GROUP BY g.user_id
      ),
      pay AS (
        SELECT user_id,
               ROUND(SUM(prize_tokens)::numeric, 2) AS total_won,
               COUNT(*) FILTER (WHERE place = 1) AS wins,
               COUNT(DISTINCT round_date) AS rounds_with_prizes
        FROM payouts ${payWhere}
        GROUP BY user_id
      )
      SELECT acc.username,
             acc.accuracy_pct,
             acc.guesses_count,
             COALESCE(pay.total_won, 0) AS total_won,
             COALESCE(pay.wins, 0) AS wins,
             COALESCE(pay.rounds_with_prizes, 0) AS rounds_with_prizes
      FROM acc LEFT JOIN pay ON pay.user_id = acc.user_id
      WHERE acc.guesses_count >= 1
      ORDER BY acc.accuracy_pct DESC, total_won DESC, acc.guesses_count DESC, acc.username ASC
      LIMIT 50
    `, params);

    let myStats = null;
    if (req.user) {
      const myAccWhere = cutoffDate ? 'AND g.round_date >= $2' : '';
      const myPayWhere = cutoffDate ? 'AND round_date >= $2' : '';
      const myParams = cutoffDate ? [req.user.id, cutoffDate] : [req.user.id];
      const { rows: myStatRows } = await pool.query(`
        SELECT (
                 SELECT ROUND((AVG(GREATEST(0, 1 - ABS(g.price_guess - r.close_price) / NULLIF(r.close_price, 0))) * 100)::numeric, 1)
                 FROM guesses g
                 JOIN results r ON r.round_date = g.round_date AND r.asset = g.asset
                 WHERE g.user_id = $1 ${myAccWhere}
               ) AS accuracy_pct,
               (
                 SELECT COUNT(*)
                 FROM guesses g
                 JOIN results r ON r.round_date = g.round_date AND r.asset = g.asset
                 WHERE g.user_id = $1 ${myAccWhere}
               ) AS guesses_count,
               (
                 SELECT ROUND(COALESCE(SUM(prize_tokens), 0)::numeric, 2)
                 FROM payouts WHERE user_id = $1 ${myPayWhere}
               ) AS total_won,
               (
                 SELECT COUNT(*) FILTER (WHERE place = 1)
                 FROM payouts WHERE user_id = $1 ${myPayWhere}
               ) AS wins
      `, myParams);
      myStats = myStatRows[0];
    }

    res.json({ leaderboard: rows, my_stats: myStats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/me', async (req, res) => {
  try {
    const roundDate = getCurrentRoundDate();
    const { rows: todayGuesses } = await pool.query(
      `SELECT asset, price_guess, message, tx_hash, submitted_at FROM guesses WHERE round_date = $1 AND user_id = $2`,
      [roundDate, req.user.id]
    );
    const { rows: gStats } = await pool.query(
      `SELECT COUNT(DISTINCT round_date) AS rounds_played FROM guesses WHERE user_id = $1`,
      [req.user.id]
    );
    const { rows: wStats } = await pool.query(
      `SELECT ROUND(COALESCE(SUM(prize_tokens), 0)::numeric, 2) AS total_won,
              COUNT(*) FILTER (WHERE place = 1) AS wins FROM payouts WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({
      username: req.user.username,
      today_guesses: todayGuesses,
      rounds_played: parseInt(gStats[0]?.rounds_played || 0),
      total_won: parseFloat(wStats[0]?.total_won || 0),
      wins: parseInt(wStats[0]?.wins || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/predictions', async (req, res) => {
  try {
    const isDemo = IS_STAGING && req.query.demo === '1';
    let userId;
    if (isDemo) {
      userId = 900001;
    } else if (req.user) {
      userId = req.user.id;
    } else {
      return res.json({ predictions: [], total: 0 });
    }

    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

    const { rows: predictions } = await pool.query(`
      SELECT
        g.round_date, g.asset, g.price_guess, g.stake_tokens, g.message, g.tx_hash, g.submitted_at,
        r.close_price, r.pot_total,
        p.place, p.prize_tokens
      FROM guesses g
      LEFT JOIN results r ON r.round_date = g.round_date AND r.asset = g.asset
      LEFT JOIN payouts p ON p.round_date = g.round_date AND p.asset = g.asset AND p.user_id = g.user_id
      WHERE g.user_id = $1
      ORDER BY g.round_date DESC, g.asset ASC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) AS total FROM guesses WHERE user_id = $1`, [userId]
    );

    res.json({ predictions, total: parseInt(countRows[0].total) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profile', async (req, res) => {
  try {
    const isDemo = IS_STAGING && req.query.demo === '1';
    let userId, username;
    if (isDemo) {
      userId = 900001;
      username = 'staging-alice';
    } else if (req.user) {
      userId = req.user.id;
      username = req.user.username;
    } else {
      return res.json({
        username: null, display_name: null, bio: null, wallet_pubkey: null,
        stats: { total_guesses: 0, rounds_played: 0, wins: 0, total_won: 0, accuracy_pct: null },
      });
    }

    // Server-authoritative wallet address for the Profile wallet card. In the
    // ?demo=1 staging path there is no real bridge/token, so synthesize the same
    // obviously-fake address seedStaging uses as staging-alice's tx_from.
    const walletPubkey = isDemo
      ? 'ut1-staging-alice'
      : (req.user && req.user.usernode_pubkey) || null;

    const { rows: profRows } = await pool.query(
      `SELECT display_name, bio, username FROM profiles WHERE user_id = $1`, [userId]
    );
    const prof = profRows[0] || {};

    // Lifetime stats. Accuracy mirrors /api/leaderboard's my_stats expression so
    // the number matches the "You" row on the Board.
    const { rows: statRows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM guesses WHERE user_id = $1) AS total_guesses,
        (SELECT COUNT(DISTINCT round_date) FROM guesses WHERE user_id = $1) AS rounds_played,
        (
          SELECT ROUND((AVG(GREATEST(0, 1 - ABS(g.price_guess - r.close_price) / NULLIF(r.close_price, 0))) * 100)::numeric, 1)
          FROM guesses g
          JOIN results r ON r.round_date = g.round_date AND r.asset = g.asset
          WHERE g.user_id = $1
        ) AS accuracy_pct,
        (SELECT ROUND(COALESCE(SUM(prize_tokens), 0)::numeric, 2) FROM payouts WHERE user_id = $1) AS total_won,
        (SELECT COUNT(*) FILTER (WHERE place = 1) FROM payouts WHERE user_id = $1) AS wins
    `, [userId]);
    const s = statRows[0] || {};

    res.json({
      username: prof.username || username,
      display_name: prof.display_name || null,
      bio: prof.bio || null,
      wallet_pubkey: walletPubkey,
      stats: {
        total_guesses: parseInt(s.total_guesses || 0),
        rounds_played: parseInt(s.rounds_played || 0),
        wins: parseInt(s.wins || 0),
        total_won: parseFloat(s.total_won || 0),
        accuracy_pct: s.accuracy_pct != null ? parseFloat(s.accuracy_pct) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/profile', async (req, res) => {
  try {
    const clean = (v, max) => {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t ? t.slice(0, max) : null;
    };
    const displayName = clean(req.body.display_name, 40);
    const bio = clean(req.body.bio, 280);

    const { rows } = await pool.query(`
      INSERT INTO profiles (user_id, username, display_name, bio)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            bio = EXCLUDED.bio,
            username = EXCLUDED.username,
            updated_at = NOW()
      RETURNING display_name, bio, username
    `, [req.user.id, req.user.username, displayName, bio]);

    res.json({ ok: true, profile: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/daily-results', (_req, res) => {
  res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
});

app.post('/api/admin/daily-results', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const dateParam = req.query.date;
    let targetDate;
    if (dateParam) {
      targetDate = parseDateParam(dateParam);
      if (!targetDate) return res.status(400).json({ error: 'Invalid date' });
    } else {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      targetDate = yesterday.toISOString().slice(0, 10);
    }
    // Opt-in recompute: ?force=1 clears any existing settlement for the date so
    // it is rebuilt against the corrected closing price. Default skips settled rows.
    const force = req.query.force === '1';
    if (force) {
      await pool.query('DELETE FROM payouts WHERE round_date = $1', [targetDate]);
      await pool.query('DELETE FROM results WHERE round_date = $1', [targetDate]);
    }
    const results = await processDailyResults(pool, targetDate);
    res.json({ ok: true, forced: force, processed: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function processDailyResults(dbPool, roundDate) {
  const processed = [];
  for (const asset of ASSETS) {
    const { rows: ex } = await dbPool.query(
      'SELECT id FROM results WHERE round_date = $1 AND asset = $2', [roundDate, asset]
    );
    if (ex.length) { processed.push({ asset, status: 'already processed' }); continue; }

    const { rows: guesses } = await dbPool.query(
      `SELECT user_id, username, price_guess::float, stake_tokens::float FROM guesses WHERE round_date = $1 AND asset = $2`,
      [roundDate, asset]
    );
    if (!guesses.length) { processed.push({ asset, status: 'no guesses' }); continue; }

    // The pot is the sum of real staked tokens (not a head-count). The closest
    // guesses split it via calculatePayouts, which already takes an arbitrary pot.
    const potTotal = guesses.reduce((sum, g) => sum + (g.stake_tokens || 0), 0);

    const cgId = COINGECKO_IDS[asset];
    // Settle against the round's CLOSING price — the 00:00-UTC snapshot of the
    // day AFTER round_date — via the shared helper (see lib/settlement.js).
    let closePrice;
    try {
      closePrice = await fetchClosePrice(cgId, roundDate, { log: (msg) => console.warn(`[${asset}] ${msg}`) });
    } catch (e) {
      console.error(`CoinGecko error for ${asset}:`, e.message);
      processed.push({ asset, status: `error: ${e.message}` });
      continue;
    }

    if (!closePrice) {
      console.warn(`No price data for ${asset} on ${roundDate}`);
      processed.push({ asset, status: 'no price data' });
      continue;
    }

    const withDist = guesses.map(g => ({ ...g, distance: Math.abs(g.price_guess - closePrice) }));
    withDist.sort((a, b) => a.distance - b.distance);
    const payoutRows = calculatePayouts(withDist, potTotal);

    await dbPool.query(
      `INSERT INTO results (round_date, asset, close_price, pot_total) VALUES ($1, $2, $3, $4)
       ON CONFLICT (round_date, asset) DO NOTHING`,
      [roundDate, asset, closePrice, potTotal]
    );
    for (const p of payoutRows) {
      await dbPool.query(
        `INSERT INTO payouts (round_date, asset, user_id, username, place, price_guess, prize_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (round_date, asset, user_id) DO NOTHING`,
        [roundDate, asset, p.user_id, p.username, p.place, p.price_guess, p.prize_tokens]
      );
    }
    await new Promise(r => setTimeout(r, 500));
    processed.push({ asset, status: 'ok', close_price: closePrice, pot: potTotal });
  }
  return processed;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  // In staging the shell is public so proposal tests can verify CSS selectors.
  // In production, unauthenticated direct visits get a friendly 401 redirect page.
  if (!req.user && !IS_STAGING) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:#ffffff;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function seedStaging() {
  if (!IS_STAGING) return;

  const fakePrices = {
    BTC: [101500, 102300, 99800, 103400, 104100, 100200, 102700],
    ETH: [2680, 2710, 2650, 2730, 2780, 2640, 2700],
    SOL: [168, 172, 165, 175, 182, 163, 170],
    BNB: [670, 685, 660, 690, 695, 655, 675],
    TRX: [0.26, 0.27, 0.25, 0.27, 0.27, 0.25, 0.26],
    HYPE: [32, 35, 30, 36, 38, 29, 34],
    SUI: [3.6, 3.8, 3.4, 3.9, 4.0, 3.3, 3.7],
    AVAX: [26, 28, 25, 29, 30, 24, 27],
    DOGE: [0.17, 0.18, 0.16, 0.18, 0.19, 0.16, 0.17],
    ADA: [0.35, 0.37, 0.34, 0.38, 0.39, 0.33, 0.36],
    DOT: [4.50, 4.80, 4.30, 4.90, 5.00, 4.20, 4.60],
    MATIC: [0.40, 0.43, 0.39, 0.44, 0.45, 0.38, 0.41],
  };
  const fakeUsers = [
    { id: 900001, username: 'staging-alice' },
    { id: 900002, username: 'staging-bob' },
    { id: 900003, username: 'staging-carol' },
    { id: 900004, username: 'staging-dave' },
    { id: 900005, username: 'staging-eve' },
  ];

  // Varied stakes per user index so pots, the leaderboard's "total won," and the
  // new staked-amount UI render with visible spread rather than all-1s.
  const STAKE_CYCLE = [1, 5, 10, 25];
  const stakeForUser = (idx) => STAKE_CYCLE[idx % STAKE_CYCLE.length];

  const today = new Date();

  // Seed a profile for staging-alice (900001) — the demo user the read-only
  // ?demo=1 paths resolve to — so the Profile screen renders populated in staging.
  await pool.query(
    `INSERT INTO profiles (user_id, username, display_name, bio)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO NOTHING`,
    [900001, 'staging-alice', 'Staging Demo — Alice', 'Staging demo — I chase tight crypto predictions for fun.']
  );

  // Seed 7 completed past rounds
  for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const roundDate = d.toISOString().slice(0, 10);
    const priceIdx = 7 - daysAgo;

    for (let ai = 0; ai < ASSETS.length; ai++) {
      const asset = ASSETS[ai];
      const closePrice = fakePrices[asset][priceIdx];
      // Pot is the real sum of the 5 users' varied stakes (1+5+10+25+1 = 42).
      const potTotal = fakeUsers.reduce((sum, _u, idx) => sum + stakeForUser(idx), 0);

      await pool.query(
        `INSERT INTO results (round_date, asset, close_price, pot_total) VALUES ($1, $2, $3, $4)
         ON CONFLICT (round_date, asset) DO NOTHING`,
        [roundDate, asset, closePrice, potTotal]
      );

      const offset = (ai + priceIdx) % 5;
      const prizes = [
        Math.floor(potTotal * 0.70 * 10000) / 10000,
        Math.floor(potTotal * 0.20 * 10000) / 10000,
        Math.floor(potTotal * 0.05 * 10000) / 10000,
      ];

      // Per-user characteristic error so the Top Guessers podium has a
      // visible accuracy spread (alice tightest → eve loosest).
      const USER_ERR = [0.001, 0.004, 0.010, 0.020, 0.035];
      for (let pi = 0; pi < 5; pi++) {
        const uIdx = (offset + pi) % 5;
        const w = fakeUsers[uIdx];
        const dir = (priceIdx + uIdx) % 2 === 0 ? 1 : -1;
        const mult = 1 + dir * USER_ERR[uIdx];
        const guessPrice = parseFloat((closePrice * mult).toFixed(2));
        const stake = stakeForUser(uIdx);
        const submittedAt = roundDate + 'T12:00:00.000Z';
        // Give the demo user (900001 — the ?demo=1 My Predictions view) an
        // obviously-fake on-chain receipt on every other asset, so both the
        // "recorded on-chain" and the "no receipt" states are visible.
        const txHash = (w.id === 900001 && ai % 2 === 0)
          ? `staging-demo-tx-${roundDate}-${asset}`
          : null;
        await pool.query(
          `INSERT INTO guesses (user_id, username, round_date, asset, price_guess, stake_tokens, submitted_at, tx_hash, tx_from, tx_confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (user_id, round_date, asset) DO NOTHING`,
          [w.id, w.username, roundDate, asset, guessPrice, stake, submittedAt, txHash, txHash ? `ut1-${w.username}` : null, txHash ? submittedAt : null]
        );
        if (pi < 3) {
          await pool.query(
            `INSERT INTO payouts (round_date, asset, user_id, username, place, price_guess, prize_tokens)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (round_date, asset, user_id) DO NOTHING`,
            [roundDate, asset, w.id, w.username, pi + 1, guessPrice, prizes[pi]]
          );
        }
      }
    }
  }

  // Seed today's open-round guesses
  const todayDate = today.toISOString().slice(0, 10);
  const messages = ['Staging demo — moon incoming!', 'Staging demo — bear vibes', null, 'Staging demo — trust the chart', null];
  for (let ai = 0; ai < ASSETS.length; ai++) {
    const asset = ASSETS[ai];
    const basePrice = fakePrices[asset][6];
    for (let ui = 0; ui < fakeUsers.length; ui++) {
      const user = fakeUsers[ui];
      const guessPrice = parseFloat((basePrice * (1 + ui * 0.01 - 0.02)).toFixed(2));
      const stake = stakeForUser(ui);
      const submittedAt = new Date(today.getTime() - (2 + ui * 1.5) * 3600000).toISOString();
      const txHash = (user.id === 900001 && ai % 2 === 0)
        ? `staging-demo-tx-${todayDate}-${asset}`
        : null;
      await pool.query(
        `INSERT INTO guesses (user_id, username, round_date, asset, price_guess, stake_tokens, message, submitted_at, tx_hash, tx_from, tx_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (user_id, round_date, asset) DO NOTHING`,
        [user.id, user.username, todayDate, asset, guessPrice, stake, messages[ui], submittedAt, txHash, txHash ? `ut1-${user.username}` : null, txHash ? submittedAt : null]
      );
    }
  }

  // Reinforce today's combined pot well past the 100-token reward-boost
  // milestone so the home-screen badge (and its dapp test) is exercisable in
  // staging. With varied stakes the 5 fakeUsers already contribute 42 tokens
  // PER asset across 12 assets; these 8 extra obviously-fake demo users add
  // more, keeping the combined pot comfortably over the milestone.
  const boostUsers = [];
  for (let i = 1; i <= 8; i++) {
    boostUsers.push({ id: 900100 + i, username: `staging-demo-${String(i).padStart(2, '0')}` });
  }
  for (let ai = 0; ai < ASSETS.length; ai++) {
    const asset = ASSETS[ai];
    const basePrice = fakePrices[asset][6];
    for (let ui = 0; ui < boostUsers.length; ui++) {
      const user = boostUsers[ui];
      const guessPrice = parseFloat((basePrice * (1 + ui * 0.008 - 0.03)).toFixed(2));
      const stake = stakeForUser(ui);
      const submittedAt = new Date(today.getTime() - (1 + ui * 0.75) * 3600000).toISOString();
      await pool.query(
        `INSERT INTO guesses (user_id, username, round_date, asset, price_guess, stake_tokens, message, submitted_at, tx_hash, tx_from, tx_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $8)
         ON CONFLICT (user_id, round_date, asset) DO NOTHING`,
        [user.id, user.username, todayDate, asset, guessPrice, stake, 'Staging demo — boosting the pot', submittedAt, `staging-tx-${todayDate}-${asset}-${user.id}`, `ut1-${user.username}`]
      );
    }
  }
}

async function start() {
  // Bind port first so the healthcheck can respond immediately, even before DB is ready
  await new Promise((resolve, reject) => {
    const s = app.listen(port, () => { console.log(`Listening on :${port}`); resolve(); });
    s.on('error', reject);
  });

  // DB may not be immediately reachable (cold start); retry for up to 10s
  let dbReady = false;
  for (let i = 0; i < 10; i++) {
    try { await pool.query('SELECT 1'); dbReady = true; break; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!dbReady) { console.error('DB not reachable after retries — schema/seed skipped'); return; }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS guesses (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        username VARCHAR(255) NOT NULL,
        round_date DATE NOT NULL,
        asset VARCHAR(10) NOT NULL,
        price_guess NUMERIC(20,2) NOT NULL,
        message VARCHAR(140),
        tx_hash TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, round_date, asset)
      )
    `);
    await pool.query(`ALTER TABLE guesses ADD COLUMN IF NOT EXISTS tx_hash TEXT`);
    await pool.query(`ALTER TABLE guesses ADD COLUMN IF NOT EXISTS tx_from TEXT`);
    await pool.query(`ALTER TABLE guesses ADD COLUMN IF NOT EXISTS tx_confirmed_at TIMESTAMPTZ`);
    // Variable stake amount per guess. Default 1 keeps existing rows equal to
    // their old implicit 1-token cost, so historical pots stay correct.
    await pool.query(`ALTER TABLE guesses ADD COLUMN IF NOT EXISTS stake_tokens NUMERIC(20,8) NOT NULL DEFAULT 1`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS guesses_tx_hash_uq ON guesses (tx_hash) WHERE tx_hash IS NOT NULL`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS results (
        id SERIAL PRIMARY KEY,
        round_date DATE NOT NULL,
        asset VARCHAR(10) NOT NULL,
        close_price NUMERIC(20,8) NOT NULL,
        pot_total INTEGER NOT NULL,
        processed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (round_date, asset)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        user_id INTEGER PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        display_name VARCHAR(40),
        bio VARCHAR(280),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payouts (
        id SERIAL PRIMARY KEY,
        round_date DATE NOT NULL,
        asset VARCHAR(10) NOT NULL,
        user_id INTEGER NOT NULL,
        username VARCHAR(255) NOT NULL,
        place SMALLINT NOT NULL,
        price_guess NUMERIC(20,2) NOT NULL,
        prize_tokens NUMERIC(10,4) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (round_date, asset, user_id)
      )
    `);

    // Widen pot/prize columns to hold real summed-stake pots (was a head-count).
    // Guard each ALTER TYPE behind an information_schema check so it runs ONCE,
    // not as a per-boot ACCESS EXCLUSIVE table rewrite. int→numeric is lossless
    // (old counts equal old token totals, since each old guess was 1 token).
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'results' AND column_name = 'pot_total' AND data_type = 'integer'
        ) THEN
          ALTER TABLE results ALTER COLUMN pot_total TYPE NUMERIC(20,8);
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'payouts' AND column_name = 'prize_tokens'
            AND (numeric_precision IS DISTINCT FROM 20 OR numeric_scale IS DISTINCT FROM 8)
        ) THEN
          ALTER TABLE payouts ALTER COLUMN prize_tokens TYPE NUMERIC(20,8);
        END IF;
      END $$;
    `);
  } catch (err) {
    console.error('Schema init error:', err.message);
    return;
  }

  if (!process.env.ADMIN_KEY) {
    console.warn('WARNING: ADMIN_KEY is not set — POST /api/admin/daily-results will always return 403');
  }

  seedStaging().catch(err => console.error('Seed error (non-fatal):', err.message));
}

start().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
