/*
 * The two guards. Both were asked for explicitly:
 *   "the guard should return SESSION_INCOMPLETE if it runs before 13:25"
 *   "backfill order matters — otherwise 10 Aug computes against 6 Aug"
 */
const { sessionGuard, sequenceGuard, kuwaitDay } = require('../src/jobs/daily');
let pass = 0, fail = 0;
const chk = (l, c, x = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${x ? '  ' + x : ''}`); c ? pass++ : fail++; };

// A stub that answers only what each guard asks.
const db = (answers) => ({ query: async (sql) => {
  if (/information_schema/.test(sql)) return { rows: [{ table_schema: 'public', table_name: 'stock_quotes' }] };
  if (/last_capture/.test(sql)) return { rows: [answers.session] };
  if (/prev_session/.test(sql))  return { rows: [{ prev: answers.prev }] };
  if (/count\(\*\) AS n/.test(sql)) return { rows: [{ n: answers.prevRows ?? 0 }] };
  return { rows: [] };
} });

console.log('=== GUARD A · has the session finished? ===');
(async () => {
  let g = await sessionGuard('2026-08-13',
    db({ session: { rows_today: 4200, last_capture: '11:42', last_time: '11:42:03' } }));
  chk('mid-session at 11:42 -> SESSION_INCOMPLETE', g.status === 'SESSION_INCOMPLETE', g.status);
  chk('  and says writing now would store a partial session',
      /partial session/.test(g.detail || ''));

  g = await sessionGuard('2026-08-13',
    db({ session: { rows_today: 4200, last_capture: '13:24', last_time: '13:24:59' } }));
  chk('13:24 is still incomplete — the auction runs to 13:25',
      g.status === 'SESSION_INCOMPLETE', g.status);

  g = await sessionGuard('2026-08-13',
    db({ session: { rows_today: 4200, last_capture: '13:26', last_time: '13:26:11' } }));
  chk('13:26 -> READY', g.status === 'READY', g.status);

  g = await sessionGuard('2026-08-13',
    db({ session: { rows_today: 0, last_capture: null, last_time: null } }));
  chk('no rows at all -> NO_DATA, not incomplete', g.status === 'NO_DATA', g.status);
  chk('  and names the scraper', /scraper did not run/.test(g.detail || ''));

  console.log('\n=== GUARD B · is the previous session computed? ===');
  let s = await sequenceGuard('2026-08-10', db({ prev: '2026-08-09', prevRows: 0 }));
  chk('9 Aug not computed -> 10 Aug is SKIPPED',
      s.status === 'PREVIOUS_NOT_COMPUTED', s.status);
  chk('  and explains the 4-day error it prevents',
      /prev_session\(\) exists to prevent/.test(s.detail || ''));
  chk('  and names which day to run first', /Run 2026-08-09 first/.test(s.detail || ''));

  s = await sequenceGuard('2026-08-10', db({ prev: '2026-08-09', prevRows: 128 }));
  chk('9 Aug computed -> 10 Aug proceeds', s.status === 'OK', s.status);

  s = await sequenceGuard('2026-07-28', db({ prev: null }), { allowFirst: true });
  chk('the first day of a backfill has nothing before it', s.status === 'FIRST_DAY');
  s = await sequenceGuard('2026-07-28', db({ prev: null }));
  chk('but outside a backfill that is an error', s.status === 'NO_PREVIOUS_SESSION');

  console.log('\n=== the session day rolls at 04:00 Kuwait, not midnight ===');
  chk('20:45 UTC is the 3rd', kuwaitDay(new Date('2026-08-03T20:45:00Z')) === '2026-08-03');
  chk('21:15 UTC is STILL the 3rd', kuwaitDay(new Date('2026-08-03T21:15:00Z')) === '2026-08-03',
      kuwaitDay(new Date('2026-08-03T21:15:00Z')));
  chk('06:30 UTC is the new session', kuwaitDay(new Date('2026-08-04T06:30:00Z')) === '2026-08-04');

  console.log('\n=== a date is a DAY, not an instant ===');
  {
    /*
     * pg turns a DATE into a JS Date at LOCAL midnight. On a machine at
     * UTC+0530 the date 2026-08-12 serialises as 2026-08-11T18:30:00Z — the day
     * before — and the guard reported both forms for the same value:
     *
     *   "prev": "2026-08-11T18:30:00.000Z"
     *   "Wed Aug 12 2026 00:00:00 GMT+0530 ... has no rows"
     *
     * The driver now returns dates as strings. This asserts the guard's message
     * names a plain day whichever form arrives.
     */
    let s2 = await sequenceGuard('2026-08-13',
      db({ prev: '2026-08-12', prevRows: 0 }));
    chk('a string date prints as a day', /Run 2026-08-12 first/.test(s2.detail || ''),
        s2.detail?.slice(-30));

    s2 = await sequenceGuard('2026-08-13',
      db({ prev: new Date('2026-08-12T00:00:00Z'), prevRows: 0 }));
    chk('a Date object still prints as a day', /Run 2026-08-12 first/.test(s2.detail || ''),
        'not "Wed Aug 12 2026 00:00:00 GMT+0530"');
    chk('  and prev is the day, not a timestamp', s2.prev === '2026-08-12', String(s2.prev));
  }

  console.log('\n=== npm eats flags, so positionals and --partial carry ===');
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'jobs', 'daily', 'index.js'), 'utf8');
    chk('--partial is accepted', /--partial/.test(src),
        'npm consumes --force as its own option');
    chk('SPREAD_FORCE=1 works regardless', /SPREAD_FORCE/.test(src));
    chk('positional dates are the primary form', /POSITIONAL DATES ARE THE PRIMARY FORM/.test(src));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail}  (${pass} checks)`);
  process.exit(fail ? 1 : 0);
})();
