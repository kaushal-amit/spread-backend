---
name: kse-morning-volume-setups
description: "Corrects the economics block with the real commission structure and replaces the wrong band claim with the measured open-vs-intraday split."
---

# TWO SECTIONS REPLACED - corrected 30 Aug 2026

**Replace the existing "economics gate" section and any claim about price
bands with the two sections below. Both prior versions were wrong.**

---

# ECONOMICS - settled, no longer an open question

**The cost is known. It is a fixed fee plus a rate, which makes this a SIZE
problem, not a rate problem.**

```
roundtrip = 0.15% x 2  +  0.50 KD settlement x 2
```

| position | roundtrip cost | vs +0.400% gross |
|---|---|---|
| 712 KD | **0.44%** | **negative** |
| 1,000 KD | 0.40% | break-even |
| 2,000 KD | 0.35% | +0.05% |

**From 1 October 2026 settlement is abolished: 0.30% flat at any size,
giving +0.10%.**

- [ ] **The COAST 0.5% figure was the settlement fee, not a higher rate.
      Retire that open question - do not re-raise it.**

## What +0.10% actually pays

```
  2,000 KD x 0.10%  =  2 KD per hold
 20,000 KD nightly turnover needed for ~20 KD/night
```

**The edge is capped at +0.10%. No better entry rule raises it. Only capital
raises the absolute number.**

- [ ] **The revisit trigger is CAPITAL, not the calendar.** 2,000 KD after
      1 October with 100+ observations is enough to validate the rule and
      nowhere near enough to earn from it.
- [ ] Until then: **log and score every night. Do not trade it.**
- [ ] Setup 1 at +2.68 fils on a 200-fil stock is ~1.3% and clears every
      cost figure above. The size constraint applies to the OVERNIGHT track
      only.

---

# PRICE BANDS - the tail is not capped, and the reason matters

**Previously stated: "a -5% static band structurally caps a single overnight
gap." That was inferred from the rulebook and is WRONG as a general claim.**

**Measured from symbol_day, 30 sessions:**

| | chg_1d | gap at open | intraday |
|---|---|---|---|
| GINS 3 Aug | -40.4% | **-4.99%** | -37.29% |
| TAMINV 12 Aug | -29.9% | **-5.00%** | -26.23% |
| CATTL 24 Aug | -20.9% | -3.56% | -17.97% |
| GINS 10 Aug | -20.5% | -4.61% | -16.69% |
| TIJARA 16 Aug | -16.6% | **0.00%** | -16.57% |
| GINS 2 Aug | +125.2% | +7.32% | +109.84% |

## The mechanism

**The band binds at the OPEN. It does not cap the SESSION.**

The cluster at -4.89 / -4.90 / -4.99 / -5.00 is the -5% limit binding on the
opening auction. Intraday, the security circuit breaker fires, a two-minute
auction **sets a NEW reference price**, and the band resets against it. A
stock can therefore fall in repeated 5% steps to -37% within one session.

**There is no cumulative intraday cap.**

## What this means per strategy

- **Overnight track (buy close, sell open): exposed to the GAP only.**
  A GINS holder who bought the 2707 close and sold the 2572 open lost 4.99%
  and sat out the -37% that followed. Worst gap in 958 symbol-days: **-6.59%**.
- **Intraday setups: exposed to the uncapped side.** A -17% session on a name
  you are holding is possible and present in this sample (CATTL 24 Aug).

## The exceptions - do not treat -5% as a floor

**TIJARA gapped exactly -10.00% (main market, 3.7M shares). ALKOUT -16.84%.
ALDEERA -15.86%.** The open band is not universally -5%.

Most extreme names are micro-volume and fail the volume gate anyway - GINS
8,791 shares, TAMINV 210, ALKOUT 305, GFC 175, IPG 3,335 (Auction Market
securities). **TIJARA is the counter-example that matters: liquid, main
market, and it gapped through the band.**

## The real uncapped risk: the resumption gap

**A halt produces a gap against a stale reference with no band.** CATTL
opened **+76%** on 23 Aug against a 17 Aug close. A stock that can gap that
far up can gap that far back.

- [ ] **Never hold overnight into or out of a suspension.** Check halt status
      before any close-to-open hold.
- [ ] The sample contains one such event and therefore cannot price the risk.
      **State that this tail is unmeasured, not measured-small.**
- [ ] **A +0.10% edge does not pay for an unmeasured resumption tail.** This
      is the standing reason the overnight track is logged and not traded.