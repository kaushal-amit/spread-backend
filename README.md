# SPREAD backend

Passive market-making engine for Boursa Kuwait. Post at the bid, collect the
offer, never cross the spread.

```bash
npm install
cp .env.example .env        # DATABASE_URL, ANTHROPIC_API_KEY
npm run migrate             # 17 files, idempotent, advisory-locked
npm run stats:daily         # spread.symbol_day_stats for today — the gate columns
npm run import:fills        # dry run: the broker's fills as the ledger would book them
npm run import:fills -- --apply
npm start                   # :4000
npm run verify              # rule lint + the suite (DB suites need DATABASE_URL=…/kse_test)
```

## Who computes what

One sentence, because its absence produced two analytics layers:

> **The scraper owns `public.symbol_day`** (price, volume, tape and flow
> statistics per session). **The backend owns `spread.symbol_day_stats`** (the
> queue and exit statistics the gates need — postable %, exitable %, bid p25,
> 2-fil gap %, 5-session volume ratio, days active, change in fils), computed
> by `npm run stats:daily` from the minute quotes. `spread.symbol_day` is the
> VIEW that joins the two under the names `lib/funnel.js` reads, prefers the
> scraper's value where it has one, and says which side answered in
> `gate_stats_source`.

The bridge exists because `public.symbol_day` declares `pct_postable`,
`pct_exitable`, `vol_ratio_5d`, `bid_p25` and `exitable_best_hour` and leaves
every one NULL (4,465 rows, verified 2 September). The same SQL is in
`scripts/scraper-symbol-day-stats.sql` for the scraper to adopt; when it does,
the bridge goes quiet on its own and `spread.symbol_day_stats` can be dropped.

Two columns are NOT aliased, deliberately: `chg_1d`/`chg_5d` are **percent** and
Gate 10 is in **fils**; `days_active` is a 20-session window and Gate 9 is 5.

### Every `spread.*` table and its writer (6.6)

| table | written by |
|-------|-----------|
| `symbol_day_stats` | `npm run stats:daily` (`jobs/stats` · the gate-column bridge) |
| `symbol_profile` | the retired daily job's `profile` step (R-17: to be ported into `stats:daily` so screening's LEFT JOIN is non-NULL and the wake-up scan has a median; the step depends on hour-of-day trade counts the retired `hours` step produced, so the port needs that aggregation rewritten from the minute quotes — pending) |
| `order_leg`, `claim`, `cash_movement` | the trading routes (`api/trading_routes.js`) |
| `event_log` | the claim lifecycle (`CLAIM_PLACED`/`CLAIM_RELEASED`/`STOP_BREACHED`) |
| `depth_signal` | `services/depth.record` |
| `halt_event` | the halt-resume detector (`services/halts`) |
| `data_alarm`, `trading_day` | `npm run calendar` (`db/seed-calendar.js`) and migration 019 |
| `job_run` | the daily/stats jobs |
| `gate_config`, `gate_config_version` | `PUT /gates` / `POST /budget` (`services/gateStore`) |
| `ai_note`, `ai_chat`, `ai_query_log` | `services/ai/claude.ask` |
| `override_log` | `POST /stocks/:symbol/override` |
| `entry_alert` | the entry-window scanner (`services/alerts.fire`) |
| `kb_threshold`, `kb_rule`, `kb_phrase`, `halt_skip` | migration seeds (edited in-table, not in source) |
| `broker_order_snapshot` | `scripts/copy-quotes.sql` (a sandbox helper, not the live path) |
| `ai_memory` | the AI memory writes (`POST /ai/memory`, Group 9) |

`spread.symbol_event` was dropped (6.6 / R-34 — no writer, no reader), and
`scripts/import-depth.sql` was deleted with it.

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
src/api/positions.js          ONE definition of "open", by quantity, on (symbol, seq)
src/api/trading_routes.js     the five writes that move a position or cash
src/jobs/stats/               spread.symbol_day_stats — the gate-column bridge
src/jobs/import-fills.js      the broker's fills into the ledger, FIFO, one txn
src/jobs/reconcile-fees.js    the broker's charge over the formula, per leg, one txn
src/jobs/daily/               INERT — see its header; kept for kuwaitDay()
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

