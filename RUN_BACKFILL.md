> **HISTORICAL — do not follow.** This run-book drove `npm run job:daily`, which
> wrote `spread.symbol_day`, `spread.job_run` and `spread.symbol`. 011 made
> `symbol_day` a view over the scraper's table and 015 dropped the other two, so
> every command below fails on the first statement. The scripts are removed.
> What replaced them: `npm run stats:daily` (README, "Who computes what").

# Backfill 9–13 August

**Run these in order.** The sequence guard enforces it, but the order below is
what it expects.

```bash
npm install
cp .env.example .env          # set DATABASE_URL
npm run migrate               # 6 files, idempotent
npm run calendar              # populates spread.trading_day from real quotes
```

Then the backfill. **One command — it walks the sessions oldest-first and stops
if any day fails**, because a broken chain gives every later day the wrong
previous session.

```bash
npm run job:daily -- --from 2026-08-09 --to 2026-08-13
```

## What to expect

| Day | Expected |
|-----|----------|
| 9 Aug | `OK`. Its previous session is 6 Aug, already in the migrated data |
| 10 Aug | `OK` — resolves against 9 Aug, not 6 Aug |
| 11 Aug | `OK` |
| 12 Aug | `OK` |
| **13 Aug** | **`PARTIAL` if run before 13:25 Kuwait.** That is correct — it refuses to store a partial session as though it were complete |

If 13 August needs to run before the close, `--force` overrides, but the row is
then a partial session wearing a complete row's clothes.

## Then send section 6

```sql
-- Gate 9 · days_active_5d on the CORRECT window
--
-- It has been reading a window that ended 6 August. This is what it looks like
-- on the real one, and nothing should be built on Gate 9 until this is seen.
SELECT days_active_5d, count(*) AS symbols,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
  FROM spread.symbol_day
 WHERE trading_day = '2026-08-13' AND capture_quality <> 'MISSING'
 GROUP BY days_active_5d
 ORDER BY days_active_5d;

-- And the window it actually used, so the answer can be checked
SELECT trading_day FROM spread.trading_day
 WHERE is_session AND trading_day < '2026-08-13'
 ORDER BY trading_day DESC LIMIT 5;

-- Spot-check one symbol against its own history
SELECT trading_day, price_moves, close_fils, prev_close_fils, change_1d_fils
  FROM spread.symbol_day
 WHERE symbol = 'MADAR' AND trading_day >= '2026-08-04'
 ORDER BY trading_day;
```

**The third query is the one that proves the fix.** `prev_close_fils` on 10
August must equal `close_fils` on 9 August. If it equals 6 August's, the
sequence guard was bypassed.

---

## If the migration fails

**`relation "public.stock_quotes" does not exist`** and two files start `002_`:

```bash
rm src/db/migrations/002_source_views.sql
npm run migrate
```

A new package extracted over an old one leaves the renamed file beside the one
it replaced, and both run. The runner now refuses on a duplicate number rather
than applying one and failing the other.

**Cleanest fix generally:** extract into an empty directory rather than over the
previous one.

## On a NEW database

`002` creates `spread.quote`, `spread.depth` and `spread.broker_order_snapshot`
because `public.stock_quotes` is not there.

**Nothing will run until the scrapers write to them.** In order:

```bash
npm run migrate               # creates the source tables
# -> repoint the scrapers at spread.quote and spread.depth
npm run calendar              # finds nothing until quotes exist
npm run job:daily -- --from 2026-08-09 --to 2026-08-13
```

**Or copy the existing data across** — the tables are column-compatible:

```sql
-- from the old database
\copy (SELECT symbol, market, session, last_price, last_qty, bid, bid_qty,
              offer, offer_qty, trades, volume, created_at
         FROM public.stock_quotes) TO 'quotes.csv' CSV HEADER;

-- into the new one
\copy spread.quote (symbol, market, session, last_price, last_qty, bid, bid_qty,
                    offer, offer_qty, trades, volume, created_at)
      FROM 'quotes.csv' CSV HEADER;
```

**And `spread.symbol` must be populated before the backfill**, or the `missing`
step writes no rows and a scraper failure stays invisible:

```sql
INSERT INTO spread.symbol (symbol, market)
SELECT DISTINCT symbol, COALESCE(market, 'MAIN') FROM spread.quote
ON CONFLICT (symbol) DO NOTHING;
```
