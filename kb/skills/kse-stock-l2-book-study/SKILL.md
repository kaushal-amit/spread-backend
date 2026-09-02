---
name: kse-stock-l2-book-study
description: Per-stock order book behaviour files for Boursa Kuwait. Read the relevant stock file before any entry, exit, or hold decision on that symbol, when asked what a stock "usually does", when a book looks unusual, or when deciding which symbol to trade. Each file records that stock's own structure — who works it, where the walls sit, how the bid rebuilds, what the auction does — separately from every other stock, because each is controlled by different participants with different habits.
---

# Per-stock L2 book study

**Premise:** each Boursa Kuwait stock is worked by a small number of
participants, and people repeat what has worked for them. **The habits are the
edge.** A pattern learned on TIJARA says nothing about ARABREC — they are
different people.

**So each stock gets its own file** in `stocks/`, and nothing generalises between
them without being separately measured.

---

## How to use this

**Before any decision on a symbol, read `stocks/<SYMBOL>.md`.**

If no file exists, say so plainly — *"no book study for this symbol yet"* — and
fall back to the funnel. **Do not import another stock's pattern.**

**Every file states its sample size.** A finding from one session is labelled as
such and does not gate anything.

---

## What goes in a stock file

Only things that are **structural** — properties of how the book is built and who
works it. **Never price predictions.**

| Record | Do not record |
|--------|---------------|
| typical bid and offer depth | "bounces at 172" |
| where walls appear and whether they repeat | today's wall price |
| whether walls are traded or cancelled | — |
| how fast the bid rebuilds after a collapse | a specific support level |
| buyers-per-seller by hour | tomorrow's direction |
| auction versus the 12:59 bid | the next clearing price |
| peak activity hour | — |
| tiny-print clustering by price level | — |

**Four rules built from single price cases have been reversed in this project** —
the trend filter, the spike gate, the trade-count floor, and position-in-range.
**All four were predictions. None were structure.**

---

## The file template

Copy `stocks/_TEMPLATE.md` when starting a new symbol.

```
# <SYMBOL> — book study
Sessions observed · date range · total snapshots

## Participants
What the size distribution suggests about who trades it.

## The book
Bid and offer percentiles. Typical, not median alone.

## Walls
Size, price levels, and CRITICALLY: traded or cancelled?

## Buyers per seller
By hour. Does the ratio climb, fall, or hold?

## Recovery
Time for the bid to rebuild after a collapse over 70%.

## Auction
Clearing price versus the 12:59 bid, every session.

## Tiny prints
Which price levels get painted, if any.

## Open questions
What has not been measured yet.

## Trading implication
One paragraph. What this means for a 4,000-share order.
```

---

## The distinction that decides whether a wall matters

**A large offer that gets TRADED is real supply being absorbed.**

**A large offer that gets CANCELLED with no volume is a seller hiding, not
leaving.**

```sql
-- the test
offer_qty drops sharply
AND volume unchanged   -->  CANCELLED
AND volume moved       -->  TRADED
```

**This is the single most useful thing in the whole study.** On TIJARA,
13 August, 950,445 shares were cancelled at 09:44 with zero volume — and the
price stayed capped for four more hours while that seller worked the order in
pieces.

**When the seller finished, the auction cleared four fils above the last bid.**

## Three wall behaviours, and what each means

**Measured on ABAR, 17 August, 189 snapshots:**

| Behaviour | Example | Meaning |
|-----------|---------|---------|
| **TRADED THROUGH** | 227 held 407,175; **2,432,434** traded at or above | real supply, absorbed. Price continues |
| **NEVER BREACHED** | 230 held 679,964 in **188 of 189 snapshots** | the ceiling. Do not target above it |
| **CANCELLED UNTRADED** | **1,076,266 at 239**, present 10:02–10:26, **zero volume** | pure display. Posted to kill a breakout expectation, removed when the threat passed |

## Walls that walk DOWN

**A wall lowering its price is a seller accepting less to get out faster.**

**ABAR, 17 August — first appearance of each level:**

