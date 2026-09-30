// lib/settlement.js — shared round-settlement helpers used by BOTH the live
// cron (scripts/daily-results.js) and the admin endpoint (server.js). Keeping
// the close-date math, the CoinGecko close-price fetch, and the payout split in
// one place guarantees the two settlement paths stay in lock-step.

// Map a round_date ("YYYY-MM-DD") to its CoinGecko close-date string
// ("DD-MM-YYYY"). A round identified by date D is open during day D (UTC) and
// CLOSES at 00:00:00 UTC the following day — so the closing price is the
// CoinGecko daily snapshot for round_date + 1 day.
function closeDateForRound(roundDate) {
  const [y, m, d] = String(roundDate).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = dt.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// Is the given CoinGecko date string ("DD-MM-YYYY") the current UTC date?
function isCgDateToday(cgDate) {
  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  return cgDate === `${dd}-${mm}-${yyyy}`;
}

// Fetch the CLOSING price for an asset's round.
//
// Primary source is CoinGecko's date-granular /history endpoint for the round's
// close date (the 00:00-UTC snapshot of the day after round_date). When settling
// the round that just closed (the cron runs ~00:05 UTC), that snapshot may not be
// published yet — only in THAT case (close date == today UTC) do we fall back to
// the current spot price from /simple/price, which is within minutes of the true
// close. For any past round the snapshot must exist, so a miss there is a real
// error and we never substitute today's spot (which would be wildly wrong for an
// old backfill).
//
// Returns a Number price, or null when no price is available (treated by callers
// as the existing "no price data" skip — the round is left unsettled and retried).
// Throws on transport/HTTP errors so callers surface them and leave the round
// unsettled rather than scoring it against a wrong price.
async function fetchClosePrice(cgId, roundDate, opts = {}) {
  const apiKey = opts.apiKey != null ? opts.apiKey : process.env.COINGECKO_API_KEY;
  const fetchImpl = opts.fetch || fetch;
  const log = opts.log || (() => {});
  const cgDate = closeDateForRound(roundDate);
  const today = isCgDateToday(cgDate);

  // Primary: the round's closing snapshot.
  let historyPrice = null;
  try {
    let url = `https://api.coingecko.com/api/v3/coins/${cgId}/history?date=${cgDate}&localization=false`;
    if (apiKey) url += `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? ': ' + body.slice(0, 120) : ''}`);
    }
    const data = await res.json();
    historyPrice = data?.market_data?.current_price?.usd ?? null;
  } catch (e) {
    // For a past round the snapshot must exist — surface the error so the round
    // is left unsettled and retried, never silently scored against today's spot.
    if (!today) throw e;
    log(`history fetch failed (${e.message}); trying current spot for just-closed round`);
  }
  if (historyPrice) return historyPrice;

  // The close snapshot isn't published yet. Only legitimate for the just-closed
  // round (close date == today UTC); for a past round, do not substitute spot.
  if (!today) return null;

  log(`close snapshot ${cgDate} not published yet — using current spot price`);
  let spotUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cgId)}&vs_currencies=usd`;
  if (apiKey) spotUrl += `&x_cg_demo_api_key=${encodeURIComponent(apiKey)}`;
  const spotRes = await fetchImpl(spotUrl, { signal: AbortSignal.timeout(5000) });
  if (!spotRes.ok) throw new Error(`HTTP ${spotRes.status}`);
  const spotData = await spotRes.json();
  return spotData?.[cgId]?.usd ?? null;
}

// Split a pot across the closest guesses. sortedGuesses must already be sorted
// ascending by `distance` (|guess - close|). Ties (equal distance) share the
// combined prize for the tiers they span. Single guesser takes 95% of the pot.
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

module.exports = { closeDateForRound, isCgDateToday, fetchClosePrice, calculatePayouts };
