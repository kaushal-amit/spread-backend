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
  // A missing input is NOT COMPUTED — never structural, never a real FAIL.
  {
    const nullGap = funnel.evaluate({ ...base, targetTicks: 2, gap_pct: null }, 800);
    const g2 = nullGap.gates.find((g) => g.id === 2);
    ck('null gap_pct → gate 2 NOT COMPUTED, not "present only 0%"', g2.notComputed === true && g2.check.verdict === 'NOT_COMPUTED' && /not computed/.test(g2.why), [g2.why, g2.check.text]);
    ck('  and NOT structural (the old code called it unfixable)', g2.structural === false && nullGap.structural === false);
    const nullPrice = funnel.evaluate({ ...base, priceFils: null, close_fils: null, orderPriceFils: null }, 800);
    const g1 = nullPrice.gates.find((g) => g.id === 1);
    ck('null price → gate 1 NOT COMPUTED (null < 100 is true in JS — was "null fils — below 100")', g1.notComputed === true && g1.structural === false && !/null fils/.test(g1.why), g1.why);
    const nullMoves = funnel.evaluate({ ...base, targetTicks: 2, price_moves_2plus: null }, 800);
    const g4 = nullMoves.gates.find((g) => g.id === 4);
    ck('null moves-of-2+ on a 2-tick target → gate 4 NOT COMPUTED', g4.notComputed === true && g4.check.verdict === 'NOT_COMPUTED', [g4.why, nullMoves.targetTicks]);
    ck('the bucket and the chip agree: every NOT_COMPUTED check is a notComputed gate',
      [nullGap, nullPrice, nullMoves].every((x) => x.gates.every((g) => (g.check.verdict === 'NOT_COMPUTED') === (g.notComputed === true))));
    const lowGap = funnel.evaluate({ ...base, targetTicks: 2, gap_pct: 10 }, 800);
    ck('a MEASURED low gap is still a structural FAIL', lowGap.gates.find((g) => g.id === 2).structural === true && lowGap.structural === true);
  }

  // ── the board's fee math is DATED and MARKET-AWARE ─────────────────────────
  {
    const g2 = (o) => funnel.evaluate({ ...base, priceFils: 200, close_fils: 200, orderPriceFils: 200 }, 700, undefined, o).gates.find((g) => g.id === 2);
    const sep = g2({ day: '2026-09-10' }), oct = g2({ day: '2026-10-01' }), prem = g2({ day: '2026-10-01', premier: true });
    ck('from 1 Oct 2026 the round trip is 1.000 KD cheaper (two settlements gone)', Number((sep.roundTripKd - oct.roundTripKd).toFixed(3)) === 1.0, [sep.roundTripKd, oct.roundTripKd]);
    ck('a Premier symbol is costed at 0.10%, not Main\'s 0.15%', prem.roundTripKd < oct.roundTripKd, [prem.roundTripKd, oct.roundTripKd]);
    ck('no day → the pre-October figure (unchanged default)', g2({}).roundTripKd === sep.roundTripKd);
  }

  // ── ONE session clock (lib/session): kb rows, not literals ────────────────
  {
    const session = require('../src/lib/session');
    const at = (h, m) => new Date(Date.UTC(2026, 8, 10, h - 3, m)); // Thu 10 Sep, Kuwait
    ck('09:30 open · 11:30 step_down · 12:30 late · 13:05 closed (closing auction, no new positions)',
      session.sessionPhase(at(9, 30)).phase === 'open' && session.sessionPhase(at(11, 30)).phase === 'step_down'
      && session.sessionPhase(at(12, 30)).phase === 'late' && session.sessionPhase(at(13, 5)).phase === 'closed'
      && session.sessionPhase(at(13, 5)).open === false && /closing auction/.test(session.sessionPhase(at(13, 5)).note));
    ck('the data window outlives the close: 13:20 dataWindow yes, 13:40 no',
      session.sessionPhase(at(13, 20)).dataWindow === true && session.sessionPhase(at(13, 40)).dataWindow === false);
    ck('minutesToStepDown counts to late_session (12:00): 30 at 11:30, 0 after',
      session.sessionPhase(at(11, 30)).minutesToStepDown === 30 && session.sessionPhase(at(12, 10)).minutesToStepDown === 0);
    ck('Friday is closed with no countdown', session.sessionPhase(new Date(Date.UTC(2026, 8, 11, 7, 0))).phase === 'closed');
    // the kb rows move the clocks — a stub db returning a 10:30 step-down
    const stub = { query: async () => ({ rows: [{ key: 'step_down_hhmm', value: 1030 }, { key: 'hard_exit_hhmm', value: 1215 }] }) };
    const c = await session.load(stub);
    ck('load() reads step_down_hhmm / hard_exit_hhmm from kb_threshold; missing keys keep the fallback',
      c.stepDownAt === 10 * 60 + 30 && c.hardExitAt === 12 * 60 + 15 && c.flatByAt === 12 * 60 + 45 && c.loadedFrom === 'kb_threshold', c);
    ck('  and the phase follows: 10:45 is now step_down', session.sessionPhase(at(10, 45)).phase === 'step_down');
    ck('  checkHardExit reads the same clock (due at 12:15)',
      require('../src/lib/orderRules').checkHardExit({ hasPosition: true, now: at(12, 16) }).due === true
      && require('../src/lib/orderRules').checkHardExit({ hasPosition: true, now: at(12, 10) }).due === false);
    await session.load({ query: async () => ({ rows: [] }) }); // back to the config fallbacks
    ck('socket.sessionPhase IS lib/session.sessionPhase', require('../src/socket').sessionPhase === session.sessionPhase);
  }

  // ── the day rolls: sockets that follow "today" move rooms ─────────────────
  {
    const mk = (day, follows) => { const joined = [], left = [], sent = []; return { data: { day, followsToday: follows }, join: (r) => joined.push(r), leave: (r) => left.push(r), emit: (ev, a) => sent.push([ev, a]), joined, left, sent }; };
    const a = mk('2026-09-09', true), b = mk('2026-09-09', false), c = mk('2026-09-10', true);
    const io = { sockets: { sockets: new Map([['a', a], ['b', b], ['c', c]]) } };
    const moved = require('../src/socket').followDay(io, '2026-09-10');
    ck('a follower of today is moved from yesterday\'s room to today\'s', moved === 1 && a.left[0] === 'day:2026-09-09' && a.joined[0] === 'day:2026-09-10' && a.data.day === '2026-09-10', [a.left, a.joined]);
    ck('  and told (spread:day)', a.sent[0] && a.sent[0][0] === 'spread:day' && a.sent[0][1].day === '2026-09-10', a.sent);
    ck('a socket that chose a date stays; one already on today is untouched', b.joined.length === 0 && c.joined.length === 0);
  }

  // ── §0 · the socket board carries an error flag when it could not compute ──
  {
    const socket = require('../src/socket');
    const routes = require('../src/api/routes');
    const realBoard = routes.board;
    routes.board = async () => { throw Object.assign(new Error('db down'), { code: 'DB_DOWN' }); };
    const broken = await socket.view('2026-09-10', 800).catch((e) => ({ threw: e.message }));
    routes.board = realBoard;
    ck('a failing board emits error {code}, not a clean empty board', broken.error && broken.error.code === 'DB_DOWN' && broken.recommended.length === 0, broken.error);
    const noBudget = await socket.view('2026-09-10', null).catch((e) => ({ threw: e.message }));
    ck('a null budget emits NOT_READY (REST answers 503 for the same case)', noBudget.error && noBudget.error.code === 'NOT_READY', noBudget.error);
  }

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

  // ── the health is TRUTHFUL: a failing scan is recorded, an idle one is not "work" ──
  {
    let n = 0;
    const flaky = socket.scanner('unit-flaky', async () => { n += 1; if (n <= 2) throw new Error('db down'); return 'idle'; });
    await flaky(); await flaky();
    let f = socket.scannerHealth()['unit-flaky'];
    ck('a scan that throws does NOT advance lastSuccessAt', f.lastSuccessAt === null && f.errors === 2 && f.lastError === 'db down' && !!f.lastErrorAt, f);
    await flaky();
    f = socket.scannerHealth()['unit-flaky'];
    ck('a clean run advances lastSuccessAt and clears lastError', !!f.lastSuccessAt && f.lastError === null, f);
    ck('an early return (idle) is a success but not WORK: lastWorkAt stays null, idle counts', f.lastWorkAt === null && f.idle === 1, f);
    const worker = socket.scanner('unit-worker', async () => 'did something');
    await worker();
    ck('a run that did work stamps lastWorkAt', !!socket.scannerHealth()['unit-worker'].lastWorkAt);
  }

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

    // Scenario D · a skipped minute does not lose the day (due from 13:45 ONWARD).
    dailyCalls = [];
    const D = startAt('2026-09-02T10:44:00Z', { runBackfill: false });  // Kuwait 13:44
    await sleep(30);
    D.setClock('2026-09-02T10:47:00Z');                               // the 13:45 and 13:46 ticks never happened
    await sleep(40);
    ck('due from 13:45 onward: a missed minute still fires', dailyCalls.length === 1, dailyCalls);

    // Scenario E · a FAILED run is not marked done — it is retried with backoff.
    dailyCalls = [];
    let fails = 2;
    stats.runDaily = async (day) => { dailyCalls.push(day); if (fails-- > 0) throw new Error('db hiccup'); return { rows: 1, minMinutes: 1, maxMinutes: 1, reconcileFees: { broker: 'x', adjusted: 0 } }; };
    const E = startAt('2026-09-02T10:45:00Z', { runBackfill: false });
    await sleep(40);
    ck('the first attempt failed', dailyCalls.length === 1);
    E.setClock('2026-09-02T10:45:30Z'); await sleep(30);
    ck('no retry inside the 1-minute backoff', dailyCalls.length === 1, dailyCalls);
    E.setClock('2026-09-02T10:46:30Z'); await sleep(30);
    ck('retried after 1 minute (failed again)', dailyCalls.length === 2, dailyCalls);
    E.setClock('2026-09-02T10:47:30Z'); await sleep(30);
    ck('backoff doubled: no retry after 1 more minute', dailyCalls.length === 2, dailyCalls);
    E.setClock('2026-09-02T10:49:00Z'); await sleep(30);
    ck('retried after 2 minutes and succeeded', dailyCalls.length === 3, dailyCalls);
    E.setClock('2026-09-02T11:30:00Z'); await sleep(30);
    ck('once done, no further runs that day', dailyCalls.length === 3, dailyCalls);

    // Scenario H · a HOLIDAY is a skip, not a red (lib/calendar → spread.trading_day).
    dailyCalls = [];
    const holidayDb = { query: async (sql) => {
      if (/FROM spread\.trading_day WHERE trading_day/.test(sql)) return { rows: [{ is_session: false, holiday_name: 'Prophet Mohammed Birthday' }] };
      if (/FROM spread\.symbol_day_stats WHERE trading_day/.test(sql)) return { rows: [] };
      return { rows: [] };
    } };
    handles.push(schedule.startDailyStatsScheduler({ db: holidayDb, everyMs: 10, time: '13:45', now: () => Date.parse('2026-08-27T11:30:00Z'), guard: null, runBackfill: false }));
    await sleep(40);
    ck('27 Aug (a published holiday, a Thursday) past 13:45 with no row → skipped, the daily never runs', dailyCalls.length === 0, dailyCalls);

    // Scenario I · an EMPTY session day is a loud failure in runDaily, never a 0-row success.
    {
      const emptyDb = { query: async (sql) => {
        if (/count\(\*\).*FROM public\.awsat_market_quotes WHERE trading_date/.test(sql)) return { rows: [{ n: 0 }] };
        if (/FROM spread\.trading_day WHERE trading_day/.test(sql)) return { rows: [] };
        return { rows: [] };
      } };
      const stubbed = stats.runDaily; stats.runDaily = realRunDaily; // the REAL runDaily for this scenario
      let threw = null;
      try { await stats.runDaily('2026-09-09', { db: emptyDb }); } catch (e) { threw = e.message; }
      ck('runDaily on a session day with no quotes throws naming the capture defect', /capture defect/.test(threw || ''), threw);
      const holidayEmpty = { query: async (sql) => {
        if (/count\(\*\).*FROM public\.awsat_market_quotes WHERE trading_date/.test(sql)) return { rows: [{ n: 0 }] };
        if (/FROM spread\.trading_day WHERE trading_day/.test(sql)) return { rows: [{ is_session: false, holiday_name: 'Eid' }] };
        return { rows: [] };
      } };
      const sk = await stats.runDaily('2026-05-27', { db: holidayEmpty });
      ck('runDaily on a holiday with no quotes returns skipped:holiday, no throw', sk.skipped === 'holiday' && sk.rows === 0, sk);
      stats.runDaily = stubbed;
    }

    // Scenario F · done is the TABLE: a row already present → nothing runs.
    dailyCalls = [];
    const withRow = { query: async (sql) => (/FROM spread\.symbol_day_stats WHERE trading_day/.test(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] }) };
    handles.push(schedule.startDailyStatsScheduler({ db: withRow, everyMs: 10, time: '13:45', now: () => Date.parse('2026-09-02T11:30:00Z'), guard: null, runBackfill: false }));
    await sleep(40);
    ck('a day whose bridge row exists is not re-run', dailyCalls.length === 0, dailyCalls);

    // Scenario G · the 09:45 job is scheduled the same way.
    const m45 = require('../src/jobs/m45');
    const realM45 = m45.computeM45; const m45Calls = [];
    m45.computeM45 = async (day) => { m45Calls.push(day); return { computed: 3, skipped: 0, thin: 0 }; };
    let clockG = Date.parse('2026-09-02T06:40:00Z');                 // Kuwait 09:40
    handles.push(schedule.startM45Scheduler({ db: stubDb, everyMs: 10, now: () => clockG, guard: null }));
    await sleep(30);
    ck('m45: not due before 09:46', m45Calls.length === 0, m45Calls);
    clockG = Date.parse('2026-09-02T06:50:00Z');                      // Kuwait 09:50
    await sleep(40);
    ck('m45: runs once after the window closes', m45Calls.length === 1 && m45Calls[0] === '2026-09-02', m45Calls);
    m45.computeM45 = realM45;
  } finally {
    for (const x of handles) clearInterval(x);
    stats.runDaily = realRunDaily; stats.computeDay = realComputeDay;
  }

  console.log(`\nphase0: ${p}/${n}`);
  process.exit(p === n ? 0 : 1);
}
run().catch((e) => { console.error('phase0 suite error:', e); process.exit(1); });
