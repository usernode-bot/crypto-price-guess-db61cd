// lib/weeks.js — pure week math for the Weekly leaderboard (server.js). A week
// runs Monday 00:00 UTC to Sunday 24:00 UTC; a round belongs to the week of the
// day it was played (its round_date), so Sunday's round counts for the week that
// just ended even though it settles early Monday. Keeping the rules here, with
// no DB access, keeps them unit-testable in isolation — the same pattern as
// lib/streaks.js.

// Normalize a date (Date object, or 'YYYY-MM-DD' string as pg returns it) to a
// UTC-midnight timestamp, so date arithmetic never touches the local timezone.
function dayMs(d) {
  if (d instanceof Date) {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  const [y, m, dd] = String(d).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
}

// 'YYYY-MM-DD' UTC form of a UTC-midnight timestamp — the same conversion
// /api/daily-closes and lib/streaks use.
function toDateStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// The week's Monday ('YYYY-MM-DD') for any date in it. getUTCDay() is 0 for
// Sunday … 6 for Saturday; ((day + 6) % 7) shifts to Monday-first — the same
// expression the "This Week" period filter uses in server.js.
function weekStartFor(date) {
  const ms = dayMs(date);
  const d = new Date(ms);
  return toDateStr(ms - ((d.getUTCDay() + 6) % 7) * 86400000);
}

// The week's last day (Sunday, 'YYYY-MM-DD') given its Monday start.
function weekEndFor(start) {
  return toDateStr(dayMs(start) + 6 * 86400000);
}

// Is the week that starts on `start` fully over at `now`? True once `now` has
// reached the NEXT Monday 00:00 UTC. The just-ended week only becomes
// "completed" for display once its last rounds settle (the nightly run at
// ~00:05 UTC Monday); callers decide what to do with a partial week.
function isCompletedWeek(start, now) {
  return dayMs(now) >= dayMs(start) + 7 * 86400000;
}

// 'Week of Oct 12' — the champion banner's title for the week starting `start`.
function weekLabel(start) {
  const dtf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return 'Week of ' + dtf.format(new Date(dayMs(start)));
}

// 'Oct 12' — the week-picker chip label for the week starting `start`.
function chipLabel(start) {
  const dtf = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return dtf.format(new Date(dayMs(start)));
}

module.exports = { dayMs, toDateStr, weekStartFor, weekEndFor, isCompletedWeek, weekLabel, chipLabel };
