'use strict';
/**
 * scripts/import-kb.js — the skills, as rows.
 *
 * ─── ONE ROW PER `##` SECTION ──────────────────────────────────────────────
 * The headings are the author's own unit of thought. Splitting finer means
 * this script decides where a rule ends, and a rule severed from its evidence
 * stops being credible; splitting coarser makes scoping pointless.
 *
 * EXCEPT the per-stock files, which are ONE ROW EACH. A stock's book behaviour
 * is one thing — who works it, where the walls sit, how the bid rebuilds — and
 * splitting it means half of it arrives.
 *
 * ─── EVERYTHING IMPORTS AS GLOBAL ──────────────────────────────────────────
 * trigger_state stays NULL. Almost nothing in the prose names a signal state,
 * so assigning one would be a guess — and a wrong trigger_state means the rule
 * never loads and NOTHING REPORTS IT. That is the failure shape this project
 * has spent two weeks removing. Tag later, through the API.
 *
 * ─── IT REPORTS SIGNALS, NOT A CLASSIFICATION ──────────────────────────────
 * Sections that set a rule up rather than state one are kept — a rule severed
 * from why it exists stops being credible. But which is which is not decided
 * here: a heuristic list would look authoritative and send someone to the
 * wrong sections at exactly the moment they are debugging degraded answers.
 *
 * So four FACTS travel with every row: word_count, has_number, has_code_block,
 * has_checkbox. Sort by them and judge.
 *
 * NOTE ON has_checkbox: it reads authorial STYLE as much as content.
 * kse-tape-forensics has ZERO checkboxes across six sections and is rule-heavy
 * — it uses code blocks instead.
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

/**
 * The skills, SHIPPED WITH THE REPO.
 *
 * The first version defaulted to /mnt/skills/user — a path on the machine the
 * script was written on, not the machine it runs on. On Windows that resolved
 * to E:\mnt\skills\user and threw ENOENT, which says a directory is missing
 * without saying which directory it expected or why.
 *
 * kb/skills/ travels in the package: 11 files, 140K. The knowledge base is
 * part of the product, not an input someone has to supply — and an import that
 * depends on a path outside the repo is an import that works on one machine.
 *
 * SKILLS_DIR still overrides, for editing them somewhere else.
 */
const SKILLS = process.env.SKILLS_DIR || path.join(__dirname, '..', 'kb', 'skills');

/** `## Heading` … up to the next `## `, keeping nested `###` with their parent. */
function sections(md) {
  const out = [];
  const lines = md.split('\n');
  let heading = null;
  let body = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(?!#)(.+)$/);
    if (m) {
      if (heading) out.push({ heading, body: body.join('\n').trim() });
      heading = m[1].trim();
      body = [];
    } else if (heading) {
      body.push(line);
    }
  }
  if (heading) out.push({ heading, body: body.join('\n').trim() });
  return out;
}

