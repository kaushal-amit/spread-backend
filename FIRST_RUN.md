> **HISTORICAL — do not follow.** This run-book drove `npm run job:daily`, which
> wrote `spread.symbol_day`, `spread.job_run` and `spread.symbol`. 011 made
> `symbol_day` a view over the scraper's table and 015 dropped the other two, so
> every command below fails on the first statement. The scripts are removed.
> What replaced them: `npm run stats:daily` (README, "Who computes what").

# First run — a new, empty database

```bash
npm install
cp .env.example .env          # DATABASE_URL
npm run migrate
npm run doctor                # <- start here, and after every step
```

`doctor` checks each prerequisite in dependency order and names **one** next
step. Everything after the first failure fails for the same reason, and printing
all of them is noise.

On a new database it will say:

```
  ✓  schema             18 tables in spread
  ✓  quote source       spread.quote — this database owns it
  ✗  quotes             empty

  Next: spread.quote is empty. Either repoint the scrapers at it, or copy the
        existing data across. Everything downstream needs this first.
```

## Getting the quotes in

**Either** repoint the scrapers at `spread.quote` and `spread.depth` —
column-compatible with `stock_quotes` and `stock_depth`.

**Or** copy the existing data:

```sql
-- old database
\copy (SELECT symbol, market, session, last_price, last_qty, bid, bid_qty,
              offer, offer_qty, trades, volume, created_at
         FROM public.stock_quotes) TO 'quotes.csv' CSV HEADER;

\copy (SELECT symbol, level, bid, bid_qty, offer, offer_qty, created_at
         FROM public.stock_depth) TO 'depth.csv' CSV HEADER;

-- new database
\copy spread.quote (symbol, market, session, last_price, last_qty, bid, bid_qty,
                    offer, offer_qty, trades, volume, created_at)
      FROM 'quotes.csv' CSV HEADER;

\copy spread.depth (symbol, level, bid, bid_qty, offer, offer_qty, created_at)
      FROM 'depth.csv' CSV HEADER;
```

## Two things that went wrong the first time

**`relation "spread.quote" does not exist`** — `\copy` runs client-side, so the
export and the import are separate connections. The error means the import ran
against the database the export came from. Connect to the new one first:

```sql
\c new-trading
```

**`column "bid" does not exist`** on `stock_depth` — that shape was a guess and
it was wrong. Run `scripts/inspect-depth.sql` against the old database and send
the output; `spread.depth` has to match, because CR-34 reads `bid_qty` and
`offer_qty` and **a column that does not map is a silent NULL, not an error**.
The signal then reads WAIT forever without saying why.

`npm run doctor` now checks for that specifically — it counts rows *with
quantities*, not just rows.

Meanwhile the quotes can go across on their own; depth only affects CR-34.

## `relation "spread.quote" does not exist` after a clean migrate

`002` created the table only inside a branch, and the branch was not taken. The
DO block reported a NOTICE rather than failing, so the migration looked
successful and the table was not there.

**Fixed forward in `007`, which creates the tables unconditionally.** 002 is
left applied and untouched — editing an applied migration reports drift, and
drift is the correct complaint when the database and the repository disagree.

```bash
npm run migrate      # applies 007
npm run doctor
```

If you want to see what the database actually has first:

```bash
psql "$DATABASE_URL" -f scripts/where-is-my-data.sql
```

That lists the tables, which migrations were recorded, and **what the views
actually read** — the last one is what the branch got wrong.

## Depth — `extra data after last expected column`

`\copy` matches by POSITION, not by name. The source has eleven columns and
`spread.depth` has seven, so naming the target columns does not help.

**Use `scripts/import-depth.sql`.** It stages the file into an all-text table
shaped like the source, shows you three rows, and then maps only the four
columns CR-34 actually reads.

Verify before dropping the staging table:

```sql
SELECT count(*) AS rows,
       count(*) FILTER (WHERE bid_qty IS NOT NULL AND offer_qty IS NOT NULL) AS usable
  FROM spread.depth;
```

**If `usable` is 0 the import "succeeded" and CR-34 is dead** — a column that
did not map is a silent NULL and the signal reads WAIT forever without saying
why. `npm run doctor` checks this specifically.

## Same database, so no CSV

`public` and `spread` are both in `trading`. `\copy` was only ever needed when
they lived apart.

```bash
npm run migrate                                   # applies 007 and 008
psql "$DATABASE_URL" -f scripts/copy-quotes.sql   # 768,618 rows
psql "$DATABASE_URL" -f scripts/import-depth.sql  # 52,057 rows
npm run seed:symbols
npm run calendar                                  # re-run: observed days fix the guess
npm run doctor
```

## Two things the real depth data corrected

