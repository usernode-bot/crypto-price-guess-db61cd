# Crypto Price Guess — notes for Claude Code

This app runs on **Usernode Social Vibecoding**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://social-vibecoding.usernodelabs.org/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Usernode's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Crypto Price Guess

Members stake tokens predicting a crypto token's daily closing price; the
closest guesses split the pot. Rounds are daily (one per token, UTC),
settle overnight via the CoinGecko close snapshot, and the Board ranks
player accuracy.

## App-specific conventions

- **A week runs Monday 00:00 UTC to Sunday 24:00 UTC.** A round belongs
  to the week of the day it was played (its `round_date`), so Sunday's
  round counts for the week that just ended even though it settles early
  Monday. Week math lives in `lib/weeks.js`; `date_trunc('week', …)`
  (Monday-first) in SQL agrees with it. This is the definition behind
  both the Board's "This Week" period and the Weekly contest view.
- The server runs in UTC and all dates are UTC; the frontend formats
  dates with `timeZone: 'UTC'` so weeks never shift per-member.
- "Now" is read through the platform (`req.now` on the server,
  `x-usernode-now` forwarded by the page's `api()` helper) wherever the
  date decides what shows — never `new Date()` in a new time-dependent
  path.
