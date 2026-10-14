// lib/streaks.js — pure streak math for GET /api/streaks (server.js). A "win"
// is a winning guess: place 1 in payouts (the closest guess for that token).
// Keeping the streak rules here, with no DB access, keeps them unit-testable
// in isolation — the caller passes settled guess rows and the latest settled
// round date.

// Two independent streaks:
//   daily    — consecutive UTC calendar days with at least one win, counting
//              back from the latest settled round. Today's still-open round is
//              never settled, so it can't break the run; the caller simply
//              passes the latest SETTLED date.
//   in_a_row — the current trailing run of consecutive winning guesses across
//              all settled guesses, in order (round_date, then submitted_at),
//              plus the longest run ever.

// Normalize a round_date (Date object from pg, or 'YYYY-MM-DD' string) to its
// 'YYYY-MM-DD' UTC form — the same conversion /api/daily-closes uses.
function toDateStr(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// UTC-midnight timestamp for a 'YYYY-MM-DD' string, so date arithmetic never
// touches the local timezone.
function dayMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

// rows: iterable of settled-guess rows in streak order, each
// { round_date: Date|'YYYY-MM-DD', won: boolean } (falsy/null won = loss).
// latestSettledDate: Date|'YYYY-MM-DD'|null — most recent round_date with
// results; null when no round has settled yet.
function computeStreaks(rows, latestSettledDate) {
  const winDays = new Set(); // 'YYYY-MM-DD' strings with >= 1 win
  let run = 0;               // current trailing run of winning guesses
  let runBest = 0;           // longest run of winning guesses ever

  for (const row of rows || []) {
    const won = !!(row && row.won);
    if (won) {
      winDays.add(toDateStr(row.round_date));
      run += 1;
      if (run > runBest) runBest = run;
    } else {
      run = 0;
    }
  }

  // Longest run of consecutive UTC calendar days anywhere in the win-day set.
  let dailyBest = 0;
  const sortedDays = [...winDays].map(dayMs).sort((a, b) => a - b);
  let streak = 0;
  for (let i = 0; i < sortedDays.length; i++) {
    streak = i > 0 && sortedDays[i] - sortedDays[i - 1] === 86400000 ? streak + 1 : 1;
    if (streak > dailyBest) dailyBest = streak;
  }

  // Current daily streak: step back day by day from the latest settled round.
  // A latest settled day without a win means the run is broken → 0.
  let dailyCurrent = 0;
  if (latestSettledDate) {
    let cursor = dayMs(toDateStr(latestSettledDate));
    while (winDays.has(new Date(cursor).toISOString().slice(0, 10))) {
      dailyCurrent += 1;
      cursor -= 86400000;
    }
  }

  return {
    daily: { current: dailyCurrent, best: dailyBest },
    in_a_row: { current: run, best: runBest },
  };
}

module.exports = { computeStreaks };
