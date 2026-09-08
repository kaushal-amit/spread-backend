/**
 * /budget and /sizing — the gate that was reading a wrong number.
 *
 * YOUR % sized from the WHOLE budget. With one position open it was wrong on
 * every other symbol, and it is a gate.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('sizing');
const express = require('express'); const http = require('http');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const gateStore = require('../src/services/gateStore');
// C-15 · the budget is the gate store's slot, not public.app_config.
const setBudget = (kd) => gateStore.save({ 'session-budget': kd }, { changedBy: 'sizing.test' });
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

// The session accountSummary() reads.
const { toDay } = require('../src/lib/day');
const { SESSION } = require('../src/config/spread.config');
const DAY = toDay(new Date(Date.now() + SESSION.timezoneOffsetHours * 3600000));

(async () => {
  const app = express(); app.use(express.json());
  app.use('/api', require('../src/api/sizing').build());
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(8898, r));
  const get = (u) => fetch('http://127.0.0.1:8898/api' + u).then(async (r) => ({ status: r.status, body: await r.json() }));

  /**
   * SYMBOL-scoped cleanup, never day-scoped.
   *
   * This used to delete every order_leg and cash_movement row for the day —
   * against the database DATABASE_URL happened to name. dbguard now refuses
   * anything not called *_test, and even there a suite touches only its own
   * SZTEST* symbols. committed_kd is asserted RELATIVE to the baseline read
   * first, so a leg left by another suite cannot make the number look
   * arbitrary.
   */
  const clean = async () => {
    await fx.clearLegs('SZTEST');
    for (const sym of ['SZTEST', 'SZTESTPOS']) await fx.instrument(sym);
    await gateStore.load();
  };


  try {
    await clean();
    await setBudget(720);

    console.log('\n=== the derived constants follow the SCHEDULE ===');
    const b0 = await get('/budget');
    chk('/budget answers', b0.status === 200, b0.body);
    chk('min_position_kd = commission_min / rate = 333',
        b0.body.min_position_kd === 333, b0.body.min_position_kd);
    chk('max_price_fils = 1 / (2 x rate) = 333 — the 2 is the two SIDES of the trip',
        b0.body.max_price_fils === 333, b0.body.max_price_fils);

    console.log('\n=== free = budget - reserve - committed ===');
    const base = b0.body.committed_kd;
    chk('committed is a number', Number.isFinite(base), b0.body.committed_kd);
    chk('free = budget - reserve - committed',
        Math.abs(b0.body.free_kd - (720 - b0.body.reserve_kd - base)) < 0.01, b0.body);

    console.log('\n=== THE CASE THAT MUST WORK ===');
    // long MRC at 201, 704 KD committed, budget 720 -> 2000
    // spread.order_leg, NOT public.position: nothing writes that table and the
    // lint forbids this codebase from doing so. accountSummary() counts a BUY
    // that is FILLED and has no matching FILLED SELL.
    // spread.symbol is gone — order_leg's foreign key to it went with it, and
    // public.instruments is the canonical list. These inserts existed only to
    // satisfy that constraint.
    await pool.query(
      `INSERT INTO spread.order_leg
         (trading_day, symbol, contract_seq, side, status, price_fils, shares,
          filled_shares, posted_at)
       VALUES ($1, 'SZTESTPOS', 1, 'BUY', 'FILLED', 201, 3502, 3502, now())`, [DAY]);
    const b1 = await get('/budget');
    const committed = b1.body.committed_kd;
    chk('committed is the money spent', Math.abs(committed - base - 703.9) < 1, committed);
    chk('free excludes it', b1.body.free_kd < 720 - committed + 1, b1.body.free_kd);

    await setBudget(2000);
    const b2 = await get('/budget');
    chk('the budget changed', b2.body.budget_kd === 2000, b2.body.budget_kd);
    chk('committed is UNCHANGED — the money is spent',
        Math.abs(b2.body.committed_kd - committed) < 0.001, [committed, b2.body.committed_kd]);
    chk('free is RECOMPUTED', b2.body.free_kd > b1.body.free_kd, [b1.body.free_kd, b2.body.free_kd]);
    const { rows: still } = await pool.query(
      `SELECT shares, price_fils FROM spread.order_leg
        WHERE symbol = 'SZTESTPOS' AND side = 'BUY' AND status = 'FILLED'`);
    chk('the position is INTACT — recompute, never reset', still.length === 1, still);
    chk('and its size is unchanged', still.length && Number(still[0].shares) === 3502, still[0]);

    console.log('\n=== the bug: sizing from the ALLOCATION, not the total ===');
    await fx.depthLevel('SZTEST', { bid: 200, bidQty: 100000, offer: 201, offerQty: 90000 });
    const s1 = await get('/sizing/SZTEST');
    chk('/sizing answers', s1.status === 200, s1.body);
    chk('it sizes from free_kd, NOT the budget',
        s1.body.basis.sized_from === 'free_kd' && s1.body.basis.free_kd < s1.body.basis.budget_kd,
        s1.body.basis);
    chk('and the basis shows committed, so a wrong figure is traceable',
        Math.abs(s1.body.basis.committed_kd - committed) < 0.001, s1.body.basis);
    chk('suggested never exceeds free',
        s1.body.suggested_kd === null || s1.body.suggested_kd <= s1.body.basis.free_kd + 0.01, s1.body);

    console.log('\n=== floor and ceiling ===');
    chk('floor is at least min_position_kd',
        s1.body.floor_kd >= 333, s1.body.floor_kd);
    chk('ceiling respects the exit-depth rule',
        s1.body.ceiling_kd <= (90000 / 3 * 200) / 1000 + 0.01, s1.body.ceiling_kd);
    chk('your_pct is a share of the BID, not of the budget',
        s1.body.your_pct === null || s1.body.your_pct <= 30.01, s1.body.your_pct);

    console.log('\n=== the structural gates ===');
    await fx.setDepthBid('SZTEST', 75);
    const low = await get('/sizing/SZTEST');
    chk('below 100 fils is refused', low.body.reachable === false, low.body.reasons);
    chk('and the reason is the tick band', /tick/.test((low.body.reasons || []).join(' ')), low.body.reasons);

    await fx.setDepthBid('SZTEST', 400);
    const high = await get('/sizing/SZTEST');
    chk('above 333 fils is refused', high.body.reachable === false, high.body.reasons);
    chk('and says one fil does not clear the trip',
        /does not clear/.test((high.body.reasons || []).join(' ')), high.body.reasons);

    console.log('\n=== a missing threshold FAILS, it does not default ===');
    // The resolver prefers spread.kb_threshold once it exists, so deleting
    // from public.* no longer proves anything — it reads the other table and
    // passes. The test must follow the resolver.
    // 016 seeds spread.kb_threshold, and the resolver reads only that table.
    const TBL = 'spread.kb_threshold';
    const saved = (await pool.query(`SELECT value FROM ${TBL} WHERE key='my_pct_max'`)).rows[0];
    if (saved) {
      await pool.query(`DELETE FROM ${TBL} WHERE key='my_pct_max'`);
      const broke = await get('/budget');
      chk('a missing key is refused, not defaulted', broke.status >= 400, broke.status);
      await pool.query(
        `INSERT INTO ${TBL} (key,value,unit,source_cr) VALUES ('my_pct_max',$1,'percent','CR-48')`,
        [saved.value]);
    } else {
      chk('kb_threshold is seeded', false, 'my_pct_max absent — migration 016 seeds it');
    }

    console.log('\n=== A2 · the session budget is the only source; absent → 503 ===');
    await fx.setDepthBid('SZTEST', 200);
    await setBudget(700); await gateStore.load();
    const at700 = await get('/sizing/SZTEST');
    await setBudget(2000); await gateStore.load();
    const at2000 = await get('/sizing/SZTEST');
    chk('PUT session-budget 2000 → /sizing sizes from 2,000, not 700',
        at2000.status === 200 && at2000.body.basis.budget_kd === 2000 && at700.body.basis.budget_kd === 700,
        { b2000: at2000.body?.basis?.budget_kd, b700: at700.body?.basis?.budget_kd });
    chk('  and more capital → a larger free base', at2000.body.basis.free_kd > at700.body.basis.free_kd,
        { f2000: at2000.body?.basis?.free_kd, f700: at700.body?.basis?.free_kd });
    // No budget row at all → 503 NOT_READY, never a number. A gate_config version
    // with no session-budget is the "operator never set one" state.
    await pool.query(
      `INSERT INTO spread.gate_config (version, config, changed_by)
       VALUES ((SELECT COALESCE(max(version),0)+1 FROM spread.gate_config), '{}'::jsonb, 'a2.test');`);
    await gateStore.load();
    const none = await get('/sizing/SZTEST');
    chk('no budget → 503 NOT_READY, never a number', none.status === 503 && none.body.code === 'NOT_READY', none);
    const noneBudget = await get('/budget');
    chk('  /budget too', noneBudget.status === 503 && noneBudget.body.code === 'NOT_READY', noneBudget.status);
    await setBudget(2000); await gateStore.load(); // restore for anything after
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }

  await fx.clearDepth('SZTEST').catch(() => {});
  await clean().catch(() => {});
  srv.close(); await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
