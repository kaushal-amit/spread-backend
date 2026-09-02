# TIJARA — book study

**Tijara & Real Estate Investment Company K.S.C.P.**

| | |
|---|---|
| Sessions observed | **1** — 13 August 2026 |
| Snapshots | 444, ten levels |
| Price band that session | 172 – 176 |
| Sample strength | **one session. Nothing here gates anything.** |

---

## Participants

**Trade size says institutional.**

| Hour | Shares | Trades | **Avg size** |
|------|--------|--------|--------------|
| 09:00 | 2,330,846 | 132 | 17,658 |
| 10:00 | 205,330 | 22 | 9,333 |
| **11:00** | **1,747,958** | **36** | **48,554** |
| 12:00 | 1,322,194 | 50 | 26,444 |

**The 11:00 hour is the tell — 36 trades moving 1.75M shares.** That is one or
two large orders being worked, not retail flow.

**Median bid across the week: 1,462,666 shares.** A 4,400-share order is 0.3% of
a level. **You are invisible here, which is the only advantage a small account
has.**

---

## The book

**Level 1, full session:**

| | Bid | Offer |
|---|---|---|
| Typical | 300,000 – 450,000 | 50,000 – 250,000 |
| Extremes seen | 30 to 487,421 | 2,493 to 1,048,116 |

**The bid is usually much deeper than the offer.** Session average ratio ran 8:1
to 29:1.

---

## Walls

**Three appeared, at 174, 175 and 176.**

| Time | Price | Size | **Traded or cancelled?** |
|------|-------|------|--------------------------|
| 09:36–09:44 | 175 | **1,048,116** | **CANCELLED — no volume** |
| 09:47 | 175 | 40,000 | **CANCELLED** |
| 11:56 | 175 | 495,000 | **TRADED** |
| 12:14 | 176 | 238,168 | held, then withdrawn |
| 12:37 | 174 | 250,738 | held |

**The 09:44 event is the important one.**

```
09:41   offer 1,048,116 · volume 2,209,405 · trades 126
09:43   offer 1,048,116 · volume 2,263,346 · trades 129
09:44   offer    97,671 · volume 2,263,346 · trades 129
                          ↑ unchanged      ↑ unchanged
```

**950,445 shares withdrawn without a single one trading.**

**Reading:** a seller with over a million shares posted the whole lot, found no
buyer at that size, and cancelled to hide it. **They then sold 205,000 directly
into the bid at 174 at 09:49** — accepting a worse price to get filled.

**They were stuck, not blocking.**

---

## Buyers per seller

**By hour, level 1:**

| Hour | Avg bid | Avg offer | **Ratio** | Price |
|------|---------|-----------|-----------|-------|
| 09:00 | 181,194 | 212,758 | 8.0 | 173.4 |
| 10:00 | 274,637 | 88,614 | 5.3 | 173.2 |
| 11:00 | 351,360 | 55,320 | 10.5 | 174.0 |
| **12:00** | **407,347** | 66,517 | **28.8** | 173.7 |
| 13:00 | 150,000 | 14,813 | 10.1 | 173.0 |

**Demand more than doubled while supply fell 70% and the price did not move.**

**Outcome by band, 443 snapshots:**

| Ratio | Snapshots | Up | Down |
|-------|-----------|----|----|
| **8 or more** | 153 | **6** | **0** |
| 4 – 8 | 96 | 2 | 2 |
| 1 – 4 | 141 | 2 | 3 |
| **under 1** | 53 | **1** | **9** |

**Note: six up-moves is a very small number.** Six coin flips land the same way
1 time in 64.

---

## Recovery

**The bid collapses and rebuilds fast.**

| Time | Bid | |
|------|-----|---|
| 09:50 | **1,000** | collapsed |
| 09:51 | **398,095** | rebuilt in one minute |
| 12:16 | 30 | collapsed |
| 12:17 | **487,421** | rebuilt in one minute |

**Both collapses recovered within 60 seconds.** Support here is not fragile — it
is withdrawn and re-posted, which is a different thing.

---

## Auction

| Date | 12:59 bid | Auction | Difference |
|------|-----------|---------|------------|
| **13 Aug** | 173 | **176** | **+3** |
| 9 Aug | 167 | **159** | **−8** |

**Two observations, opposite directions.**

**On 13 August the auction is where the day's compression released** — demand had
built all session with nowhere to go, and cleared four fils above the last bid.

**On 9 August it cleared eight fils below on 849,788 shares.** That single print
made a flat stock look like the day's third-best opportunity in the screen, and
is why `range_trading_only` exists.

---

## Tiny prints

**16% of price moves came from trades of 100 shares or fewer** — clean by the
20% threshold.

**No clustering at a single level was detected.** Unlike ARABREC on 11 August,
where all the painting sat at the intended exit price.

---

## Open questions

- **Do the walls return to the same prices?** 174, 175, 176 all saw one. One
  session cannot distinguish a fixed level from coincidence.
- **Is the 09:44 cancel-and-work pattern habitual?** If a large seller works this
  stock regularly it should recur within ten sessions.
- **Does the compression → auction release repeat?** One instance.
- **Same participant on both sides?** **Unanswerable from this data — there are
  no participant IDs.** The behaviour is consistent with one party but that is
  not evidence.

---

## Trading implication

**At 790 KD you are 0.3% of a level here. TIJARA fails Gate 6 on queue depth and
is not a trading candidate at this budget.**

**It is captured as the control symbol** — CR-37's buyers-per-seller rule was
derived from this book and needs continued validation on it.

**If it ever becomes tradeable:** the entry is when the ratio is 8 or better with
the offer under 30,000, and the exit is the auction rather than the intraday
tape. **A cancelled wall means the price stays capped until that seller is
finished, and the auction is where you find out that they are.**
