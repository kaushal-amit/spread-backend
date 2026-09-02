# SPREAD backend

Passive market-making engine for Boursa Kuwait. Post at the bid, collect the
offer, never cross the spread.

```bash
npm install
cp .env.example .env        # DATABASE_URL, ANTHROPIC_API_KEY
npm run migrate             # 6 files, idempotent, advisory-locked
npm run calendar            # spread.trading_day from real quotes
npm run job:daily -- --from 2026-08-09 --to 2026-08-13
npm start                   # :4000
npm run verify              # rule lint + 110 checks
```

## Where things live

```
src/config/spread.config.js   every threshold, with its evidence STRENGTH
src/lib/commission.js         THE ONLY module that computes a fee
src/lib/pricing.js            THE ONLY module that returns a price or a size
src/lib/funnel.js             nine gates + Gate 10 (warn) — pure, no db
src/lib/orderRules.js         D3 D4 D5 E5 I2 I4 I8 — pure
src/services/screening.js     runs the funnel, returns EVERY symbol
src/services/live.js          fill time, wake-up, alive, cost of waiting
src/services/depth.js         CR-34 — informs, gates nothing
src/services/alerts.js        CR-32 — the 3.3-minute window
src/services/ai/              boundary, frozen registry, Claude
src/mcp/server.js             read-only Postgres for Claude Desktop
src/jobs/daily/               the 13:30 job, two guards
```

## The rules the code enforces mechanically

`npm run lint:rules` fails the build on any of these. It runs on every verify,
not once — a second implementation appears LATER, not at the same time.

- Only `commission.js` computes a fee
- Only `pricing.js` rounds to a lot or returns a price
- Nothing writes to `public.*`
- No screening query recomputes a statistic the job already stored

## Two guards on the job

**Session** — refuses to write before 13:25 Kuwait. A partial session stored as
a complete row is worse than no row.

**Sequence** — refuses to compute a day whose previous session is missing.
Otherwise 10 August resolves its previous close against 6 August, which is the
error `spread.prev_session()` exists to prevent.

## What is deliberate and might look wrong

**Gate 10 warns and never blocks.** A stock that fell yesterday is 44% to rise
today. The four bad picks that raised it each failed a gate that already
existed — direction correlated with the real failures rather than causing them.

**CR-34 gates nothing.** 418 snapshots is one symbol on one session. It informs
the alert and the AI until a second symbol confirms. A nine-minute reading of
that same session gave the opposite sign.

**Gate 8 passes on a null.** It is the only blocking gate, so unknown means "no
reason to block". Every other gate treats a null as a failure.

**`bid_kd_p50` is stored and never used for a gate.** The median said 2.0%
postable on the day that stock produced four fills.

## Which database?

`002` detects it. If `public.stock_quotes` exists — the database the scrapers
already write to — the views read it and nothing writes there. If it does not,
the migration creates `spread.quote`, `spread.depth` and
`spread.broker_order_snapshot`, and **the scrapers must be repointed at them**.

Nothing else in the codebase names a source table. Everything reads
`spread.v_quote`, `spread.v_quote_screening` or `spread.v_depth`, so the answer
lives in one migration.

Two places read the RAW table rather than a view, and both deliberately:

- **the session guard** — "did the session finish" means the AUCTION finished,
  and the screening view filters Close-Of-Day out
- **the null-session alarm** — a view selecting `WHERE session = 'Trading'` can
  never return a row whose session is NULL, which is precisely the case that
  went unnoticed for four days

## Status

110 checks. The SQL in `jobs/daily/steps` has **never executed** — pg-mem cannot
run `percentile_cont`, `AT TIME ZONE`, window functions or `LATERAL`. It is
written and syntax-checked, not verified.

`RUN_BACKFILL.md` has the commands and the queries to send back.
