---
name: kse-operator-tactics
description: Read the intent behind large orders on Boursa Kuwait. Use when a big bid or offer appears, when price is moving without obvious cause, when deciding whether a wall is real, when a position is going against you and the reason is unclear, or when asked what "they" are doing. Answers the question "who benefits if I believe this book?" rather than "what do the numbers say".
---

# Operator tactics

**Every resting order is visible to everyone. A participant with size knows that,
and places orders to be *seen* as much as to be filled.**

**So the question is never "what does the book say". It is:**

> **Who benefits if I believe this book?**

---

# The one test that separates real from theatre

```
Did the size TRADE, or was it WITHDRAWN?
```

```sql
large level shrinks
  AND volume moved      -->  REAL. Supply or demand was absorbed.
  AND volume unchanged  -->  DISPLAY. It was never for sale.
```

**Measured examples, all from live sessions:**

| Event | Size | Volume when it went | Verdict |
|-------|------|---------------------|---------|
| TIJARA 13 Aug 09:44, offer 175 | **950,445** | **zero** | display |
| ABAR 17 Aug 10:02, offer 239 | **1,076,266** | **zero** | display |
| ABAR 17 Aug, offer 227 | 407,175 | **2,432,434 traded** | real |
| ABAR 18 Aug 09:41, offer 220 | **100,000** | **zero** | display |

**A million shares that never trade is a message, not an order.**

---

# The tactics catalogue

## 1 · THE CEILING

**A large offer parked at a level and left there all session. Never traded.**

**ABAR 17 Aug: 230 held 231,424–679,964 shares and was present in 188 of 189
snapshots. Price touched 230 for four minutes across two days.**

**What it does:** stops anyone believing the stock can go higher. Every level
beneath it starts to look cheap.

**Who benefits:** they sold **5,636,458 shares between 226 and 231** — and spent
**two minutes at 231**. The top was never where they sold. It existed to price
everything below it.

- [ ] A ceiling is not resistance. It is a price tag on the levels underneath.

## 2 · THE WALK-DOWN

**The offer lowers its price step by step, each level appearing without trading.**

**ABAR 18 Aug, three minutes:**

```
09:40   offer 221 x 30,053
09:41   offer 220 x 100,000   <- appears, NO trade
09:43   offer 219 x 17,392
09:44   price 218
```

**ABAR 17 Aug, ninety minutes: 239 → 228 → 226 → 225.**

**What it does:** each new offer beneath the last tells holders the price is
falling. It manufactures the impression of supply.

**Who benefits:** whoever is buying underneath — see tactic 3.

## 3 · CAP AND CATCH — the core manoeuvre

**Two orders, one intent.**

```
OFFER placed above the market    ->  price cannot rise
OFFER walks down                 ->  price is pushed toward a chosen level
BID placed at that level         ->  they buy there
```

**ABAR 18 Aug, in four minutes:**

| Time | Offer | Bid | Price |
|------|-------|-----|-------|
| 09:41 | **220 × 100,000** appears untraded | 219 × 17,000 | 221 |
| 09:43 | 219 × 17,392 | 218 × 27,700 | 219 |
| **09:44** | 218 × 7,300 | **217 × 168,000** | **218** |

**They walked the offer down four fils and a 168,000-share bid was waiting at
217.**

**The purchase price was chosen, not discovered.**

- [ ] **When you see a walk-down, look immediately for the large bid beneath. That
      is the price they want.**

## 4 · WHICH SPOOF IS IT — the decisive test

**A walk-down looks identical whether they are accumulating or distributing.**

**The bid tells them apart.**

| As price falls | Meaning |
|----------------|---------|
| **large bid appears beneath** | **ACCUMULATING** — they are buying |
| **bid collapses to nothing** | **DISTRIBUTING** — nobody is catching it |

**ABAR 17 Aug: price fell 225 → 223 and the bid went to twenty shares.**
Distribution. It kept falling to 216.

**ABAR 18 Aug: price fell 221 → 218 and a 168,000 bid appeared at 217.**
Accumulation.

**Same tactic, opposite meaning, one day apart.**

## 5 · THE STOP SHELF

