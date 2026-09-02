---
name: kse-auction-and-tip-trades
description: Rules for entering via the opening auction on Boursa Kuwait, and for handling trades based on tips, news or a source rather than measured signals. Use whenever a limit price for the pre-open auction is being chosen, when a trade is proposed on the basis of information rather than data, when a stock has recently resumed from suspension, or when a directional hold is being planned outside the SPREAD strategy.
---

# Auction entry and tip-driven trades

**Two failure modes, both observed live on 16 August 2026, both expensive.**

---

# 1 · Never bid the ceiling in an auction

## The rule

```
Bid the price you would want to OWN it at.
Never the maximum the terminal accepts.
```

## Why the usual reasoning is wrong

**The standard argument: "a high limit protects you, because you fill at the
clearing price, not your limit."**

**True — and incomplete. In a thin auction your bid helps SET the clearing
price.**

**If yours is among the highest, the auction clears where you bid.**

## The case

**PHC, 16 August 2026.**

| | |
|---|---|
| Limit posted | **178** — the maximum the terminal would accept |
| Auction cleared | **178** |
| Price 30 seconds later | **176** |
| Price 30 minutes later | **168** |

**The auction cleared at the highest price of the day, and the limit was part of
the reason.**

**A bid at 172 would have filled cheaper or not filled. Both outcomes better than
filling at the top.**

## The pre-auction book tells you where it will clear

**Watch the crossed book in the last minutes before 09:00:**

```
08:57   bid 179 x 5,000    offer 174 x 2,000     -- thin, early
08:58   bid 179 x 5,000    offer 174 x 2,000
08:59   bid 181 x 50,000   offer 173 x 85,000    -- real interest
```

**When the offer side is heavier than the bid side, the clearing price lands in
the lower half of the range. On 16 August it was 85,000 against 50,000 — and it
still cleared at 178, at the top.**

- [ ] **Read the pre-auction book at 08:59 before leaving a limit in.**
- [ ] Bid in the lower half of the crossed range, not above it.

---

# 2 · Never buy the session after a resumption spike

## The pattern

**A stock returning from suspension clears several sessions of held-back orders
in one day. That volume is not demand — it is backlog.**

## The case

| | |
|---|---|
| KPPC suspended | 4–12 August, **7 sessions** |
| Resumed as PHC, 13 Aug | **38.2 M shares**, 1,171 trades |
| Normal volume | 5–12 M |
| **Next session, 16 Aug** | **17.5 M shares by 09:34, price −10 fils** |

**Day one looked like enormous demand. Day two was the rest of the sellers.**

- [ ] **Wait three sessions after a resumption before reading the book as normal.**
- [ ] Resumption-day depth does not persist and must not be used for sizing.

---

# 3 · A tip is a reason to look, not a reason to size

## The rule

```
Unmeasurable information  ->  minimum size, or no trade
```

**If there is no way to score the source's history, there is no way to size the
position rationally.**

## What went wrong

**A tip arrived: "it will reach 200."**

**What followed was a full analytical plan — volume profile, point of control,
entry tranches, a 5:1 risk-reward table, staged targets.**

**All of it correct arithmetic built on an unverifiable premise.**

**Structure makes an opinion look like evidence.** The analysis was real; the
thing it rested on was not.

## The honest framing that should have been used

> "There is no way to measure whether this source has been right before. That
> makes the position size a judgement about trust, not about probability. Size it
> as a lesson you are willing to pay for."

**At 400 KD instead of 785, the same outcome would have cost −17 KD rather than
−34.**

- [ ] **Never present a tip-driven trade with the same apparatus as a measured
      one.** No expected-value tables, no risk-reward ratios computed from a
      target nobody can verify.
- [ ] State plainly that the premise is unverifiable, once, before any numbers.
- [ ] **Half size or less.**

---

# 4 · What was right, and why it matters

**The stop.**

```
Entry 178 · stop 165 · exit into a 559,140-share bid
Worst case  -59 KD, and always executable
```

**Compare the trades in this record that had no stop:**

| | |
|---|---|
| EQUIPMENT, held over a weekend | **−44.94** |
| EMIRATES | **−31** |
| EMIRATES | −24.16 |
| WETHAQ | −11.18 |

**A bad entry with a stop is survivable. A bad entry without one is not.**

- [ ] **The stop is set before the fill and never moved afterwards.**

---

# The checklist

**Before any auction entry:**

- [ ] Read the crossed book at 08:59
- [ ] Bid in the lower half of the range, never the terminal maximum
- [ ] Check the stock has not resumed from suspension in the last 3 sessions

**Before any tip-driven trade:**

- [ ] Say once, plainly: the premise cannot be measured
- [ ] No risk-reward table built on an unverifiable target
- [ ] Half size or less
- [ ] Stop set before entry, in writing, and never moved

---

# Honest note

**This skill exists because of one morning, and both errors were in the planning
rather than the execution.**

**The trader supplied a source. That is a normal part of trading.**

**The failure was giving that source the appearance of analysis** — entry
tranches, a point-of-control study, a 5:1 table — when the only honest response
was to name it as unmeasurable and shrink the position.
