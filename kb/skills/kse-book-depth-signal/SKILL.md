---
name: kse-book-depth-signal
description: Read order book depth to judge direction and danger on Boursa Kuwait. Use before any entry, when deciding whether to hold or cut an open position, when asked whether buyers or sellers are winning, when a trader says the bid looks "piled up" or "full", or when a small trade has just moved the price. Produces a buyers-per-seller ratio, a hold-or-cut verdict, and the bid-protection check.
---

# KSE book depth signal

**Two numbers. That is the whole skill.**

```
buyers_per_seller = bid_qty / offer_qty     -- which way price is leaning
bid_qty beneath you                         -- whether you can be pushed down
```

---

# 1 · Buyers per seller — which way price leans

| Ratio | Meaning |
|-------|---------|
| **8 or more** | price will rise |
| 1 – 8 | no edge |
| **under 1** | price will fall |

**TIJARA, 13 August 2026. 443 book snapshots, full session.**

| Buyers per seller | Snapshots | Price UP | Price DOWN |
|-------------------|-----------|----------|------------|
| **8 or more** | 153 | **6** | **0** |
| 4 – 8 | 96 | 2 | 2 |
| 1 – 4 | 141 | 2 | 3 |
| **under 1** | 53 | **1** | **9** |

## Why a deep bid means UP, not support

**A big bid is buyers who cannot get filled.** Four hundred thousand shares want
in and only fifty thousand are for sale. Most of those buyers go home empty.

**Their only way in is to pay more.** When the offer clears, they raise the bid.

**This is the opposite of the intuitive reading.** A large bid looks like a floor
against a fall. It is unsatisfied demand pushing upward.

---

# 2 · THE TRAP — a high ratio does not mean you can buy

**This is the most important section in the skill.**

**A deep bid predicts the price will rise. If the price rises, a passive bid at
that level is never touched.**

| Ratio | Price does | Your resting bid |
|-------|-----------|------------------|
| **8:1** | rises | **never fills** |
| **under 1** | falls | **fills — and you are immediately underwater** |

**You only get filled when the signal is against you.**

**Measured, TIJARA 13 August:** the bid at 172 held **300,027 shares** at 09:22
and **452,369** at 09:29. Neither was consumed — the level was withdrawn both
times as price rose. **A 4,500-share order there would not have filled.**

- [ ] **Never quote a profit from an 8:1 entry without proving the queue was
      consumed rather than withdrawn.**
- [ ] The correct use of 8:1 is **HOLD**, not BUY.

---

# 3 · The bid beneath you — the danger check

**Use this whenever a position is open.**

## The mechanism, in one example

**You hold 4,400 shares at 175.**

**A 100-share sell pushes the price to 174.**

```
They spent:  100 shares
You lost:    4,400 x 1 fil = 4.40 KD
```

**It costs them nothing to cost you money.**

## When it can happen

**Normal — bid at 174 holds 30,000 shares.** A 100-share sell is absorbed.
**Price does not move.**

**Dangerous — bid at 174 holds 200 shares.** A 100-share sell takes half of it.
The next one breaks through. **Price falls.**

## The rule

```
Bid beneath your position, level 1:

  under 20,000     ->  NO PROTECTION. Exit.
  20,000-100,000   ->  thin. Watch it.
  over 100,000     ->  protected.
```

## The tell

**A tiny print moving the price DOWN means the bid was already empty.**

**A tiny print moving it UP is harmless** — someone lifting a thin offer.

**Market-wide, 20 symbols over 6 sessions: tiny prints cluster almost entirely on
up-moves.**

| Symbol | Up-moves on tiny | Down-moves on tiny |
|--------|------------------|--------------------|
| WETHAQ | **70%** | 12% |
| MRC | **67%** | 20% |
| ARGAN | **57%** | 4% |
| UPAC | **56%** | **0%** |
| MUNSHAAT | **54%** | **0%** |
| ALOLA | **48%** | **0%** |

**No exception in twenty stocks.**

**The asymmetry is structural — bids are deeper than offers, so a small buy clears
a thin offer while a small sell hits a wall.**

**Which is exactly why a down-tiny print is a warning: it should not be possible
unless the bid is gone.**

---

# 4 · The blocking condition

```
BLOCKED if offer_qty > 200,000
```

**Deep on both sides is a standoff, not a signal.**

**On the same TIJARA session a 1,030,681-share offer appeared at 175 and rejected
every attempt to advance.** Walls of 238,168 and 250,738 followed at 176 and 174.

- [ ] **Check BLOCKED before the ratio.** An 8:1 ratio under a 240,000 offer is
      not a buy.

---

# The query

```sql
WITH b AS (
  SELECT captured_at,
         max(bid_price)   FILTER (WHERE level=1) AS bid,
         max(bid_qty)     FILTER (WHERE level=1) AS bid_qty,
         max(offer_price) FILTER (WHERE level=1) AS offer,
         max(offer_qty)   FILTER (WHERE level=1) AS offer_qty
    FROM public.stock_depth
   WHERE symbol = :sym AND captured_at::date = current_date
   GROUP BY captured_at)
SELECT to_char(captured_at AT TIME ZONE 'UTC' + interval '3 hours','HH24:MI') AS t,
       bid, bid_qty, offer, offer_qty,
       round(bid_qty::numeric / NULLIF(offer_qty,0), 1) AS buyers_per_seller,
       CASE
         WHEN offer_qty > 200000 THEN 'BLOCKED - wall above'
         WHEN bid_qty   <  20000 THEN 'NO PROTECTION - exit'
         WHEN bid_qty::numeric / NULLIF(offer_qty,0) >= 8
              THEN 'LEANING UP - hold, do not chase'
         WHEN bid_qty::numeric / NULLIF(offer_qty,0) <  1
              THEN 'LEANING DOWN'
         ELSE 'NO EDGE'
       END AS signal
  FROM b ORDER BY captured_at DESC LIMIT 5;
```

**Without depth data, `stock_quotes.bid_qty` and `offer_qty` carry level 1 — enough
for all three checks.**

---

# How to say it

**Two numbers, one verdict. Nothing else.**

> **Buyers per seller 8.1. Bid beneath you 426,890 — protected. Hold.**

> **Bid down to 9,701. No protection. A hundred shares moves this against you.
> Exit.**

> **Ratio 12, but the offer overhead is 238,168. Blocked — that wall rejected this
> level four times today.**

**Never say "buy" from an 8:1 ratio.** Say *"leaning up — if you are already long,
hold."*

---

# Limits

**One stock, one session.** TIJARA on 13 August is 443 snapshots of a mechanism
that ought to generalise and has not been tested elsewhere.

**Requires 100+ snapshots.** A nine-minute read of that same book produced a
signal with the sign inverted, and a live position was nearly cut on it.

**Thresholds are TIJARA's.** Scale per stock: deep is roughly 8% of daily volume
at one level, thin is under 0.5%.

**It says nothing about how far price travels** — only which way the next tick
leans.

**And the historical version of the down-tiny warning is weak.** Across 361
stock-days, a session with no down-tiny prints averaged **+0.71 fils** the next day
against **−0.13** when down-tiny dominated. Monotonic, but the gap is under one fil
and the sample is small. **Use it live, on the bid beneath you — not as a next-day
forecast.**