const signals = (text) => ({
  word_count: text.split(/\s+/).filter(Boolean).length,
  has_number: /\d/.test(text),
  has_code_block: /```/.test(text),
  has_checkbox: /^\s*[-*]\s+\[.\]/m.test(text),
});

async function importAll({ apply = false } = {}) {
  if (!fs.existsSync(SKILLS)) {
    throw new Error(
      `the skills directory does not exist: ${SKILLS}\n`
      + '  It ships with the repo at kb/skills. If it is missing, the package is\n'
      + '  incomplete — or set SKILLS_DIR to point somewhere else.');
  }
  const dirs = fs.readdirSync(SKILLS).filter((d) => d.startsWith('kse-')).sort();
  if (!dirs.length) {
    throw new Error(
      `${SKILLS} exists but holds no kse-* directories.\n`
      + '  Expected one folder per skill, each with a SKILL.md.');
  }
  const rows = [];
  const skipped = [];

  for (const d of dirs) {
    const skillFile = path.join(SKILLS, d, 'SKILL.md');
    if (!fs.existsSync(skillFile)) { skipped.push({ file: d, why: 'no SKILL.md' }); continue; }

    let no = 0;
    for (const s of sections(fs.readFileSync(skillFile, 'utf8'))) {
      no += 1;
      if (!s.body) { skipped.push({ file: d, heading: s.heading, why: 'heading with no body' }); continue; }
      rows.push({
        source_file: `${d}/SKILL.md`,
        // A heading is NOT unique within a file — kse-auction-and-tip-trades
        // has two called "The rule". Keyed on heading alone the second
        // overwrote the first and two rules became one.
        section_no: no,
        heading: s.heading,
        rule: `## ${s.heading}\n\n${s.body}`,
        scope: 'GLOBAL',
        symbol: null,
        ...signals(s.body),
      });
    }

    // Per-stock files: ONE ROW EACH, scope STOCK, symbol from the filename.
    const stocksDir = path.join(SKILLS, d, 'stocks');
    if (!fs.existsSync(stocksDir)) continue;
    for (const f of fs.readdirSync(stocksDir).filter((x) => x.endsWith('.md'))) {
      if (f.startsWith('_')) { skipped.push({ file: `${d}/stocks/${f}`, why: 'a template, not a rule' }); continue; }
      const body = fs.readFileSync(path.join(stocksDir, f), 'utf8');
      rows.push({
        source_file: `${d}/stocks/${f}`,
        section_no: 1,
        heading: f.replace(/\.md$/, ''),
        rule: body,
        scope: 'STOCK',
        symbol: f.replace(/\.md$/, '').toUpperCase(),
        ...signals(body),
      });
    }
  }

  if (apply) {
    for (const r of rows) {
      await pool.query(`
        INSERT INTO spread.kb_rule
          (source_file, section_no, heading, rule, scope, symbol, trigger_state,
           word_count, has_number, has_code_block, has_checkbox)
        VALUES ($1,$10,$2,$3,$4,$5,NULL,$6,$7,$8,$9)
        ON CONFLICT (source_file, section_no) DO UPDATE SET
          heading = EXCLUDED.heading,
          rule = EXCLUDED.rule, scope = EXCLUDED.scope, symbol = EXCLUDED.symbol,
          word_count = EXCLUDED.word_count, has_number = EXCLUDED.has_number,
          has_code_block = EXCLUDED.has_code_block, has_checkbox = EXCLUDED.has_checkbox`,
      [r.source_file, r.heading, r.rule, r.scope, r.symbol,
        r.word_count, r.has_number, r.has_code_block, r.has_checkbox, r.section_no]);
    }
  }
  return { rows, skipped };
}

module.exports = { importAll, sections, signals };

if (require.main === module) {
  (async () => {
    try { require('dotenv').config(); } catch { /* optional */ }
    const apply = process.argv.includes('--apply');
    const { rows, skipped } = await importAll({ apply });

    let file = null;
    for (const r of rows) {
      if (r.source_file !== file) { file = r.source_file; console.log(`\n  ${file}`); }
      console.log(`    ${String(r.word_count).padStart(5)}w  `
        + `${r.has_number ? 'num ' : '    '}${r.has_code_block ? 'code ' : '     '}`
        + `${r.has_checkbox ? 'chk ' : '    '} ${r.scope.padEnd(7)}`
        + `${(r.symbol || '').padEnd(9)} ${r.heading.slice(0, 60)}`);
    }

    console.log(`\n  ${rows.length} row(s) ${apply ? 'written' : 'would be written'}`);
    for (const s of skipped) console.log(`  skipped  ${s.file}${s.heading ? ' · ' + s.heading : ''} — ${s.why}`);
    console.log(`  ${skipped.length} skipped`);

    // A section of 40 words is probably a heading with nothing under it. That
    // is visible in a word count and invisible in a total.
    const thin = rows.filter((r) => r.word_count < 40);
    if (thin.length) {
      console.log(`\n  ${thin.length} section(s) under 40 words:`);
      for (const t of thin) console.log(`    ${t.word_count}w  ${t.source_file} · ${t.heading}`);
    }
    const noSignal = rows.filter((r) => !r.has_checkbox && !r.has_code_block);
    console.log(`\n  ${noSignal.length} section(s) with NEITHER a checkbox NOR a code block`);
    console.log('  (a signal about authorial style as much as content — '
      + 'kse-tape-forensics uses no checkboxes at all and is rule-heavy)');

    await pool.end();
  })();
}
