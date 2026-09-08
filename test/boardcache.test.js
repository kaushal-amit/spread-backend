/**
 * R-16 (6.3) · the board is cached per (day, budget, gate-version) AND
 * dedupes in-flight runs. Six concurrent cold reads must run the funnel ONCE,
 * not six times over identical data.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('boardcache');
const { pool } = require('../src/db');
const routes = require('../src/api/routes');
const gateStore = require('../src/services/gateStore');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  try {
    await gateStore.load().catch(() => {});
    routes.invalidate();
    const day = kuwaitDay();
    const runs0 = routes.board.runs();

    console.log('\n=== R-16 · six concurrent cold reads → one funnel run ===');
    const results = await Promise.all(Array.from({ length: 6 }, () => routes.board(day, 2000)));
    chk('the funnel ran exactly once for six concurrent reads', routes.board.runs() === runs0 + 1, { before: runs0, after: routes.board.runs() });
    chk('all six got the same board object (shared in-flight promise)', results.every((r) => r === results[0]));

    console.log('\n=== a cached read does not re-run ===');
    await routes.board(day, 2000);
    chk('a read within the cache window reuses the value', routes.board.runs() === runs0 + 1, routes.board.runs());

    console.log('\n=== a different budget is a different key → a new run ===');
    await routes.board(day, 3000);
    chk('a different budget runs the funnel again', routes.board.runs() === runs0 + 2, routes.board.runs());
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
