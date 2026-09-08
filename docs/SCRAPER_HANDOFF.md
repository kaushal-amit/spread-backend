# To the scraper owner — the seven columns the gates read, and one new one

**From:** the SPREAD backend · **Re:** `public.symbol_day` · **Date:** 4 September 2026

The trading board's gates read seven per-session statistics from `public.symbol_day`. Six of them exist as columns and are NULL on every row (4,465 rows, 33 sessions as of 2 September); the seventh — the blended tiny-print percentage — has no column yet. The backend is filling all of them from `awsat_market_quotes` in a bridge table (`spread.symbol_day_stats`, `npm run stats:daily`, 13:45 Kuwait) and the view prefers your value the moment it is non-NULL, so this is a request to move the computation to where the data is written, not a request to change anything the backend does today.

## What we are asking for, in `public.symbol_day`

1. **`tiny_pct` — a new column, blended.** The percentage of price moves *in either direction* caused by a print of 100 shares or fewer (`last_qty <= 100`). Please keep `tiny_pct_up` exactly as it is — it is informative and the terminal shows it — but Gate 5's 20% threshold was calibrated on the blended figure, which runs at roughly half of the up-only one (ABAR on 1 Sep: up-only 30.9%, blended 17.7%). The exact SQL is in `scripts/scraper-symbol-day-stats.sql` in the backend repo: the `tiny_pct` expression in the `m` CTE, over the `t` CTE's filter (`session IN ('Trading','CB Auction','')`, `bid > 0 AND offer > 0`).

2. **The six columns that exist and are NULL**, with the definitions the gates read (all in the same SQL file, ready to run with `:day` and `:budget_kd`):

   | column | definition | budget-dependent |
   |---|---|---|
   | `pct_postable` | % of captured minutes where the touch-bid depth in KD is within `[budget/0.30, budget/0.05]` — an order of `budget` KD would be 5–30% of the level | yes (`:budget_kd`, 790 today) |
   | `pct_exitable` | % of minutes where offer notional ≤ 2 × bid notional | no |
   | `vol_ratio_5d` | today's volume / mean volume of the previous 5 sessions | no |
   | `bid_p25` | 25th percentile of touch-bid depth in KD | no |
   | `block_ratio` | as your column comment defines it — the gate reads it as-is | no |
   | `exitable_best_hour` | the best single hour's `pct_exitable`, hours with ≥ 10 captured minutes | no |

   Plus one more the bridge computes that has no column: **`gap_pct`** — % of minutes where `offer − bid ≥ 2` fils (room to post inside the spread). If you would rather not add it, say so and the bridge keeps computing it; the view already COALESCEs each column to the bridge when yours is NULL.

3. **`data_quality` values.** Please confirm the column holds exactly `FULL` / `PARTIAL` / `THIN` (the backend's filters and the review page assume those three; an earlier version of our code filtered on `'OK'`, which matched nothing).

## Acceptance

Run against `kse` after the first session you fill:

```sql
SELECT gate_stats_source, count(*)
  FROM spread.symbol_day
 WHERE trading_date = current_date
 GROUP BY 1;
```

It must return only `SCRAPER`. (`BACKEND_BRIDGE` means the view fell back to the bridge for that symbol; `NULL` means neither side had a row.) When that holds for a week, migration 020 drops `spread.symbol_day_stats` and the `stats:daily` job, and the terminal reads your numbers directly.

## Until then

The bridge runs after every session — `cron` line in the backend README: `45 10 * * 0-4 npm run stats:daily` (13:45 Kuwait). Nothing on your side changes until you are ready; the view takes your value the moment it is there.
