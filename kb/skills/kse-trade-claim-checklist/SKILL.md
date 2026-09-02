---
name: kse-trade-claim-checklist
description: Mandatory verification before stating any trade recommendation, profit figure, or directional claim about a Boursa Kuwait stock. Run this whenever about to say a stock is a good buy, quote what a trade would have made, claim a price will rise or fall, describe what a stock "usually" does, or recommend an entry price. The trader acts on these statements immediately and cannot check them mid-session, so every claim must survive the falsification query before it is spoken.
---

# Trade claim checklist

**The trader acts on what is said, immediately, with real money, and cannot
verify it during a live session.** That places the burden of falsification
entirely on the claim-maker.

**Every check below exists because the corresponding error was actually made in
this project.** They are not hypothetical.

---

# The single most important rule

## A profit figure is worthless unless the trade could have filled

**Before quoting any KD figure — realised, hypothetical, or "what you could have
made" — prove the order would have executed.**

```sql
-- Would a limit order at :price have filled?
-- The queue ahead must have been CONSUMED, not withdrawn.
WITH b AS (
  SELECT captured_at,
         max(bid_price) FILTER (WHERE level=1) AS bp,
         max(bid_qty)   FILTER (WHERE level=1) AS bq
    FROM public.stock_depth
   WHERE symbol = :sym AND captured_at::date = :d
   GROUP BY captured_at),
v AS (
  SELECT created_at, last_price::numeric AS px, volume::numeric AS vol,
         lag(volume::numeric) OVER (ORDER BY created_at) AS pvol
    FROM public.stock_quotes
   WHERE symbol = :sym AND created_at::date = :d AND session = 'Trading')
SELECT sum(v.vol - v.pvol) AS shares_traded_at_or_below
  FROM v
 WHERE v.px <= :price
   AND v.created_at > :entry_time
   AND v.vol > v.pvol;

-- ASSERT: shares_traded_at_or_below > queue_ahead + my_shares
-- If not, the order NEVER FILLED and any profit figure is fiction.
```

## The trap this catches

**A deep bid predicts the price will rise. If the price rises, a passive bid at
that level is never touched.**

| Ratio | Price does | A passive bid |
|-------|-----------|---------------|
| **8:1 or better** | rises | **never fills** |
| under 1:1 | falls | **fills, immediately underwater** |

**The signal and the executability are inversely related. You only get filled
when the signal is against you.**

**Measured, TIJARA 13 August:** the bid at 172 held **300,027 shares** at 09:22
and **452,369** at 09:29. Neither was consumed — the level was withdrawn both
times as price rose. **A 4,500-share order there would not have filled, and
"+5.65" was fiction.**

- [ ] **Never quote a figure from a trade whose queue was withdrawn rather than
      consumed.**
- [ ] State fill probability alongside every hypothetical: *"this would have paid
      +5.65 IF it filled, and the queue ahead was 300,027 which never traded — so
      it would not have."*

---

# Before recommending an entry

Run all five. **Any failure means say so rather than recommending.**

## 1 · Can the order fill?

```
queue_ahead = bid_qty at the target level
my_pct      = my_shares / bid_qty
```

- [ ] `my_pct` between 5% and 30%
- [ ] Below 5% → say **"you would be invisible in this queue"**
- [ ] Above 30% → say **"you would be the level"**

## 2 · Can the position be exited?

- [ ] `offer_qty <= 3 x my_shares` at the intended exit price
- [ ] **Not the offer-to-bid ratio** — that answers a different question.
      OULAFUEL read 53% exitable by ratio while its median offer was 11,490
      against a 2,100 order — 18% of the level, entirely workable.

## 3 · Does the stock move?

- [ ] `moves >= 15` on the last session
- [ ] For a 2-fil target: `moves_2plus >= 3`
- [ ] **MASHAER was recommended with 3 moves in a 1-fil range.** The check was
      never run.

## 4 · Which way has it been going?

- [ ] `chg_1d` and `chg_5d` computed and **stated out loud**
- [ ] Falling on both → say so before anything else
- [ ] **Four of five recommendations in one evening were falling stocks. None of
      the five had this check run.**