**The large bid in a cap-and-catch is placed where other people's stops sit.**

**Round numbers, yesterday's low, the level below an obvious shelf.**

**ABAR 18 Aug: 217 was one fil below the trader's own stop.**

- [ ] **Never place a stop at a round level or an obvious shelf.** That is where
      the buying is waiting, and stopping out means selling to them at the price
      they engineered.
- [ ] Place it a fil or two beyond, or use a condition instead of a level.

## 6 · THE TRAPPED SHELF

**After a markup, the levels between the price and the ceiling hold everyone who
bought the top.**

**ABAR 17 Aug: 508,755 shares between 225 and 230.**

**The operator cannot let price rise into that, because every one of those holders
would sell and compete with them.**

- [ ] **After a markup, count the shares between price and the ceiling. That is
      how long the stock stays capped** — not a guess, an inventory.

## 7 · THE UNDERCUT — distribution ending

**A NEW offer level appears BELOW a static wall.**

**ABAR 17 Aug:**

| Time | 224 | 225 |
|------|-----|-----|
| 11:19 | **nothing** | 314,928 |
| 11:22 | 30,000 | 314,928 |
| **11:26** | **85,000** | 320,699 |

**The wall never moved. The level beneath went 0 → 85,000 in seven minutes.**

**A second seller is undercutting the first. They are now racing each other down.**

- [ ] **Strongest exit signal in the catalogue.** Any hope of a higher auction
      clearing price is gone.

## 8 · THE LOAD

**Weeks of nothing, then one day of heavy one-sided buying.**

**ABAR 9 Aug: 1,687,220 bought against 177,915 sold. Ratio 9.48. Trades 34 → 154.
Volume 7×.**

**This is the only phase where following them pays.**

## 9 · THE MARKUP THEY SELL INTO

**A gap up on huge volume — with a balanced buy/sell ratio.**

**ABAR 16 Aug: +15%, 12.9 million shares, ratio 1.06.**

**PHC 16 Aug: 25 million shares lifted offers and the price FELL four fils.
Ratio 1.35.**

- [ ] **A big up-day with a ratio near 1.0 means they are selling into their own
      move.** This is the single most reliable "do not buy" in the catalogue —
      both of the trader's losing positions failed it.

## 10 · COMPRESSION AND RELEASE

**Demand builds all session, price does not move, and it clears in the auction.**

**TIJARA 13 Aug: ratio 8.0 → 5.3 → 10.5 → 28.8 by hour, price pinned 173–174,
auction cleared 176.**

**A seller was working an order. When they finished, the pressure released.**

---

# Reading a session as a story

**Ask these in order:**

```
1. Is there a level that never trades?              -> the ceiling
2. Is the offer stepping down without trading?      -> a walk-down
3. What is sitting beneath it?
     large bid   -> they are buying, price will stop there
     nothing     -> they are selling, it keeps going
4. How many shares are trapped above the price?     -> how long it stays capped
5. Has a new offer appeared BELOW a static wall?    -> they are finishing
6. On the last big up-day, what was the buy/sell ratio?
     >= 5  -> accumulation, follow
     ~ 1.0 -> distribution, stay out
```

---

# What this cannot do

**It cannot prove intent.** There are no participant IDs in this data. A pension
fund rebalancing and a coordinated campaign leave the same footprint.

**What is measured is the footprint. The animal is inferred.**

**And the inference has been wrong.** The same walk-down meant distribution on
17 August and accumulation on 18 August — the tactic is neutral, only the bid
beneath it carries the meaning.

- [ ] **Never state intent as fact.** Say "this shape is consistent with X",
      and name the test that would falsify it.
- [ ] **The trader's own reading has been right more often than the model's.**
      When they say "that wall looks placed", check it — three times this week
      that instinct preceded the measurement.

---

# The uncomfortable part

**These tactics work because they are aimed at people like the account being
traded here.**

**A 4,000-share order cannot move a level, cannot absorb a wall, and cannot wait
out a campaign. The only advantages are being invisible and being free to stand
aside.**

- [ ] **The best use of this skill is usually to not trade.** Recognising a
      distribution phase is worth more than trading it well.