**The live tab is polled, not pushed (R-32).** BACKEND_spec §5 describes a
`LISTEN/NOTIFY` push off `public.symbol_minute`. The scraper writes
`symbol_minute`, `signal_log`, `position` and `market_day` in another process
and this backend has no trigger on them; a `NOTIFY` would need one in `public.*`,
which is a write to the scraper's schema and lint-forbidden. So the documented
substitute is a **2-second poll**: the ticker re-reads `symbol_minute` every 2 s
and emits `spread:update`, and **open positions travel inside that
`spread:update` payload** — there is no separate position push. If the scraper
later grows its own `NOTIFY`, the poll can become the fallback.

**Gate 5 reads a blended figure against a 20 % ceiling (R-39).** `tiny_pct_up`
is the up-move-only tape figure. The board and the scraper hand-off use the
scraper's **blended** `tiny_pct` (up and down together) for Gate 5, tested
against the same 20 % (`tiny_pct_max`). The blended figure runs at roughly half
the up-only one, so 20 % on it is the stricter reading — deliberately left at 20
until a live sample says otherwise. `tiny_pct_up` remains **display-only**: it is
shown on the card, never gated on.

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

## Tests

`npm test` is green on a clean checkout: the pure suites run, the six DB suites
SKIP without `DATABASE_URL`. With it set they REFUSE unless the database name
ends in `_test` — they write and delete rows, and `test/sizing.test.js` once
deleted every leg for the day against the trading database. Only
`test/fixtures.js` may write `public.*`, and the lint enforces both.

```bash
createdb kse_test && pg_dump -s kse | psql kse_test     # schema, then:
DATABASE_URL=postgres://…/kse_test npm run migrate
DATABASE_URL=postgres://…/kse_test npm test
```

`test/gates-contract.test.js` is the check that was missing: every column the
funnel reads is a column the view exposes, parsed from both files, and a
live-shaped row passes gates 5-9 with values.

The suite runs green on a **schema-only** `kse_test` (`pg_dump -s`): every DB
suite seeds what it reads through `test/fixtures.js` — test symbols
(`SZTEST*`, `FEE*`, `RVTEST*`) and a fixture day (2001-01-08) — and removes it
after. Step 3 added, each closing one runbook item: `stranded` (E5 from
`order_leg`), `params` (every parameter, table-driven), `dayroll`
(`spread.kuwait_day()` = `kuwaitDay()`), `candles` (`date_bin`, Σ volume =
day volume), `lifecycle-db` (claims, `exit_venue`, no placeholders),
`injection` (`<untrusted>` and the boundary), `ops` (logger, health, SIGTERM).

**Operations.** `GET /api/health` (no token) reports `quoteAgeSec`,
`latestQuoteAt`, `latestStatsDay` and the session phase, and answers **503
`stale`** when the session is open and no quote has landed for five minutes —
the scraper is down and every number on the board is old. Logs are one JSON
line per event (`src/lib/log.js`; `LOG_LEVEL`, `LOG_FORMAT`). `SIGTERM` stops
the timers, closes the socket and HTTP servers, drains the pool and exits 0
within five seconds.

## Until the scraper fills the gate columns

`public.symbol_day` leaves `pct_postable`, `pct_exitable`, `vol_ratio_5d`,
`bid_p25`, `block_ratio` and `exitable_best_hour` NULL, and has no `tiny_pct`
(blended) or `gap_pct` at all; the backend bridge (`spread.symbol_day_stats`,
`npm run stats:daily`) computes them from the minute quotes and the 016/018
view prefers the scraper's value whenever it is present. The hand-off request
is in `docs/SCRAPER_HANDOFF.md`. Until it lands, the bridge must run after
every session:

