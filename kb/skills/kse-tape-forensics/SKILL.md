---
name: kse-tape-forensics
description: Detect artificial price movement and book manipulation patterns on Boursa Kuwait from stock_quotes minute data. Use when evaluating whether a stock's price action is backed by real size, when a screening candidate looks good but "feels wrong", when a resting order keeps getting stranded, or when asked to check who is "playing" a stock. Produces per-symbol pattern classification with the measured evidence.
---

# KSE tape forensics

**What this does:** reads minute-level quote data and classifies how a stock's
price is being moved — by real size, or by prints too small to fill anyone.

**What it does not do:** determine intent, or assert that anyone is breaking a
rule. A pension fund rebalancing and a coordinated mark-up produce identical
footprints. **This measures the footprint. It does not name the animal.**

The output is a trading decision — is this price reachable for me — not an
allegation.

---

## When to run it

- A candidate passes the funnel but the price action looks odd
- A resting order keeps being stranded or jumped
- Before committing to any stock whose tape you have not examined today
- Any time the trader asks who is "taking it up" or "playing" a stock

---

## The five patterns

Each has a name, a measurable signature, and a consequence for the trader.

### 1 · MARK-UP · price raised on trades too small to fill anyone

```sql
avg_up_size    = avg(volume_delta) WHERE price rose
avg_down_size  = avg(volume_delta) WHERE price fell
markup_ratio   = avg_down_size / avg_up_size
```

**FLAG when `markup_ratio >= 10` and `up_on_tiny >= 3`.**

| Severity | Ratio |
|---|---|
| Watch | 10 – 50 |
| **Severe** | **> 100** |

**Measured, 12 August 2026:**

| Symbol | Avg up | Avg down | Ratio |
|--------|--------|----------|-------|
| **NRE** | **4 shares** | 44,813 | **11,200** |
| **EMIRATES** | **35** | 25,113 | **717** |
| **MARAKEZ** | **229** | 5,585 | **24** |

**MARAKEZ, first twenty minutes — the clearest example on record:**

| Time | Move | Shares |
|------|------|--------|
| 09:01 | 183 → **186** | **1** |
| 09:02 | 186 → **182** | 3,800 |
| 09:03 | 182 → **185** | **1** |
| 09:04 | 185 → **182** | 3,530 |
| 09:05 | 183 → **185** | **1** |

**The cycle repeats twice in four minutes.** One share up, thousands back down.

**Consequence:** the displayed price is not where you can transact. A quoted 186
with a 1-share print behind it will not fill a 4,000-share sell.

---

### 2 · BID PULL · support withdrawn without trading

```sql
bid_pull = bid_qty < previous_bid_qty * 0.3
           AND previous_bid_qty > 10000
           AND volume unchanged
```

**The `volume unchanged` clause is what makes this meaningful.** If volume moved,
the bid was consumed — that is normal. If it did not, the orders were cancelled.

**FLAG when `bid_pulls >= 6` in a session.**

**Measured, 12 August:** ARABREC **12** · EQUIPMENT **10** · MARAKEZ 9 ·
MUBARRAD 9

**Consequence:** your resting order becomes the best bid without your doing
anything, and price falls onto it. This is the 29 July failure — an order correct
at 09:51 and stranded at 09:56 with no action taken.

---

### 3 · OFFER STACK · the exit closes after you are committed

```sql
offer_stack = offer_qty > previous_offer_qty * 3
              AND previous_offer_qty > 1000
```

**FLAG when `offer_stacks >= 6`, or when a single stack exceeds 20x your order.**

**Measured, 12 August — ABAR, twelve minutes:**

| Time | Bid | Offer | Ratio |
|------|-----|-------|-------|
| 09:44 | 35,318 | **2,134** | **0.06** |
| 09:53 | 6,000 | 35,634 | 6.03 |
| **09:56** | **200** | 35,634 | **180** |

**A 2,134-share offer became 35,634 while the bid went from 35,318 to 200.**

**Consequence:** the WETHAQ trade — bid 20,000, offer 226,114, filled in minutes,
then 226,000 shares blocked the exit. **−24 KD.**

---

### 4 · CHURN · high trade count, few price changes

```sql
churn_ratio = trades / NULLIF(price_moves, 0)
```

**FLAG when `churn_ratio > 15` and `trades > 100`.**

**Reference case:** GFH, 227 trades and **8 price moves**. Everything went through
at one price.

**Consequence:** activity that looks like liquidity and is not. This is why the
trade-count floor was removed — it kept GFH and cut CATTL.

---

### 5 · PING · repeated sub-100-share trades at one price level

```sql
ping = count of trades <= 100 shares AT a specific price
```

**FLAG when `>= 3` tiny prints occur at the same level in a session.**

**This is the level-specific version of Gate 5 and it matters more than the daily
average.**

