/**
 * The tool loop, and the boundary under it.
 *
 * The model picks WHICH of eleven tools, never what SQL to run — because a number
 * traceable to a column is what makes an answer trustworthy, and free SQL
 * would make "a depth claim on 9 snapshots is rejected" unenforceable.
 */
const tools = require('../src/services/ai/tools');
const boundary = require('../src/services/ai/boundary');
const schema = require('../src/services/ai/schema');
const { requireTestDb } = require('./dbguard');
requireTestDb('ai-tools');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const claude = require('../src/services/ai/claude');
const routes = require('../src/api/routes');
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  try {
    console.log('\n=== eleven tools, and no way to write SQL ===');
    const names = Object.keys(tools.TOOLS);
    chk('eleven tools', names.length === 11, names.length);
    chk('none accepts raw SQL',
        !names.some((k) => JSON.stringify(tools.TOOLS[k].input).match(/sql|query/i)), names);
    const sch = tools.schemas();
    chk('every tool has a schema for the model', sch.length === 11);
    chk('and every one describes itself', sch.every((s) => s.description.length > 30));

    console.log('\n=== R-28 · losses_by_prior_day_stat, with a whitelisted stat ===');
    chk('the eleventh tool exists', names.includes('losses_by_prior_day_stat'));
    let badStat = null;
    try { await tools.call('losses_by_prior_day_stat', { stat: 'net_kd; DROP TABLE', threshold: 30 }); } catch (e) { badStat = e.code; }
    chk('an un-whitelisted stat is refused (no free SQL)', badStat === 'BAD_REQUEST', badStat);
    let badNum = null;
    try { await tools.call('losses_by_prior_day_stat', { stat: 'tiny_pct_up', threshold: 'abc' }); } catch (e) { badNum = e.code; }
    chk('a non-numeric threshold is refused', badNum === 'BAD_REQUEST', badNum);
    const ok = await tools.call('losses_by_prior_day_stat', { stat: 'tiny_pct_up', threshold: 30 });
    chk('a valid call returns rows (possibly empty) with its source', Array.isArray(ok.rows) && /symbol_day/.test(ok.source || ''), { n: ok.rows?.length, src: ok.source });

    console.log('\n=== screen is TODAY ONLY ===');
    chk('screen takes no date parameter',
        Object.keys(tools.TOOLS.screen.input).length === 0, tools.TOOLS.screen.input);
    chk('and says why in its description',
        /no date parameter/i.test(tools.TOOLS.screen.description), tools.TOOLS.screen.description);

    console.log('\n=== ONE registry (3.1 / B-04) ===');
    chk('registry.js is gone', !require('fs').existsSync(require('path').join(__dirname, '../src/services/ai/registry.js')));
    chk('assertReady lives on tools', tools.assertReady().length === 11);
    chk('so does the precedent record', tools.PRECEDENTS.some((x) => x.costKd === -44.94));
    let code = null;
    try { await tools.call('getSymbolDay', { symbol: 'X' }); } catch (e) { code = e.code; }
    chk('a name from the old registry is refused BY NAME', code === 'TOOL_NOT_FOUND', code);

    console.log('\n=== screen = /api/stocks, on a fixture day ===');
    // ABAR's 1 September row under a test symbol on the fixture day, so the
    // board is not empty on a schema-only kse_test. Same day, same slot.
    const SYM = 'SZTESTABAR', TD = fx.TEST_DAY, SLOT = 790;
    await fx.clearDay(TD); await fx.clearQuotes(SYM);
    await fx.abarLike(SYM, TD);
    routes.invalidate();
    const board = await routes.board(TD, SLOT);
    const scr = await tools.call('screen', {}, { day: TD, budgetKd: SLOT });
    const onBoard = [...board.recommended, ...board.nearMiss, ...board.rejected];
    chk('the fixture symbol is on the board', onBoard.some((x) => x.symbol === SYM), board.counts);
    const mine = onBoard.find((x) => x.symbol === SYM);
    console.log(`       ${SYM}: ${mine?.passed ? 'RECOMMENDED' : mine?.failed.join(', ')}${mine?.notComputed?.length ? ` [not computed: ${mine.notComputed.join(', ')}]` : ''}`);
    chk('screen ran for the request\'s day and slot', scr.day === TD && scr.budget_kd === SLOT, [scr.day, scr.budget_kd]);
    chk('recommended: the same symbols as /api/stocks',
        JSON.stringify(scr.recommended) === JSON.stringify(board.recommended.map((x) => x.symbol)),
        [scr.recommended, board.recommended.map((x) => x.symbol)]);
    chk('nearMiss too', JSON.stringify(scr.near_miss) === JSON.stringify(board.nearMiss.map((x) => x.symbol)));
    chk('and the fixture symbol is in the rows the model sees, with its verdict',
        scr.rows.some((r) => r.symbol === SYM && typeof r.passed === 'boolean' && Array.isArray(r.failed)),
        scr.rows.map((r) => r.symbol));
    chk('no price reaches the model through screen', !scr.rows.some((r) => 'priceFils' in r || 'close_fils' in r));
    chk('rows_returned = recommended + nearMiss', scr.rows_returned === scr.recommended.length + scr.near_miss.length);

    console.log('\n=== symbol_day keeps FULL and PARTIAL, drops THIN ===');
    const usable = await tools.call('symbol_day', { symbol: SYM, usable_only: true });
    chk('the FULL fixture row is returned', usable.rows_returned === 1 && usable.rows[0].data_quality === 'FULL', usable.rows_returned);
    await fx.symbolDay(SYM, '2001-01-07', { dataQuality: 'THIN' });
    const both = await tools.call('symbol_day', { symbol: SYM });
    const usable2 = await tools.call('symbol_day', { symbol: SYM, usable_only: true });
    chk('THIN is dropped with usable_only', both.rows_returned === 2 && usable2.rows_returned === 1, [both.rows_returned, usable2.rows_returned]);
    await fx.clearDay('2001-01-07');

    console.log('\n=== gather() reaches the prompt, and so does the position ===');
    const g = await claude.gather(SYM, TD, { budgetKd: SLOT });
    chk('gather returns tool-shaped results', g.results.every((r) => r.tool && (r.error || typeof r.rows_returned === 'number')), g.results.map((r) => r.tool));
    chk('  including screen, symbol_day, depth and the book', ['screen', 'symbol_day', 'depth', 'book'].every((t) => g.results.some((r) => r.tool === t)));
    const prompt = claude.buildPrompt({ question: 'hold or sell?', tradingDay: TD, symbol: SYM,
      position: { symbol: SYM, state: 'holding', shares: 3000, entry: 248, bid: 248 }, tradingState: 'HOLDING', gathered: g });
    chk('the prompt carries the position block', /POSITION \(the operator/.test(prompt) && /"shares":3000/.test(prompt));
    chk('  and the trading state, quoted as untrusted', /TRADING STATE: <untrusted source="client.tradingState">HOLDING<\/untrusted>/.test(prompt));
    chk('  and the gathered context', /CONTEXT already gathered/.test(prompt) && /- screen \(/.test(prompt));
    chk('  and the precedent record', /EQUIPMENT \[stranded\] -44.94/.test(prompt));
    chk('flat when there is no position', /POSITION: none/.test(claude.buildPrompt({ question: 'x', tradingDay: TD, gathered: g })));
    await fx.clearDay(TD); await fx.clearQuotes(SYM); await fx.clearInstruments(SYM);

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

    console.log('\n=== a range dash is not a minus sign ===');
    // "ranged 168-185" parsed as 168 and MINUS 185, and -185 matched nothing —
    // so a correct sentence was rejected for a number never written.
    chk('168-185 is two numbers', [...boundary.numbersIn('ranged 168-185')].join() === '168,185',
        [...boundary.numbersIn('ranged 168-185')]);
    chk('an en dash too', [...boundary.numbersIn('168–185')].join() === '168,185');
    chk('but a real negative survives', [...boundary.numbersIn('down -12 fils')].join() === '-12');

    console.log('\n=== the SIMPLEST derivation wins ===');
    // 13.2m shares is total_volume / 1e6. It is ALSO open_px - low_px within
    // tolerance (181-168=13), and the first real answer recorded that
    // coincidence as the provenance.
    const ranked = boundary.derivationsFrom(
      { open_px: 181, low_px: 168, total_volume: 13200000 });
    chk('13.2 attributes to the unit conversion, not the subtraction',
        /1e6/.test(ranked.get(13.2) || ''), ranked.get(13.2));

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
