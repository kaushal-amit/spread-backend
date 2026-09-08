/**
 * R-27 · the AI context (BACKEND_spec §3.3).
 *   · a second question in the same tab carries the first exchange
 *   · a SITUATIONAL kb_rule for HOLDING appears only when a position is open
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('aicontext');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const claude = require('../src/services/ai/claude');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

const SYM = 'SZTESTCTX', DAY = kuwaitDay();

function stubModel(text) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init) => {
    if (!/anthropic/.test(String(url))) return real(url, init);
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }], usage: { output_tokens: 5 } }) };
  };
  return { calls, restore: () => { global.fetch = real; } };
}

(async () => {
  const hadKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-never-sent';
  try {
    await fx.clearLegs(SYM); await fx.clearQuotes(SYM); await fx.instrument(SYM);
    await fx.quote(SYM, { day: DAY, at: new Date().toISOString(), last: 150, bid: 150, offer: 151 });
    await pool.query('DELETE FROM spread.ai_chat WHERE symbol = $1', [SYM]);
    await pool.query("DELETE FROM spread.kb_rule WHERE source_cr = 'R27-TEST'");

    console.log('\n=== a follow-up in the same tab carries the earlier turn ===');
    const s1 = stubModel(`${SYM} rests at 150. Wait.`);
    await claude.ask({ symbol: SYM, tradingDay: DAY, question: 'where is the bid?', budgetKd: 790 });
    s1.restore();
    const s2 = stubModel(`Still 150. Wait.`);
    await claude.ask({ symbol: SYM, tradingDay: DAY, question: 'has it moved?', budgetKd: 790 });
    s2.restore();
    const user2 = String(s2.calls[0]?.messages?.[0]?.content || '');
    chk('the second prompt carries THIS TAB SO FAR', /THIS TAB SO FAR/.test(user2), user2.slice(0, 80));
    chk('  and quotes the first question', /where is the bid\?/.test(user2));
    chk('  with the engine\'s prior answer as untrusted', /<untrusted source="spread\.ai_chat\.answer">/.test(user2));

    console.log('\n=== a SITUATIONAL rule appears only when its state holds ===');
    await pool.query(
      `INSERT INTO spread.kb_rule (rule, heading, source_file, scope, symbol, trigger_state, source_cr, still_true, section_no)
       VALUES ('While HOLDING, never widen a stop.', 'hold', 'test', 'SITUATIONAL', null, 'POSITION_OPEN', 'R27-TEST', true, 1)`);
    const sHold = stubModel('OK. Wait.');
    await claude.ask({ symbol: SYM, tradingDay: DAY, question: 'hold or cut?', tradingState: 'HOLDING', budgetKd: 790 });
    sHold.restore();
    const sysHold = String(sHold.calls[0]?.system || '');
    chk('the HOLDING rule is in the system prompt when HOLDING', /never widen a stop/.test(sysHold), sysHold.slice(-200));
    const sFlat = stubModel('OK. Wait.');
    await claude.ask({ symbol: SYM, tradingDay: DAY, question: 'anything?', budgetKd: 790 });
    sFlat.restore();
    const sysFlat = String(sFlat.calls[0]?.system || '');
    chk('and NOT there when flat (no trading state)', !/never widen a stop/.test(sysFlat));
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  if (hadKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = hadKey;
  await pool.query("DELETE FROM spread.kb_rule WHERE source_cr = 'R27-TEST'").catch(() => {});
  await pool.query('DELETE FROM spread.ai_chat WHERE symbol = $1', [SYM]).catch(() => {});
  await pool.query('DELETE FROM spread.ai_note WHERE symbol = $1', [SYM]).catch(() => {});
  await fx.clearLegs(SYM).catch(() => {}); await fx.clearQuotes(SYM).catch(() => {}); await fx.clearInstruments(SYM).catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
