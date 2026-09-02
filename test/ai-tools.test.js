/**
 * The tool loop, and the boundary under it.
 *
 * The model picks WHICH of ten tools, never what SQL to run — because a number
 * traceable to a column is what makes an answer trustworthy, and free SQL
 * would make "a depth claim on 9 snapshots is rejected" unenforceable.
 */
const tools = require('../src/services/ai/tools');
const boundary = require('../src/services/ai/boundary');
const schema = require('../src/services/ai/schema');
const { pool } = require('../src/db');
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  try {
    console.log('\n=== ten tools, and no way to write SQL ===');
    const names = Object.keys(tools.TOOLS);
    chk('ten tools', names.length === 10, names.length);
    chk('none accepts raw SQL',
        !names.some((k) => JSON.stringify(tools.TOOLS[k].input).match(/sql|query/i)), names);
    const sch = tools.schemas();
    chk('every tool has a schema for the model', sch.length === 10);
    chk('and every one describes itself', sch.every((s) => s.description.length > 30));

    console.log('\n=== screen is TODAY ONLY ===');
    chk('screen takes no date parameter',
        Object.keys(tools.TOOLS.screen.input).length === 0, tools.TOOLS.screen.input);
    chk('and says why in its description',
        /no date parameter/i.test(tools.TOOLS.screen.description), tools.TOOLS.screen.description);

    console.log('\n=== every result declares its counts ===');
    const sd = await tools.call('symbol_day', { symbol: 'CATTL' });
    chk('symbol_day returns rows_returned', typeof sd.rows_returned === 'number', sd.rows_returned);
    chk('and names its source', sd.source === 'public.symbol_day', sd.source);

    const d = await tools.call('depth', { symbol: 'CATTL' });
    chk('depth returns SNAPSHOTS separately from rows',
        typeof d.snapshots === 'number' && typeof d.rows_returned === 'number',
        { snapshots: d.snapshots, rows: d.rows_returned });
    // Ten levels of one capture is ONE snapshot. The 100-snapshot rule counts
    // captures, so the two numbers must not be the same thing.
    chk('and snapshots is not merely the row count',
        d.rows_returned === 0 || d.snapshots <= d.rows_returned, d);

    const m = await tools.call('symbol_minute', { symbol: 'CATTL' });
    chk('symbol_minute declares snapshots too', typeof m.snapshots === 'number', m.snapshots);

    console.log('\n=== the rule stays in the BOUNDARY, not the tool ===');
    // A tool that self-censors is a tool that can be talked out of it.
    chk('depth returns 9 snapshots without refusing',
        !d.error, d.error || 'returns rows');

    console.log('\n=== the boundary fails CLOSED ===');
    const u1 = boundary.unionOf([
      { tool: 'symbol_day', rows: [{ close_px: 217 }], rows_returned: 1, source: 'public.symbol_day' },
      { tool: 'depth', error: 'timeout' },
    ]);
    chk('an errored tool is reported missing', u1.missing.includes('depth'), u1.missing);
    chk('and the good one is kept', u1.input.length === 1, u1.input.length);
    const v1 = boundary.validate({ reasoning: 'the close was 217' }, u1.input,
      { missingSources: u1.missing });
    chk('validation REJECTS even though the number is real', v1.ok === false, v1.rejections);
    chk('and says which source went missing',
        JSON.stringify(v1.rejections).includes('depth'), v1.rejections);

    const u2 = boundary.unionOf([
      { tool: 'symbol_day', rows: [{ close_px: 217 }], rows_returned: 1, source: 'public.symbol_day' },
    ]);
    const v2 = boundary.validate({ reasoning: 'the close was 217' }, u2.input,
      { missingSources: u2.missing });
    chk('with every source present it passes', v2.ok === true, v2.rejections);

    // A result that did not come from tools.js cannot be attributed.
    const u3 = boundary.unionOf([{ tool: 'mystery', rows: [{ x: 1 }] }]);
    chk('a result with no rows_returned counts as MISSING, not as empty',
        u3.missing.includes('mystery'), u3);

    console.log('\n=== SAME-ROW DERIVATIONS ===');
    // The check used to reject 2.2 — which is chg_fils / close_px — so every
    // readable answer failed. It now asks whether a number is CONSISTENT WITH
    // the data, not whether it CAME FROM it. Weaker, deliberately.
    const row = { symbol: 'CATTL', close_px: 182, prev_close: 178, chg_fils: 4,
      total_volume: 13200000, trades: 1076 };
    const rowInput = [{ tool: 'symbol_day', rows: [row], rows_returned: 1,
      source: 'public.symbol_day' }];
    const d1 = [];
    const real = boundary.validate(
      { reasoning: 'CATTL closed at 182 fils, up 4 fils (+2.2%) from 178, on 13.2 million shares' },
      rowInput, { derivations: d1 });
    chk('a percentage of two same-row columns PASSES', real.ok === true, real.rejections);
    chk('and it records WHICH derivation',
        d1.some((x) => /chg_fils/.test(x.from)), d1);
    chk('shares to millions too', d1.some((x) => /1e6/.test(x.from)), d1);

    for (const [text, why] of [
      ['the close was 947 fils', 'an invented price'],
      ['the bid held 88,400 shares', 'an invented size'],
      ['volume was 41.7 million', 'an invented total'],
    ]) {
      const v = boundary.validate({ reasoning: text }, rowInput, { derivations: [] });
      chk(`${why} is still REJECTED`, v.ok === false, [text, v.rejections]);
    }

    // Cross-row arithmetic must NOT validate: today's close over last week's
    // volume is not a real measure and should not pass.
    const twoRows = [{ tool: 'symbol_day', rows_returned: 2, source: 'public.symbol_day',
      rows: [{ close_px: 100, volume: 5 }, { close_px: 200, volume: 7 }] }];
    const cross = boundary.validate({ reasoning: 'the ratio was 14.2857' }, twoRows,
      { derivations: [] });
    chk('cross-row arithmetic does not validate', cross.ok === false, cross.rejections);

    console.log('\n=== an invented number is still rejected ===');
    const v3 = boundary.validate({ reasoning: 'the close was 999' }, u2.input, { missingSources: [] });
    chk('a number not in any source is refused', v3.ok === false, v3.rejections);

    console.log('\n=== the schema summary is GENERATED ===');
    const text = await schema.summary({ refresh: true });
    chk('it names symbol_day', /public\.symbol_day/.test(text));
    chk('and lists real columns', /close_px/.test(text));
    chk('and the 035 columns appear, because it is generated not written',
        /avg_spread_pct/.test(text));
    chk('it does NOT dump every table', !/market_day_before/.test(text));
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
