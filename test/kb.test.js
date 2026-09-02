/** The KB import and the row poller. */
const { importAll, sections, signals } = require('../scripts/import-kb');
const { pool } = require('../src/db');
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };

(async () => {
  try {
    console.log('\n=== the split is at ## ===');
    const md = '# Title\nintro\n## One\nbody one\n### nested\nstill one\n## Two\nbody two\n';
    const s = sections(md);
    chk('two sections', s.length === 2, s.map((x) => x.heading));
    chk('### stays with its parent', /nested/.test(s[0].body), s[0].body);
    chk('the intro before the first ## is not a section', !s.some((x) => /intro/.test(x.body)));

    console.log('\n=== the signals are FACTS, not a classification ===');
    const sg = signals('- [ ] a rule with 42 in it\n```\ncode\n```');
    chk('has_checkbox', sg.has_checkbox === true, sg);
    chk('has_number', sg.has_number === true, sg);
    chk('has_code_block', sg.has_code_block === true, sg);
    chk('word_count is counted', sg.word_count > 5, sg.word_count);
    const plain = signals('prose with no markers at all');
    chk('and all three are false on plain prose',
        !plain.has_checkbox && !plain.has_number && !plain.has_code_block, plain);

    console.log('\n=== the import ===');
    const { rows } = await importAll();
    chk('rows were produced', rows.length > 50, rows.length);
    chk('every row is GLOBAL or STOCK', rows.every((r) => ['GLOBAL', 'STOCK'].includes(r.scope)));
    chk('trigger_state is never guessed', rows.every((r) => r.trigger_state === undefined));
    chk('the stock files are STOCK with a symbol',
        rows.filter((r) => r.scope === 'STOCK').every((r) => !!r.symbol),
        rows.filter((r) => r.scope === 'STOCK').map((r) => r.symbol));
    chk('the template is NOT imported', !rows.some((r) => /_TEMPLATE/.test(r.source_file)));

    // A heading is not unique within a file: two sections called "The rule"
    // collapsed into one when the key was (source_file, heading), and 72
    // imported rows became 70 stored.
    const keyed = new Set(rows.map((r) => `${r.source_file}|${r.section_no}`));
    chk('section_no makes every row distinct', keyed.size === rows.length,
        [keyed.size, rows.length]);
    const byHeading = new Set(rows.map((r) => `${r.source_file}|${r.heading}`));
    chk('and headings alone would NOT have — this is why', byHeading.size < rows.length,
        [byHeading.size, rows.length]);

    console.log('\n=== stored, and re-runnable ===');
    const { rows: db1 } = await pool.query('SELECT count(*)::int c FROM spread.kb_rule');
    chk('the table holds every row', db1[0].c === rows.length, [db1[0].c, rows.length]);
    await importAll({ apply: true });
    const { rows: db2 } = await pool.query('SELECT count(*)::int c FROM spread.kb_rule');
    chk('a second import writes no duplicates', db2[0].c === db1[0].c, [db1[0].c, db2[0].c]);

    console.log('\n=== supersedes links a correction to what it replaced ===');
    const { rows: two } = await pool.query('SELECT id FROM spread.kb_rule ORDER BY id LIMIT 2');
    await pool.query('UPDATE spread.kb_rule SET supersedes = $1, still_true = true WHERE id = $2',
      [two[0].id, two[1].id]);
    const { rows: link } = await pool.query(
      `SELECT r.id, r.supersedes, o.heading AS replaced
         FROM spread.kb_rule r JOIN spread.kb_rule o ON o.id = r.supersedes
        WHERE r.id = $1`, [two[1].id]);
    chk('the link resolves', link.length === 1 && !!link[0].replaced, link[0]);
    await pool.query('UPDATE spread.kb_rule SET supersedes = NULL WHERE id = $1', [two[1].id]);

    console.log('\n=== a bad trigger_state is REFUSED at insert ===');
    let refused = false;
    try {
      await pool.query(`INSERT INTO spread.kb_rule (rule, scope, trigger_state, source_file, section_no)
                        VALUES ('x','SITUATIONAL','TYPO_STATE','t',999)`);
    } catch { refused = true; }
    chk('a typo cannot make a rule silently never load', refused === true);
    await pool.query("DELETE FROM spread.kb_rule WHERE source_file = 't'");
  } catch (e) {
    chk('the suite ran without throwing', false, e.message);
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
