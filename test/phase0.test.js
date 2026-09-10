'use strict';
/**
 * Phase 0 hardening + SPR-28 scheduler + CR-7 gate verdicts.
 *
 * No database: the reentrancy guard and the scheduler's firing logic are pure
 * timing, and CR-7 is pure funnel output. The scheduler's DB touches are driven
 * through a stub `db` and a monkey-patched stats module, so this runs under
 * `npm test` on a clean checkout with no DATABASE_URL.
 */
let p = 0, n = 0;
const ck = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL:', t, x === undefined ? '' : JSON.stringify(x)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  // ── CR-7 · a server-formatted verdict on EVERY gate ──────────────────────
  const funnel = require('../src/lib/funnel');
  const base = { priceFils: 168, close_fils: 168, orderPriceFils: 168,
    avg_trade_shares: 1500, price_moves: 12, price_moves_2plus: 6,
    pct_moves_sub100: 10, pct_moves_sub100_up: 12, pct_session_postable_800: 30,
    pct_session_exitable_ratio: 40, pct_session_exitable_size_800: 50,
    volume_ratio_5d: 1.1, flow_ratio: 0.9, block_ratio: 0.9, days_active_5d: 5,
    capture_pct: 95, change_1d_fils: 2, change_5d_fils: 5, bid_kd_p25: 20,
    gap_pct: 40, range_trading_fils: 8 };
  const r = funnel.evaluate(base, 800);
  ck('every gate carries a check', r.gates.every((g) => g.check && typeof g.check.text === 'string'),
    r.gates.filter((g) => !g.check).map((g) => g.id));
  ck('every check verdict matches the gate ok/warn',
    r.gates.every((g) => g.check.verdict === (g.check.warn ? 'WARN' : g.check.ok ? 'PASS' : g.check.computed ? 'FAIL' : 'NOT_COMPUTED')),
    r.gates.map((g) => [g.id, g.ok, g.check.verdict]));
  const g5 = r.gates.find((g) => g.id === 5).check;
  ck('a check reads "<value> <cmp> <threshold> — VERDICT"', /^10% ≤ 20% — PASS$/.test(g5.text), g5.text);
  ck('the threshold carries its unit', /%$/.test(g5.threshold), g5.threshold);

  // a gate that failed for want of a number reads NOT COMPUTED, not FAIL
  const nc = funnel.evaluate({ ...base, avg_trade_shares: null }, 800).gates.find((g) => g.id === 3).check;
  ck('a not-computed gate reads NOT COMPUTED', nc.text === 'NOT COMPUTED' && nc.computed === false, nc);

  // gate 8 is the one blocking gate: unknown baseline PASSES, and says so
  const g8 = funnel.evaluate({ ...base, volume_ratio_5d: null, flow_ratio: null, block_ratio: null }, 800)
    .gates.find((g) => g.id === 8).check;
  ck('gate 8 with no baseline reads "no baseline — PASS", not NC', /no volume baseline — PASS/.test(g8.text) && g8.ok, g8);

  // a real fail shows the losing comparison
  const g7 = r.gates.find((g) => g.id === 7).check;
  ck('a failing gate shows value vs threshold and FAIL', g7.verdict === 'FAIL' && /40% ≥ 70% — FAIL/.test(g7.text), g7.text);

  // capture too thin flips 6/7 and the check says capture, not a passing number
  const thin = funnel.evaluate({ ...base, capture_pct: 5 }, 800).gates.find((g) => g.id === 6).check;
  ck('a capture-failed gate reads the capture reason, not a passing numeric line',
    thin.verdict === 'FAIL' && /capture/i.test(thin.text) && !/≥ 20% — PASS/.test(thin.text), thin.text);

  // ── Phase 0 · the scanner reentrancy guard ───────────────────────────────
  const socket = require('../src/socket');
  let concurrent = 0, maxConcurrent = 0, completed = 0;
  const slow = socket.scanner('unit-guard', async () => {
    concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(40); concurrent -= 1; completed += 1;
  });
  slow(); slow(); slow();                 // three fired while the first is mid-flight
  await sleep(90);
  ck('the guard never lets two runs overlap', maxConcurrent === 1, maxConcurrent);
  ck('the two that arrived during a run were SKIPPED, not queued', completed === 1, completed);
  const h = socket.scannerHealth()['unit-guard'];
  ck('scannerHealth records the run and the skips', h.runs === 1 && h.skipped >= 2, h);
  ck('scannerHealth records lastSuccessAt', !!h.lastSuccessAt, h);
  // once the run finished, the next call runs (not skipped forever)
  await slow();
  ck('a later call runs once the loop is free again', socket.scannerHealth()['unit-guard'].runs === 2, socket.scannerHealth()['unit-guard']);

  // ── SPR-28 · the 13:45 scheduler firing logic (stubbed DB + stats) ────────
  const stats = require('../src/jobs/stats');
  const daily = require('../src/jobs/daily');
  const schedule = require('../src/jobs/schedule');
  const realRunDaily = stats.runDaily, realComputeDay = stats.computeDay;
  let dailyCalls = [], computeCalls = [];
  stats.runDaily = async (day) => { dailyCalls.push(day); return { rows: 1, minMinutes: 1, maxMinutes: 1, reconcileFees: { broker: 'x', adjusted: 0 } }; };
  stats.computeDay = async (day) => { computeCalls.push(day); return { rows: 1, minMinutes: 1, maxMinutes: 1 }; };
  // A stub DB: statsExist → not present; missingDays → two gap days.
  const stubDb = { query: async (sql) => {
    if (/FROM spread\.symbol_day_stats WHERE trading_day/.test(sql)) return { rows: [] };
    if (/LEFT JOIN[\s\S]*symbol_day_stats/.test(sql)) return { rows: [{ day: '2026-09-01' }, { day: '2026-08-31' }] };
    return { rows: [] };
  } };
  const handles = [];
  const startAt = (iso, extra = {}) => {
    let clock = Date.parse(iso);
    const h2 = schedule.startDailyStatsScheduler({ db: stubDb, everyMs: 10, time: '13:45',
      now: () => clock, guard: null, ...extra });
    handles.push(h2);
    return { setClock: (s) => { clock = Date.parse(s); } };
  };
  try {
    // Scenario A · start a weekday BEFORE 13:45, then cross it once.
    dailyCalls = []; computeCalls = [];
    const A = startAt('2026-09-02T05:00:00Z', { runBackfill: true });  // Kuwait Wed 08:00
    await sleep(30);
    ck('before 13:45 the daily does not fire', dailyCalls.length === 0, dailyCalls);
    ck('backfill filled the historical gap (computeDay per missing day)', computeCalls.length === 2, computeCalls);
    A.setClock('2026-09-02T10:45:00Z');                               // Kuwait Wed 13:45
    await sleep(40);
    ck('at 13:45 the daily fires exactly once', dailyCalls.length === 1 && dailyCalls[0] === daily.kuwaitDay(new Date(Date.parse('2026-09-02T10:45:00Z'))), dailyCalls);
    A.setClock('2026-09-02T10:46:00Z');                               // one minute later
    await sleep(30);
    ck('it does not re-fire the same day', dailyCalls.length === 1, dailyCalls);

    // Scenario B · a weekend never fires.
    dailyCalls = []; computeCalls = [];
    startAt('2026-09-04T10:45:00Z', { runBackfill: false });          // Kuwait Fri 13:45
    await sleep(40);
    ck('a weekend 13:45 does not fire the daily', dailyCalls.length === 0, dailyCalls);

    // Scenario C · boot AFTER 13:45 with no row → catch-up fires once at boot.
    dailyCalls = []; computeCalls = [];
    startAt('2026-09-02T11:30:00Z', { runBackfill: false });          // Kuwait Wed 14:30
    await sleep(40);
    ck('boot catch-up runs today once when the slot was missed', dailyCalls.length === 1, dailyCalls);
  } finally {
    for (const x of handles) clearInterval(x);
    stats.runDaily = realRunDaily; stats.computeDay = realComputeDay;
  }

  console.log(`\nphase0: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
}
run().catch((e) => { console.error('phase0 suite error:', e); process.exit(1); });
