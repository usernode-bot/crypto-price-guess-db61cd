const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'TRX', 'HYPE', 'SUI', 'AVAX'];
const COINGECKO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin',
  TRX: 'tron', HYPE: 'hyperliquid', SUI: 'sui', AVAX: 'avalanche-2',
};

let priceCache = { data: null, fetchedAt: 0 };

// /api/admin/daily-results uses x-admin-key instead of JWT.
// In staging, history/leaderboard/prices are public so proposal tests can verify
// dynamic selectors without the test framework needing to inject auth tokens.
const PUBLIC_API_PATHS = new Set([
  '/health',
  '/api/admin/daily-results',
  ...(IS_STAGING ? ['/api/prices', '/api/history', '/api/leaderboard'] : []),
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

app.get('/api/round/current', async (req, res) => {
  try {
    const roundDate = getCurrentRoundDate();
    const { rows: potRows } = await pool.query(
      `SELECT asset, COUNT(*) AS guess_count FROM guesses WHERE round_date = $1 GROUP BY asset`,
      [roundDate]
    );
    const pots = {};
    for (const a of ASSETS) pots[a] = { guess_count: 0, pot_tokens: 0 };
    for (const r of potRows) {
      pots[r.asset] = { guess_count: parseInt(r.guess_count), pot_tokens: parseInt(r.guess_count) };
    }
    const { rows: myGuesses } = await pool.query(
      `SELECT asset, price_guess, message, submitted_at FROM guesses WHERE round_date = $1 AND user_id = $2`,
      [roundDate, req.user.id]
    );
    res.json({ round_date: roundDate, pots, my_guesses: myGuesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/guess', async (req, res) => {
  try {
    const { asset, price_guess, message } = req.body;
    if (!ASSETS.includes(asset)) return res.status(400).json({ error: 'Invalid asset' });
    const pg = parseFloat(price_guess);
    if (isNaN(pg) || pg <= 0) return res.status(400).json({ error: 'Invalid price' });

    const now = new Date();
    const secs = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    if (secs >= 86390) return res.status(400).json({ error: 'Round is closing — try again tomorrow' });

    const roundDate = getCurrentRoundDate();
    const { rows } = await pool.query(`
      INSERT INTO guesses (user_id, username, round_date, asset, price_guess, message)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, round_date, asset) DO UPDATE
        SET price_guess = EXCLUDED.price_guess, message = EXCLUDED.message, submitted_at = NOW()
      RETURNING *
    `, [req.user.id, req.user.username, roundDate, asset, pg.toFixed(2), message?.slice(0, 140) || null]);
    res.json({ ok: true, guess: rows[0] });
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

    const { rows: payouts } = await pool.query(
      `SELECT * FROM payouts WHERE round_date = $1 ORDER BY asset, place`, [roundDate]
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
    const where = cutoffDate ? 'WHERE round_date >= $1' : '';

    const { rows } = await pool.query(`
      SELECT username,
             ROUND(SUM(prize_tokens)::numeric, 2) AS total_won,
             COUNT(*) FILTER (WHERE place = 1) AS wins,
             COUNT(DISTINCT round_date) AS rounds_with_prizes
      FROM payouts ${where}
      GROUP BY username ORDER BY total_won DESC LIMIT 50
    `, params);

    let myStats = null;
    if (req.user) {
      const myWhere = cutoffDate ? 'WHERE username = $1 AND round_date >= $2' : 'WHERE username = $1';
      const myParams = cutoffDate ? [req.user.username, cutoffDate] : [req.user.username];
      const { rows: myStatRows } = await pool.query(`
        SELECT ROUND(COALESCE(SUM(prize_tokens), 0)::numeric, 2) AS total_won,
               COUNT(*) FILTER (WHERE place = 1) AS wins,
               COUNT(DISTINCT round_date) AS rounds_with_prizes
        FROM payouts ${myWhere}
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
      `SELECT asset, price_guess, message, submitted_at FROM guesses WHERE round_date = $1 AND user_id = $2`,
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
    const results = await processDailyResults(pool, targetDate);
    res.json({ ok: true, processed: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function calculatePayouts(sortedGuesses, potTotal) {
  const n = sortedGuesses.length;
  if (n === 0) return [];

  // Single guesser gets 95% (all prize tiers combined)
  if (n === 1) {
    return [{
      ...sortedGuesses[0],
      place: 1,
      prize_tokens: Math.floor(potTotal * 0.95 * 10000) / 10000,
    }];
  }

  const PRIZES = [0.70, 0.20, 0.05];
  const payouts = [];

  // Group by equal distance (ties)
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

  let placeStart = 0; // 0-indexed
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

async function processDailyResults(dbPool, roundDate) {
  const processed = [];
  for (const asset of ASSETS) {
    const { rows: ex } = await dbPool.query(
      'SELECT id FROM results WHERE round_date = $1 AND asset = $2', [roundDate, asset]
    );
    if (ex.length) { processed.push({ asset, status: 'already processed' }); continue; }

    const { rows: guesses } = await dbPool.query(
      `SELECT user_id, username, price_guess::float FROM guesses WHERE round_date = $1 AND asset = $2`,
      [roundDate, asset]
    );
    if (!guesses.length) { processed.push({ asset, status: 'no guesses' }); continue; }

    const cgId = COINGECKO_IDS[asset];
    const [y, m, d] = roundDate.split('-');
    const cgDate = `${d}-${m}-${y}`;
    let closePrice;
    try {
      const apiKey = process.env.COINGECKO_API_KEY;
      let url = `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${cgDate}&localization=false`;
      if (apiKey) url += `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      closePrice = data?.market_data?.current_price?.usd;
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
    const payoutRows = calculatePayouts(withDist, guesses.length);

    await dbPool.query(
      `INSERT INTO results (round_date, asset, close_price, pot_total) VALUES ($1, $2, $3, $4)
       ON CONFLICT (round_date, asset) DO NOTHING`,
      [roundDate, asset, closePrice, guesses.length]
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
    processed.push({ asset, status: 'ok', close_price: closePrice, pot: guesses.length });
  }
  return processed;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  // In staging the shell is public so proposal tests can verify CSS selectors.
  // In production, unauthenticated direct visits get a friendly 401 redirect page.
  if (!req.user && !IS_STAGING) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
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
  };
  const fakeUsers = [
    { id: 900001, username: 'staging-alice' },
    { id: 900002, username: 'staging-bob' },
    { id: 900003, username: 'staging-carol' },
    { id: 900004, username: 'staging-dave' },
    { id: 900005, username: 'staging-eve' },
  ];

  const today = new Date();

  // Seed 7 completed past rounds
  for (let daysAgo = 7; daysAgo >= 1; daysAgo--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - daysAgo);
    const roundDate = d.toISOString().slice(0, 10);
    const priceIdx = 7 - daysAgo;

    for (let ai = 0; ai < ASSETS.length; ai++) {
      const asset = ASSETS[ai];
      const closePrice = fakePrices[asset][priceIdx];
      const potTotal = 5;

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

      for (let pi = 0; pi < 5; pi++) {
        const w = fakeUsers[(offset + pi) % 5];
        const mult = 1 + (pi * 0.003 - 0.003);
        const guessPrice = parseFloat((closePrice * mult).toFixed(2));
        const submittedAt = roundDate + 'T12:00:00.000Z';
        await pool.query(
          `INSERT INTO guesses (user_id, username, round_date, asset, price_guess, submitted_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, round_date, asset) DO NOTHING`,
          [w.id, w.username, roundDate, asset, guessPrice, submittedAt]
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
      const submittedAt = new Date(today.getTime() - (2 + ui * 1.5) * 3600000).toISOString();
      await pool.query(
        `INSERT INTO guesses (user_id, username, round_date, asset, price_guess, message, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, round_date, asset) DO NOTHING`,
        [user.id, user.username, todayDate, asset, guessPrice, messages[ui], submittedAt]
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
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, round_date, asset)
      )
    `);
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
