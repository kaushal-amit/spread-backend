---
name: kse-session-comparison
description: Compare today's session against the same stock's previous sessions before giving any hold, exit or target advice on Boursa Kuwait. Use whenever a price target is being set, when deciding whether to hold for a higher level, when a trader says "it is slow today" or "yesterday it moved", or when a range from a previous session is being applied to the current one. A range that worked yesterday does not work today if the volume that drove it is absent.
---

# Session comparison

**A price range is not a property of the stock. It is a property of the volume
moving through it.**

**The same box with a third of the fuel is a different box.**

---

# The rule

```
BEFORE setting any target, compare TODAY to YESTERDAY
at the SAME time of day.
```

**Never advise a target from yesterday's range without checking today's engine.**

---

# The five comparisons, in order

| # | Compare | Why |
|---|---|---|
| **1** | **Volume to the same clock time** | the fuel |
| **2** | **% of minutes with any trade** | is it alive or frozen |
| **3** | **Buy/sell ratio** | who is pushing |
| **4** | **Average offer depth** | is the ceiling heavier |
| **5** | **Wall persistence at the target level** | can you get through |

---

## The query

```sql
WITH t AS (
  SELECT (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date AS dt,
         created_at, last_price::numeric px, bid::numeric b, offer::numeric o,
         bid_qty::numeric bq, offer_qty::numeric oq, volume::numeric v,
         lag(volume::numeric)     OVER w AS pv,
         lag(last_price::numeric) OVER w AS ppx
    FROM public.stock_quotes
   WHERE symbol = :sym AND session = 'Trading'
     AND last_price > 0 AND bid > 0 AND offer > bid
     AND (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date IN (:today, :prev)
     AND (created_at AT TIME ZONE 'UTC' + interval '3 hours')::time <= :now_time
  WINDOW w AS (PARTITION BY (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date
               ORDER BY created_at))
SELECT dt::text AS day,
       round(min(px)) AS lo, round(max(px)) AS hi,
       sum(v-pv) FILTER (WHERE v>pv)                        AS volume,
       count(*)  FILTER (WHERE px<>ppx)                     AS moves,
       count(*)  FILTER (WHERE v>pv)                        AS mins_traded,
       count(*)                                             AS total_mins,
       round(100.0*count(*) FILTER (WHERE v>pv)/count(*))   AS pct_active,
       round(avg(bq))                                       AS avg_bid,
       round(avg(oq))                                       AS avg_offer,
       round((sum(v-pv) FILTER (WHERE px>=o))::numeric
           / NULLIF(sum(v-pv) FILTER (WHERE px<=b),0), 2)   AS buy_sell
  FROM t
 WHERE pv IS NOT NULL
 GROUP BY dt ORDER BY dt;
```

**`:now_time` is the current clock time, not the close. Comparing a half-finished
session against a full one is meaningless.**

---

# The reference case — MRC, 25 vs 26 August

**Both days opened in the same box. One was tradeable to the top, one was not.**

| To 10:10 | 25 Aug | **26 Aug** | |
|----------|--------|------------|---|
| Range | 203–211 | 205–211 | same |
| **Volume** | **5,851,980** | **1,993,176** | **34%** |
| Moves | 41 | 30 | 73% |
| Minutes with a trade | 64 of 67 | **47 of 68** | **96% → 69%** |
| **Buy/sell** | **14 : 5** | **5 : 5.3** | **flipped** |
| Avg offer | 26,432 | **36,258** | **+37%** |

**Yesterday: 3.61 M shares lifted off the offer in 45 minutes.**
**Today: 693 K — nineteen percent of it.**

---

## What that meant in practice

**Yesterday the trader took five contracts and 210 was reachable.**

**Today the same 210 sits behind 154,157 shares with a third of the fuel.**

**Same box. Different engine.**

- [ ] **When volume is under 50% of the equivalent hour, lower the target by a
      fil.**
- [ ] **When the buy/sell ratio has flipped from above 2.0 to below 1.0, the
      up-move is not coming. Take what is inside the range.**

---

# The trap this exists to prevent

**Yesterday's winning trades create a template. The template gets applied to today
without checking whether the conditions that made it work are present.**

**"210 was hit five times this morning" is true and irrelevant if the volume that
hit it has gone.**

---

# What yesterday's session actually taught

**MRC 25 August, by half hour:**

| Half hour | Range | Volume | Ratio |
|-----------|-------|--------|-------|
| 09:00 | 204–211 | **3.94 M** | 12:5 |
| 09:30 | 203–209 | 1.52 M | 16:5 |
| 10:00 | 201–209 | 1.41 M | **32:5** |
| **10:30** | **201–205** | **0.51 M** | 3:5 |
| 11:00 | 202–205 | 0.58 M | **1:5** |
| 12:00 | 203–205 | 0.84 M | 4:5 |

**211 was touched at 09:15 and never again.**

**After 10:00 the range collapsed to 201–206 and stayed there for three hours.**

**All four winning contracts were bought in 201–203, inside the grind. The one
loss was bought at 207, chasing the morning move.**

- [ ] **The money is in the grind, not the morning move.**
- [ ] **Once volume falls below half the opening pace, expect a narrow band for
      the rest of the session.**

---

# Wall comparison

**Compare the target level across both days:**

```sql
WITH b AS (
  SELECT DISTINCT (captured_at AT TIME ZONE 'UTC' + interval '3 hours')::date AS dt,
         captured_at, offer_qty::bigint AS qty
    FROM public.stock_depth
   WHERE symbol = :sym AND offer_price = :target_level
     AND (captured_at AT TIME ZONE 'UTC' + interval '3 hours')::date IN (:today, :prev))
SELECT dt::text AS day, count(*) AS snaps,
       max(qty) AS peak, min(qty) AS trough,
       count(*) FILTER (WHERE qty = lag_qty) AS unchanged_snaps
  FROM (SELECT dt, qty, lag(qty) OVER (PARTITION BY dt ORDER BY captured_at) AS lag_qty
          FROM b) x
 GROUP BY dt ORDER BY dt;
```

**MRC's 215 level:**

| | 25 Aug | 26 Aug |
|---|--------|--------|
| Peak | 287,741 | **489,068** |
| Present | 119 of ~470 snaps — 25% | **47 of 49 — 96%** |

**Nearly double the size and permanently present instead of intermittent.**

- [ ] **A wall that grew overnight is a heavier ceiling, regardless of what the
      price did yesterday.**

---

# How to state it

**Always give both numbers, never just today's.**

> **Volume 1.99 M against 5.85 M at the same time yesterday — 34%. Buy/sell has
> flipped from 14:5 to 5:5.3. The box is the same but the engine isn't. Lower the
> target to 209.**

**Not:**

> ~~"210 has been touched five times, hold for it."~~

---

# Limits

**Two sessions is a comparison, not a pattern.** Yesterday may itself have been
unusual — MRC's 5.85 M was 4x its own baseline.

**Compare to the 5-day median as well when the data exists**, so a quiet day
isn't judged against an exceptional one.

**And the trader's own reading has repeatedly been right before the measurement.**
On 26 August the observation "volume is quite less than yesterday and movement is
very slow" was correct and preceded this check. **When they say the session feels
different, run the comparison before arguing the range.**