```cron
# Kuwait is UTC+3, no DST: 13:45 Kuwait = 10:45 UTC, Sunday–Thursday.
# stats:daily builds the gate-column bridge, then reconcile:fees --apply corrects
# the day's fills against the broker's own charge (R-31). `npm run stats:daily`
# runs both in one process — the reconcile step is inside runDaily().
45 10 * * 0-4  cd /srv/spread-backend && /usr/bin/npm run --silent stats:daily >> /var/log/spread/stats-daily.log 2>&1
# A5 · m45 (the 09:00–09:45 range-over-cost) is FROZEN at 09:45 Kuwait = 06:45
# UTC. Written once; a re-run only fills a day with no row. Backfill a past day
# with `npm run m45 2026-07-15` (quotes exist back to July).
45 06 * * 0-4  cd /srv/spread-backend && /usr/bin/npm run --silent m45 >> /var/log/spread/m45.log 2>&1
```

`stats:daily` runs `stats:daily` then `reconcile:fees --apply` for the same day,
in that order, so a filled leg carries `fee_source = BROKER` (the broker's charge)
rather than the formula's estimate before the next session opens.

Done when `SELECT gate_stats_source, count(*) FROM spread.symbol_day WHERE
trading_date = current_date GROUP BY 1` returns only `SCRAPER`; migration 020
then drops the bridge table and this job.

## Production

The server refuses to start with `NODE_ENV=production` unless
`SPREAD_API_TOKEN` is set and `CORS_ORIGIN` is one exact origin — checked in
`src/index.js` before a database connection is opened, so a missing token is
the first line of output, not something after a connection error. The full
key list is in `.env.example` under PRODUCTION; the MCP server's read-only role
is created once with `scripts/create-ai-ro-role.sql`.

**Reverse proxy.** The token is checked on every `/api` route except
`/api/health`, and on the socket handshake. The proxy must:

- forward `Authorization` (and `X-Spread-Token`) unchanged — strip either and
  every call is 401;
- set `X-Forwarded-For`. Its presence switches the loopback exemption OFF:
  a request that arrives through the proxy is remote by definition, even from
  the host itself, and the header is never trusted as proof of origin. So with
  a proxy in front, the token is required from the host too — `curl
  localhost:4000/api/account` still works without one only when it bypasses
  the proxy;
- proxy `/socket.io/` with the WebSocket upgrade (`Upgrade` / `Connection`
  headers) or the client falls back to long-polling and the ticker stalls.

nginx, minimal:

```nginx
location /api/       { proxy_pass http://127.0.0.1:4000;
                       proxy_set_header Authorization $http_authorization;
                       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
location /socket.io/ { proxy_pass http://127.0.0.1:4000;
                       proxy_http_version 1.1;
                       proxy_set_header Upgrade $http_upgrade;
                       proxy_set_header Connection "upgrade";
                       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }
```

**The bundle is not public.** The front end is a static build that carries
`VITE_SPREAD_API_TOKEN` — the same token — in its JavaScript. Anyone who can
download the bundle has the token, so it is served only behind the operator's
own login or VPN, never on an open hostname. `/api/health` is the one open
path and returns nothing about the account.

Proof, against a running server (`test/auth.test.js` runs the same four when
`DATABASE_URL` points at a `_test` database):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 203.0.113.9' $HOST/api/account   # 401
curl -s -H "Authorization: Bearer $SPREAD_API_TOKEN" $HOST/api/account                           # JSON
curl -s $HOST/api/health                                                                          # 200, no token
node -e "require('socket.io-client')('$HOST',{auth:{token:'$SPREAD_API_TOKEN'}}).on('connect',()=>{console.log('ok');process.exit()})"
NODE_ENV=production SPREAD_API_TOKEN= node src/index.js; echo exit=$?                             # 1, names the key
```

## Status

The board returned zero rows from the day 011 was applied until 016 — every
gate but Gate 8 read a column the view did not have. `scripts/board-offline.js`
runs the real pipeline over rows captured from kse on 2 September.

`RUN_BACKFILL.md` and `FIRST_RUN.md` describe the retired daily job and are
kept as history only.
