/**
 * R-25 · FLOW step 4 checks 1-2, the LIVE direction gate.
 *   check 1  current > open
 *   check 2  high > open
 * Runs at/after 09:20; before that the cells read "not yet".
 *
 * open 150, last 148, high 151 → check 1 fails, check 2 passes.
 */
const { liveDirection } = require('../src/services/screening');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

// Kuwait is UTC+3: 07:00Z = 10:00 (after 09:20); 06:00Z = 09:00 (before).
const after0920 = new Date('2001-01-08T07:00:00Z');
const before0920 = new Date('2001-01-08T06:00:00Z');

console.log('\n=== R-25 · the live direction gate ===');
const d = liveDirection({ openFils: 150, lastFils: 148, highFils: 151 }, after0920);
chk('computed at/after 09:20', d.computed === true, d);
chk('check 1 (current > open) FAILS — 148 is not above 150', d.currentAboveOpen === false, d);
chk('check 2 (high > open) PASSES — 151 is above 150', d.highAboveOpen === true, d);

const up = liveDirection({ openFils: 150, lastFils: 152, highFils: 153 }, after0920);
chk('a stock up on the session passes both', up.currentAboveOpen === true && up.highAboveOpen === true, up);

const early = liveDirection({ openFils: 150, lastFils: 148, highFils: 151 }, before0920);
chk('before 09:20 both are NOT COMPUTED ("not yet")', early.computed === false && early.currentAboveOpen === null && early.highAboveOpen === null && /not yet/.test(early.note), early);

const noOpen = liveDirection({ openFils: null, lastFils: 148, highFils: 151 }, after0920);
chk('no open captured yet → not computed', noOpen.computed === false, noOpen);

console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
process.exit(p === n ? 0 : 1);
