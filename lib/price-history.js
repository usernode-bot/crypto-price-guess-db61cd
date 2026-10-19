// lib/price-history.js — pure windowing for GET /api/price-history (server.js).
// CoinGecko's days=1 market_chart response is ~288 five-minute points; the
// chart needs the whole 24h window but not all of them, so this trims to the
// window and downsamples lightly. Pure, no I/O, unit-tested like lib/streaks.js.

// Keep points from the last `windowMs`, map to { t, p }, and downsample to at
// most maxPoints by taking every stride-th point (starting at index 0). The
// final point is always included — appended if the stride skipped it, so the
// chart's "current price" dot and change_pct stay the true last values.
function daySeries(raw, now, maxPoints = 96, windowMs = 24 * 60 * 60 * 1000) {
  if (!Array.isArray(raw)) return [];
  const cutoff = now - windowMs;
  const mapped = [];
  for (const point of raw) {
    if (Array.isArray(point) && point[0] >= cutoff) mapped.push({ t: point[0], p: point[1] });
  }
  if (mapped.length > maxPoints) {
    const stride = Math.ceil(mapped.length / maxPoints);
    const downsampled = [];
    for (let i = 0; i < mapped.length; i += stride) downsampled.push(mapped[i]);
    const last = mapped[mapped.length - 1];
    if (downsampled[downsampled.length - 1] !== last) downsampled.push(last);
    return downsampled;
  }
  return mapped;
}

module.exports = { daySeries };