**A row is not a snapshot.** The scraper writes **ten levels** per capture,
sharing one `scrape_batch_id`. So 52,057 rows are **5,208 book captures**.

`depth.js` was counting rows, which overstates the CR-34 sample **tenfold** — a
symbol with 100 rows has 10 real captures, and would have passed the check that
exists precisely because five observations once inverted the sign. It now counts
`DISTINCT capture_id`.

**`captured_at` is not `created_at`.** The first is when the book looked like
that; the second is when the row was written, ~0.3s later. A signal about the
book uses the first.

## What CR-34 will actually be able to say

Seven symbol-days of twenty-five clear 100 captures:

| Day | Symbol | Captures |
|---|---|---|
| 6 Aug | EMIRATES | 1,238 |
| 6 Aug | TIJARA | 1,219 |
| 6 Aug | EQUIPMENT | 1,217 |
| 13 Aug | TIJARA | 444 |
| 12 Aug | OULAFUEL | 398 |
| 11 Aug | ARABREC | 286 |
| 11 Aug | CATTL | 127 |

**The other eighteen are silent, correctly.** Under the old row-count that
number would have been twenty-two — fifteen of them speaking on a sample that
cannot support a direction.

## The ladder nobody has seen

Ten levels are in this data and no screen has ever shown more than one. A bid of
42,400 at the touch with 10,000 behind it is a different book from one with
500,000 behind it, and only the second survives a seller.

`spread.v_depth_ladder` aggregates it. Nothing reads it yet.

## Run the backfill from the first day that has quotes

The guard is right: 13 August cannot be computed while 12 August is missing.
Run the whole range instead — it walks sessions oldest-first and stops on the
first failure, because a broken chain gives every later day the wrong previous
session.

```bash
npm run job:daily 2026-07-14 2026-08-13
```

23 days of quotes, so this takes a few minutes. Then:

```bash
npm run doctor
```

## Flags npm eats

npm consumes `--force`, `--from` and `--to` as its own options, so they never
reach the script. The observed symptom:

```
npm run job:daily 2026-08-13 --force
npm warn using --force  Recommended protections disabled.
> node src/jobs/daily/index.js 2026-08-13        <- the flag is gone
```

Use positionals, and `--partial` where you meant `--force`:

```bash
npm run job:daily 2026-08-13                one day
npm run job:daily 2026-07-14 2026-08-13     a range, oldest first
npm run job:daily 2026-08-13 --partial      run before 13:25
SPREAD_FORCE=1 npm run job:daily 2026-08-13 works regardless
```

## Then, in order

```bash
npm run seed:symbols          # spread.symbol from what has traded
npm run calendar              # re-run: observed days correct the weekday guess
npm run doctor
npm run job:daily 2026-08-09 2026-08-13
```

**Note the argument form.** `npm run job:daily -- --from X --to Y` does not
work: npm consumes `--from` and `--to` as its own options and the dates arrive
as bare positionals. So positionals are the primary form.

```bash
npm run job:daily 2026-08-13                 one day
npm run job:daily 2026-08-09 2026-08-13      a range, oldest first
npm run job:daily 2026-08-13 --force         run before 13:25
```

## What each message means

**`[calendar] 0 days observed`** — correct on an empty database, and the
calendar is then the Sunday-Thursday rule with **holidays unknown**. A holiday
marked as a session makes "the previous session" wrong by a day for everything
after it. Re-run once quotes are loaded.

**`session=NO_DATA — the scraper did not run`** — correct on a database that has
been running. On a fresh one the truth is that nothing has been loaded, which is
what `doctor` says instead.

**`PARTIAL` on today** — correct if run before 13:25 Kuwait. The session has not
finished and a partial row stored as a complete one is worse than no row.

**`SKIPPED — PREVIOUS_NOT_COMPUTED`** — the day before has no rows, so this one
would resolve its previous close against a session further back. Run the earlier
day first; the backfill does this automatically when given a range.


---

## `getaddrinfo ENOTFOUND …rds.amazonaws.com`

**Not a code problem.** DNS has no record for that hostname.

```bash
nslookup trading-db.cip64s8oy79k.us-east-1.rds.amazonaws.com
```

| Result | Meaning |
|---|---|
| no answer | the RDS instance is **stopped or deleted** — a stopped instance loses its DNS entry, and RDS stops one automatically 7 days after a temporary stop |
| resolves, then times out | security group or VPN, not DNS |
| different host than `.env` | stale or mistyped `DATABASE_URL` |

Every command now reports this as infrastructure rather than printing a raw
driver string, and distinguishes *does not resolve* from *resolves but refuses*
— those need different fixes.

Nothing was lost. The migrations, the imported quotes and depth, and the
symbols are all in the database; only the connection is gone.
