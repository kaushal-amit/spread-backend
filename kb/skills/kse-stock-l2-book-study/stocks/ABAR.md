# ABAR — book study

**Burgan Company for Well Drilling, Trading and Maintenance K.S.C.**

| | |
|---|---|
| Sessions observed | **2** — 16, 17 August 2026 |
| Snapshots | 189 on 17 Aug, ten levels |
| Price band | 175 (4 Aug low) → 231 (16 Aug high) |
| Sample strength | **two sessions of a live campaign. Provisional.** |

---

## The campaign — traced across 16 sessions

**This stock was accumulated, marked up, and is being distributed. The whole
sequence is visible in the data.**

| Phase | Dates | Price | Buy/sell | What happened |
|-------|-------|-------|----------|---------------|
| **Base** | 26 Jul – 6 Aug | 181–189 | mixed | 12 sessions of nothing. **Low 175 on 4 Aug** |
| **LOAD** | **9 Aug** | 185 → 194 | **9.48 : 1** | **1,687,220 bought vs 177,915 sold.** Trades 34 → 154, volume 7× |
| Hold | 11–13 Aug | pinned 189–190 | 1.03 | stopped buying, let it sit |
| **MARKUP** | **16 Aug** | gapped **220**, high **231** | **1.06** | **12.9 M shares. Buying and selling nearly EQUAL on the biggest up day** |
| **DISTRIBUTE** | 17 Aug | 216–230 | 1.27 | walls walking down |

**The tell is 16 August: on a +15% day the buy/sell ratio was 1.06.**

**They gapped it up and sold into their own move.**

**Their position: roughly 1.7 M shares bought near 188, sold at 220–230. About
40 fils on 1.7 million — in the region of 68,000 KD.**

---

## The wall structure — 17 August, 189 snapshots

| Price | Snapshots present | Peak size | Traded at or above | Verdict |
|-------|-------------------|-----------|--------------------|---------|
| 223 | 1 | 161,951 | 267,937 | **DEMOLISHED** |
| **227** | 7 | **407,175** | **2,432,434** | **DEMOLISHED** |
| 229 | 82 | 321,055 | 1,201,565 | partly eaten |
| **230** | **188 of 189** | **679,964** | 354,652 | **NEVER BREACHED** |
| 233 | 165 | 237,800 | none | standing |
| **238** | 32 | 248,807 | **none** | **CANCELLED** |
| **239** | **8** | **1,076,266** | **none** | **CANCELLED — pure display** |

### Two different kinds of wall

**REAL supply gets traded through.** 227 held 407,175 and 2.4 million shares went
through it. 223 the same.

**DISPLAY walls never trade.** **1,076,266 shares appeared at 239 at 10:02 and
vanished by 10:26 without a single execution.** It was posted while price was
near 230 to kill any expectation of a breakout, then removed once the threat
passed.

- [ ] **The test is the same one from `kse-book-depth-signal`: did volume move
      when the size disappeared?** No volume means it was never real.

### 230 is the ceiling

**Present in 188 of 189 snapshots. Peak 679,964. Only 354,652 traded at or above
it all session.** Nothing gets past 230.

---

## The walls walk DOWN — the distribution signature

**First appearance of each wall, 17 August:**

```
09:30   230, 233, 234
10:01   238, 239        <- defensive display, gone by 10:32
10:42   228             <- 218,355
10:45   226             <- 256,699
11:05   225             <- 315,300
```

**They lowered their selling price from 239 to 225 in ninety minutes.**

**A wall walking down is not support being tested. It is a seller accepting less
in order to get out faster.**

---

## The undercut — how it ends

**The 225 wall stayed static at ~315,000 and was never traded. Meanwhile a
SECOND seller appeared beneath it:**

| Time | 224 | 225 |
|------|-----|-----|
| 11:19:09 | **nothing** | 314,928 |
| 11:19:39 | 1,000 | 314,928 |
| 11:21:39 | 20,000 | 314,928 |
| 11:22:39 | 30,000 | 314,928 |
| **11:26:39** | **85,000** | 320,699 |

**The 225 stack never moved. The 224 offer built from zero to 85,000 in seven
minutes.**

**That is new money undercutting the wall — sellers competing with each other to
get out first.**

**Once that starts, the auction hope is gone.** They are racing down, not waiting
for a higher clearing price.

- [ ] **A new offer level appearing BELOW a static wall is the strongest exit
      signal found so far.**

---

## And no hidden buyer appeared

**The obvious alternative reading is that the wall is a spoof to frighten holders
into selling cheap, so the placer can accumulate.**

**That did not happen here.** As price fell from 225 to 223 the bid collapsed to
**twenty shares** — nobody was catching it.

- [ ] **Distinguish the two: a spoof-to-accumulate shows a large bid appearing as
      price falls. A spoof-to-distribute shows no bid at all.**

---

## Auction behaviour

| Day | Continuous close | Auction / TAL | Change |
|-----|------------------|---------------|--------|
| 11 Aug | 190 | 190 | 0 |
| 12 Aug | 189 | 188 | −1 |
| **13 Aug** | **189** | **194** | **+5** |
| 16 Aug | 217 | 218 | +1 |

**On 13 August the auction moved it five fils and nearly doubled the day's volume
— 998,073 to 1,916,865, with 918,792 shares clearing in the auction alone.**

**2 of 4 up, average +1.25. Small sample, but this stock's auction can carry real
size.**

---

## The book, for a 3,350-share order

**17 August medians: bid ~40,000–60,000, offer ~30,000–50,000.**

**Both sides workable. 47% of the session had entry and exit simultaneously
available — 101 of 215 minutes.**

**Compare PHC: 1 tradeable minute of 322.**

**At 225 fils a 785 KD order is 3,300 shares. One fil nets −0.11. Two fils nets
+3.19. This stock requires a 2-fil target.**

---

## Circuit breakers

**ABAR tripped `CB Auction` on 16 August at 09:00–09:01, clearing at 213.**

**Routine — 28 CB events occurred across 20 symbols in six sessions.** One event
at the open is noise; GINS tripped it on 5 of 6 days and that is genuine
volatility.

---

## Open questions

- **Do they have stock left?** The 230 wall persisting suggests yes. Unknown how
  much.
- **Does the 218 shelf hold?** 187,503 bid there on 17 Aug — the first real
  support below the action.
- **Does the walk-down pattern repeat on the next markup?** One campaign observed.

---

## Trading implication

**ABAR is genuinely tradeable at this budget — the book is workable both sides,
unlike PHC or TIJARA.**

**But 16–17 August was the distribution phase of someone else's campaign. Buying
into a walk-down means buying what they are selling.**

**What to wait for:**

```
Walls stop walking down
230 either breaks or the stock settles into a range
Buy/sell ratio recovers above 1.5 on rising price
```

**And the immediate exit rule, which cost real money to learn:**

```
A new offer level appearing BELOW a static wall  ->  OUT
Bid beneath the position under 20,000            ->  OUT
```

**On 17 August both fired within seven minutes of each other.**