```
09:30   230, 233, 234
10:01   238, 239     <- display, gone by 10:32
10:42   228
10:45   226
11:05   225
```

**From 239 to 225 in ninety minutes.**

## The undercut — the strongest exit signal found

**When a NEW offer level appears BELOW a static wall, a second seller is
undercutting the first.**

| Time | 224 | 225 |
|------|-----|-----|
| 11:19 | **nothing** | 314,928 |
| 11:22 | 30,000 | 314,928 |
| **11:26** | **85,000** | 320,699 |

**The wall never moved. The level beneath it went from zero to 85,000 in seven
minutes.**

**Sellers are now racing each other down. Any hope of the auction clearing higher
is gone.**

- [ ] **New level below a static wall → exit immediately.**

## Spoof to accumulate, or spoof to distribute?

**Both look identical in the offer stack. The bid tells them apart.**

| | Bid as price falls |
|---|---|
| Spoof to accumulate | **large bid appears** — someone is catching it |
| Spoof to distribute | **bid collapses** — nobody is |

**ABAR fell 225 → 223 and the bid went to twenty shares. Nobody was buying.**

---

## Method

Run `scripts/study_symbol.sql` against a symbol with a full session of depth
data. It produces every section above except Participants, which needs judgement.

**Minimum before writing anything into a file: 100 snapshots in a session.**

**A nine-minute read of TIJARA's book once produced a directional signal with the
sign inverted.** Five observations inside a falling stretch. The full session
reversed it.

---

## Files

| Symbol | Sessions | Status |
|--------|----------|--------|
| **TIJARA** | 2 | control symbol — see `stocks/TIJARA.md` |
| **ABAR** | 2 | **full campaign traced** — see `stocks/ABAR.md` |
| ARABREC | 0 | capture pending |
| EMIRATES | 0 | capture pending |
| MARAKEZ | 0 | painted tape suspected |
| FTI | 0 | 2:1 sellers on the tape, 3.4:1 in the book |
| MRC | 0 | 40% tiny prints, 29% bid withdrawal |
| PHC | 1 | GIANT — bid 447,076, not tradeable at this budget |

**90-symbol capture begins the week of 16 August.** Files are written as sessions
accumulate, Tier 1 first.

---

# Campaign phases — read the phase before the book

**Stocks here are worked in campaigns. Each phase leaves a distinct signature,
and the LOAD and MARKUP phases look identical on a price chart.**

| Phase | Signature | Action |
|-------|-----------|--------|
| Base | flat, low volume, weeks | wait |
| **LOAD** | **buy/sell >= 5, trades 3x baseline** | **BUY alongside them** |
| Hold | price pinned, volume churns | hold |
| **MARKUP** | gap up, **buy/sell near 1.0** | **they are SELLING into it** |
| Distribute | walls walk down, undercuts appear | stay out |

**The separator is the buy/sell ratio, from print location.**

## ABAR, the reference campaign

| Phase | Date | Price | Buy/sell |
|-------|------|-------|----------|
| **LOAD** | 9 Aug | 185 to 194 | **9.48** |
| Hold | 11-13 Aug | pinned 189-190 | 1.03 |
| **MARKUP** | 16 Aug | gap to 220, high 231 | **1.06 on a +15% day** |

**They traded 5,636,458 shares between 226 and 231 -- and spent two minutes at
231 and four at 230. The top was never where they sold. It made 226-229 look
cheap.**

## The trapped-holder structure

**After a markup, the levels between the last price and the ceiling hold the
people who bought the top.**

**ABAR, 17 Aug: 508,755 shares between 225 and 230.**

**The operator will not let price rise into that, because every one of those
holders would sell and compete with them. The ceiling protects their remaining
inventory from the supply they created.**

- [ ] **After a markup, count the shares between price and the ceiling. That is
      how long the stock stays capped.**

## The one-line test before any entry

```
Was the last big up-day bought or distributed?

buy/sell >= 5 on rising price   ->  operator accumulating, follow
buy/sell near 1.0 on +5% or more ->  operator distributing, stay out
```
