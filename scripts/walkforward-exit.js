#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 *  walkforward-exit.js — A1, Item 1: re-measure the exit target at the 12:45 bid
 * ============================================================================
 * The +168.6 KD "hold to close" figure was NOT measured at the 12:45 touch bid;
 * the close averages ~2.34 fils above it. This script re-runs the walk-forward
 * over the captured quote history with the exit priced at the 12:45 TOUCH BID
 * (not the close, not the auction), so the target change is decided on the price
 * the operator could actually hit.
 *
 * HARD RULE (A1): the target changes only if 5-fil / hold beats 2-fil at the
 * 12:45 bid at 2,000 KD. If a different target wins, THAT is the value to seed —
 * update the exit_target_normal_fils kb row (migration 028) and say so in the
 * note. Run it, don't guess it.
 *
 *   node scripts/walkforward-exit.js [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Requires the real captured history (kse). On kse_test there are no captures,
 * so the script reports "insufficient data" and changes nothing — A1 stops there
 * and the delivery note says why.
 *
 * Model, stated plainly (kept simple on purpose, so the number is defensible):
 *   • entry  = the first touch bid at/after 09:30 on the day, per symbol that
 *              had a screenable morning (a real fill model is out of scope here;
 *              this measures the EXIT, holding entry constant across targets).
 *   • for each target T in {2,3,4,5} fils: exit at the first 12:45-or-earlier
 *              capture whose bid >= entry + T; else HOLD to the 12:45 touch bid.
 *   • net    = (exit_bid - entry) * shares / 1000 - round-trip commission
 *              (commission.js — never a literal; it changes 1 Oct).
 *   • shares = floor(budget / (entry/1000) / lot) * lot, at 700 / 2,000 / 5,000.
 * ============================================================================
 */
const { pool } = require('../src/db');
const commission = require('../src/lib/commission');
const pricing = require('../src/lib/pricing');

const BUDGETS = [700, 2000, 5000];
const TARGETS = [2, 3, 4, 5];
const LOT = 100;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function tradingDays(from, to) {
  const { rows } = await pool.query(
    `SELECT DISTINCT trading_date::text AS d
       FROM public.awsat_market_quotes
      WHERE ($1::date IS NULL OR trading_date >= $1::date)
        AND ($2::date IS NULL OR trading_date <= $2::date)
      ORDER BY d;`, [from || null, to || null]);
  return rows.map((r) => r.d);
}

/** For one day: entry (first touch bid at/after 09:30), the 12:45 bid, and the
 *  per-target exit bid (first capture whose bid >= entry+T by 12:45). */
async function daySymbols(day) {
  const { rows } = await pool.query(
    `WITH q AS (
       SELECT symbol,
              (created_at AT TIME ZONE 'Asia/Kuwait')::time AS kt,
              bid::numeric AS bid
         FROM public.awsat_market_quotes
        WHERE trading_date = $1::date AND session IN ('Trading','CB Auction')
          AND bid IS NOT NULL AND bid > 0
     )
     SELECT symbol,
            (SELECT bid FROM q q2 WHERE q2.symbol = q.symbol AND q2.kt >= time '09:30' ORDER BY q2.kt LIMIT 1) AS entry_bid,
            (SELECT bid FROM q q3 WHERE q3.symbol = q.symbol AND q3.kt <= time '12:45' ORDER BY q3.kt DESC LIMIT 1) AS bid_1245
       FROM q GROUP BY symbol;`, [day]).catch(() => ({ rows: [] }));
  const out = [];
  for (const r of rows) {
    if (r.entry_bid == null || r.bid_1245 == null) continue;
    const entry = Number(r.entry_bid);
    const exitByTarget = {};
    for (const T of TARGETS) {
      const { rows: [hit] } = await pool.query(
        `SELECT bid::numeric AS bid
           FROM public.awsat_market_quotes
          WHERE symbol = $1 AND trading_date = $2::date
            AND (created_at AT TIME ZONE 'Asia/Kuwait')::time <= time '12:45'
            AND bid >= $3 ORDER BY created_at LIMIT 1;`, [r.symbol, day, entry + T]);
      exitByTarget[T] = hit ? Number(hit.bid) : Number(r.bid_1245); // HOLD to the 12:45 bid
    }
    out.push({ symbol: r.symbol, entry, bid1245: Number(r.bid_1245), exitByTarget });
  }
  return out;
}

function netKd(entry, exitBid, budgetKd) {
  const shares = Math.floor((budgetKd / (entry / 1000)) / LOT) * LOT;
  if (shares <= 0) return null;
  const entryNotional = (entry * shares) / 1000;
  const exitNotional = (exitBid * shares) / 1000;
  const rt = commission.roundTripKd(entryNotional, exitNotional).kd; // both sides, per execution
  return ((exitBid - entry) * shares) / 1000 - rt;
}

(async () => {
  const from = arg('--from', null), to = arg('--to', null);
  const days = await tradingDays(from, to);
  if (!days.length) {
    console.log('insufficient data — no captured quote history in this database. ' +
      'A1 stops here; run against kse. Nothing changed.');
    await pool.end();
    process.exit(0);
  }
  // rows[budget][target] = { netKd, n }
  const acc = {};
  for (const b of BUDGETS) { acc[b] = {}; for (const T of TARGETS) acc[b][T] = { net: 0, n: 0 }; acc[b].hold = { net: 0, n: 0 }; }
  let symDays = 0;
  for (const day of days) {
    const syms = await daySymbols(day);
    for (const s of syms) {
      symDays += 1;
      for (const b of BUDGETS) {
        for (const T of TARGETS) {
          const net = netKd(s.entry, s.exitByTarget[T], b);
          if (net != null) { acc[b][T].net += net; acc[b][T].n += 1; }
        }
        const held = netKd(s.entry, s.bid1245, b); // pure hold-to-12:45
        if (held != null) { acc[b].hold.net += held; acc[b].hold.n += 1; }
      }
    }
  }

  if (symDays < 20) {
    console.log(`insufficient data — only ${symDays} symbol-days with a 09:30 entry bid and a 12:45 bid ` +
      `across ${days.length} session(s). A1 needs the real captured history (kse); it stops here and nothing changed.`);
    await pool.end();
    process.exit(0);
  }

  console.log(`\nwalk-forward exit @ the 12:45 touch bid — ${days.length} sessions, ${symDays} symbol-days\n`);
  const pad = (s, w) => String(s).padStart(w);
  console.log(pad('budget', 8) + TARGETS.map((T) => pad(`+${T}f`, 12)).join('') + pad('hold12:45', 14));
  for (const b of BUDGETS) {
    let line = pad(b + 'KD', 8);
    for (const T of TARGETS) line += pad(acc[b][T].net.toFixed(1) + 'KD', 12);
    line += pad(acc[b].hold.net.toFixed(1) + 'KD', 14);
    console.log(line);
  }
  // The A1 decision, printed so the note can quote it.
  const at2000 = acc[2000];
  const t5 = at2000[5].net, t2 = at2000[2].net;
  console.log(`\nA1 decision @ 2,000 KD: +5f/hold = ${t5.toFixed(1)}KD vs +2f = ${t2.toFixed(1)}KD → ` +
    (t5 > t2 ? 'SEED THE WINNER (update exit_target_normal_fils to the best-net target)' :
      'KEEP 2 — 5-fil/hold does not beat 2-fil at the 12:45 bid'));
  console.log('(this script measures the exit only; entry is held constant across targets by design.)');
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