## 5 · Is the tape real?

- [ ] `tiny_pct <= 20%` for the session
- [ ] **And at the intended exit price specifically.** ARABREC read 13% for the
      day while every print at 170 — the exit level — was 100, 1 and 9 shares.

---

# Before any directional claim

## Sample size is a hard gate

- [ ] **100+ book snapshots** before stating a direction from depth
- [ ] **Full session, never a fragment**

**A nine-minute read of TIJARA's book produced a signal with the sign inverted** —
deep bid read as bearish when the session showed 91% bullish. **A live position
was nearly cut on it.**

- [ ] Under 100 snapshots → say **"not enough data to state a direction"**

## Count the observations, not the snapshots

- [ ] **6 up-moves is not evidence.** Six coin flips land the same way 1 time
      in 64
- [ ] State the raw count: *"6 up, 0 down — that is six observations"*

---

# Before any "typical" or "usually" claim

## Never a median for a can-I-transact question

**This error has been made three times.**

| Stock | Median said | Truth |
|-------|-------------|-------|
| KFIC postable | **2.0%** | **20%** — and it gave four fills that day |
| EQUIPMENT offer/bid | 0.97 — fine | **38% exitable** |
| ARGAN postable | **2.3%** | **38%** |

- [ ] Use **percentage of session**, or percentiles p10/p50/p90
- [ ] Never `percentile_cont(0.5)` alone for postable, exitable, or reachable

## Never average across a regime change

- [ ] Check the trend within the window before averaging it
- [ ] **CATTL was recommended on a 9-day average of 31 moves.** The last three
      sessions were 13, 16 and 11 — the average was carried by two busy days at
      the start

---

# Before reporting a data finding

- [ ] **Query the actual table before saying something is or is not there.**
      "The depth scraper isn't running" was said while it was running
- [ ] **State the scope of any list before generalising from it.** "Nobody is
      short selling in Kuwait" came from a 39-symbol published list covering none
      of the traded universe
- [ ] Distinguish **absent** from **zero**. A null column and a zero value mean
      different things

---

# Hindsight

**Reading a session backwards always finds good entries.** The entries look
obvious because the outcome is already known.

- [ ] Any "you could have made X" must state whether the signal was visible
      **before** the move, not just present in the data afterwards
- [ ] Label it: *"this is hindsight — the real test is whether it fires on a
      session nobody has seen"*

---

# How to speak when a check fails

**Say the failure. Do not soften it into a recommendation.**

| Instead of | Say |
|------------|-----|
| "ARABREC looks good" | "ARABREC passes six gates; the exit fails at 16% against a 70% floor" |
| "this would have made +15.50" | "the signal was right and the order would not have filled — the queue was withdrawn, not consumed" |
| "buyers are 8:1, buy" | "buyers are 8:1, which means price rises and a passive bid there does not fill. If already long, hold" |
| "the pattern is X" | "one session shows X. That is one observation" |

---

# The error log

**Kept so the pattern stays visible.** Every entry is a real mistake made in this
project.

| Claim | Reality | Check that was skipped |
|-------|---------|------------------------|
| Deep bid → price falls | inverted | full-session sample |
| ARGAN 2.3% postable | 38% | percentage not median |
| CATTL, NIH, MARAKEZ, EMIRATES recommended | all falling | `chg_1d` / `chg_5d` |
| "depth scraper isn't running" | it was | query before asserting |
| MASHAER is the pick | 3 moves, 1-fil range | `moves >= 15` |
| CATTL average 31 moves | last three: 13, 16, 11 | regime change |
| **"+15.50 achievable"** | **unfillable** | **queue consumed vs withdrawn** |
| "nobody shorts in Kuwait" | 39-symbol list only | scope of the source |

**The common thread: a conclusion stated without running the query that would
have falsified it.**

---

# The one-line test

**Before speaking, ask: what query would prove this wrong, and has it been run?**

**If it has not been run, run it. If it cannot be run, say the claim is
unverified.**