**ARABREC, 11 August** read **13% tiny for the whole day** and looked clean. The
moves to 170 — the intended exit — were:

| Time | Move | Shares |
|------|------|--------|
| 10:27 | 169 → 170 | **100** |
| 10:44 | 170 → 169 | 29,000 |
| 10:49 | 169 → 170 | **1** |
| 10:54 | 170 → 169 | 30,000 |
| 11:07 | 169 → 170 | **9** |

**Tiny prints pushed it up; 30,000-share blocks pushed it back.** All the
painting was concentrated at exactly the level the trader planned to sell into.

**Consequence:** a daily average cannot see clustering. **Always check the tape at
the price you intend to exit, not across the session.**

---

## The query

`scripts/tape_forensics.sql` runs all five in one pass.

```sql
WITH t AS (
  SELECT symbol, created_at,
         last_price::numeric px, volume::numeric v,
         bid_qty::numeric bq, offer_qty::numeric oq,
         lag(last_price::numeric) OVER w AS ppx,
         lag(volume::numeric)     OVER w AS pv,
         lag(bid_qty::numeric)    OVER w AS pbq,
         lag(offer_qty::numeric)  OVER w AS poq
    FROM public.stock_quotes
   WHERE created_at::date = :d
     AND session = 'Trading'
     AND last_price > 0 AND bid > 0 AND offer > bid
  WINDOW w AS (PARTITION BY symbol ORDER BY created_at)
), e AS (
  SELECT symbol, px, ppx, v - pv AS sz, bq, oq, pbq, poq,
         (v = pv) AS no_trade
    FROM t WHERE pv IS NOT NULL
)
SELECT symbol,
       count(*) FILTER (WHERE sz > 0)                              AS trades,
       count(*) FILTER (WHERE px <> ppx)                           AS moves,
       -- 1 MARK-UP
       round(avg(sz) FILTER (WHERE px > ppx AND sz > 0))           AS avg_up_size,
       round(avg(sz) FILTER (WHERE px < ppx AND sz > 0))           AS avg_down_size,
       round((avg(sz) FILTER (WHERE px < ppx AND sz > 0))
           / NULLIF(avg(sz) FILTER (WHERE px > ppx AND sz > 0),0)) AS markup_ratio,
       count(*) FILTER (WHERE px > ppx AND sz BETWEEN 1 AND 100)   AS up_on_tiny,
       -- 2 BID PULL
       count(*) FILTER (WHERE bq < pbq * 0.3 AND pbq > 10000
                          AND no_trade)                            AS bid_pulls,
       -- 3 OFFER STACK
       count(*) FILTER (WHERE oq > poq * 3 AND poq > 1000)         AS offer_stacks,
       -- 4 CHURN
       round(count(*) FILTER (WHERE sz > 0)::numeric
           / NULLIF(count(*) FILTER (WHERE px <> ppx),0), 1)       AS churn_ratio
  FROM e
 GROUP BY symbol
HAVING count(*) FILTER (WHERE sz > 0) >= 8
 ORDER BY markup_ratio DESC NULLS LAST;
```

**For pattern 5 (PING), run `scripts/ping_at_level.sql` with the symbol and the
price you intend to exit at.**

---

## Classification

Apply in order. First match wins.

```
markup_ratio > 100                         -> PAINTED     do not trade
markup_ratio >= 10  AND up_on_tiny >= 3    -> MARKED      avoid today
offer_stacks >= 6   AND bid_pulls >= 6     -> UNSTABLE    book not reliable
churn_ratio > 15    AND trades > 100       -> CHURNED     activity is not liquidity
ping >= 3 at your exit level               -> EXIT PAINTED  pick another exit
none of the above                          -> CLEAN
```

---

## Reporting

**State the measurement, name the consequence, do not assert intent.**

> **NRE — PAINTED.** Up-moves average **4 shares**, down-moves **44,813**. The
> displayed price will not fill a 6,000-share order. Avoid today.

> **ARABREC — UNSTABLE.** 12 bid pulls and 12 offer stacks this session. A resting
> order will be stranded. This is the 29 July shape.

**Never write** "they are manipulating" or "someone is running a pump". **Write**
"the price is being set by trades too small to fill anyone" — which is what was
measured, and is enough to decide on.

---

## Limits

**One session is not a pattern.** MARAKEZ has shown this every day it has been
checked; a single reading on a quiet stock is noise.

**Small samples inflate ratios.** A stock with 7 moves and 2 tiny prints reads 29%
and means little. **Require `moves >= 10` before trusting a percentage.**

**Legitimate activity produces the same footprint.** Index rebalancing, a fund
unwinding, a market maker adjusting quotes — all of these look like this. The
classification tells you the price is not reachable. It does not tell you why.

**And it says nothing about direction.** A PAINTED stock can rise all week. This
answers *can I transact here*, never *where is it going*.
