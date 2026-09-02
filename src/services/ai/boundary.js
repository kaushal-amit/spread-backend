'use strict';
/**
 * ============================================================================
 *  boundary.js — what the AI may say, and what it may never produce
 * ============================================================================
 * THE ORDER PRICE COMES FROM pricing.js, NEVER FROM THE AI.
 *
 * This module is the mechanical enforcement of that, because a rule that lives
 * only in a prompt is a rule that will be broken by a model having a bad day.
 *
 *   may                                  must not
 *   ----------------------------------   ----------------------------------
 *   explain why a gate passed or failed  compute a price
 *   rank and compare candidates          compute a share count
 *   warn about behaviour                 compute net or commission
 *   flag patterns in the book            place, amend or cancel an order
 *   cite a precedent from the record     override a gate
 *
 * Three mechanical rejections:
 *
 *   J26  a response containing a price/shares/net/commission field
 *   J27  a response citing a number ABSENT from its input
 *   L8   a directional prediction — 131 attempts have failed
 *
 * J27 is the one that matters. A hallucinated "47% chance" is
 * indistinguishable from a real figure in prose, and the trader has no way to
 * check it mid-session.
 * ============================================================================
 */

const { DEPTH } = require('../../config/spread.config');

const FORBIDDEN_FIELDS = [
  'price', 'priceFils', 'orderPrice', 'entryPrice', 'exitPrice', 'sellPrice', 'buyPrice',
  'shares', 'quantity', 'qty', 'size', 'lots',
  'net', 'netKd', 'profit', 'pnl',
  'commission', 'commissionKd', 'fee',
  'stopLoss', 'target', 'targetPrice',
];

const VERDICTS = new Set(['TAKE', 'WAIT', 'AVOID', 'WARN']);

/* Two decimals is the resolution everything is quoted at. */
const normalise = (n) => Number(Number(n).toFixed(2));

function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').match(/-?\d[\d,]*\.?\d*/g) || []) {
    const n = Number(m.replace(/,/g, ''));
    if (Number.isFinite(n)) out.add(normalise(n));
  }
  return out;
}

function numbersAvailable(input, depth = 0) {
  const out = new Set();
  if (depth > 8 || input == null) return out;
  if (typeof input === 'number') { out.add(normalise(input)); return out; }
  if (typeof input === 'string') { for (const n of numbersIn(input)) out.add(n); return out; }
  if (Array.isArray(input)) {
    for (const v of input) for (const n of numbersAvailable(v, depth + 1)) out.add(n);
    return out;
  }
  if (typeof input === 'object') {
    for (const v of Object.values(input)) for (const n of numbersAvailable(v, depth + 1)) out.add(n);
  }
  return out;
}

/**
 * ─── SAME-ROW DERIVATIONS ─────────────────────────────────────────────────
 *
 * The check used to compare prose numbers against RAW COLUMN VALUES only. So
 * 178 passed and 2.2 — which is 4 / 178 — did not, and every answer worth
 * reading was rejected:
 *
 *     "102,062 shares/minute against 38,774, so the engine died after 10:00"
 *
 * was refused for containing 38%. The model computes constantly, because that
 * is what makes an answer readable, and rejecting arithmetic rejects the work.
 *
 * ─── WHAT THIS WEAKENS, STATED PLAINLY ────────────────────────────────────
 * The check now asks whether a number is CONSISTENT WITH the data, not whether
 * it CAME FROM the data. With thousands of derived values a fabricated figure
 * can coincide with a real ratio and pass.
 *
 * That is weaker, and deliberately: the previous rule rejected the answers
 * worth reading and passed the ones nobody reads, which trains a reader to
 * ignore rejections entirely.
 *
 * ─── SAME ROW ONLY ────────────────────────────────────────────────────────
 * a and b must come from ONE row. chg_fils / prev_close is same-row; today's
 * close over last week's volume is not, and should not validate. Pairwise
 * across every value would be millions of numbers and would validate anything.
 */
function derivationsFrom(row) {
  const vals = [];
  for (const [col, v] of Object.entries(row || {})) {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?[\d.]+$/.test(v) ? Number(v) : null);
    if (n !== null && Number.isFinite(n)) vals.push([col, n]);
  }

  const out = new Map();          // value -> how it was derived
  const put = (v, how) => {
    if (!Number.isFinite(v)) return;
    const k = normalise(v);
    if (!out.has(k)) out.set(k, how);
  };

  for (const [ca, a] of vals) {
    put(a, ca);
    put(a / 1000, `${ca} / 1000`);          // fils -> KD
    put(a / 1e6, `${ca} / 1e6`);            // shares -> millions
    for (const [cb, b] of vals) {
      if (ca === cb || b === 0) continue;
      put((a * 100) / b, `${ca} / ${cb} x 100`);
      put(a / b, `${ca} / ${cb}`);
      put(a - b, `${ca} - ${cb}`);
      put((a * b) / 1000, `${ca} x ${cb} / 1000`);
    }
  }
  return out;
}

/**
 * Every value, and every same-row derivation, with its provenance.
 *
 * Returns a Map so a passing number can say WHICH derivation matched — logged
 * to ai_chat, because after twenty sessions that record is the only way to
 * tell whether the derived passes are real arithmetic or coincidence.
 */
function derivedIndex(input) {
  const index = new Map();
  const walk = (node, depth = 0) => {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }
    if (typeof node !== 'object') return;

    // A "row" is an object with at least two numeric leaves.
    const numericLeaves = Object.values(node)
      .filter((v) => typeof v === 'number' || (typeof v === 'string' && /^-?[\d.]+$/.test(v)));
    if (numericLeaves.length >= 2) {
      for (const [v, how] of derivationsFrom(node)) if (!index.has(v)) index.set(v, how);
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(input);
  return index;
}

/*
 * Small integers need no source. Ordinary prose says "the third reposition" or
 * "two levels", and demanding a source for those would reject every readable
 * sentence. Invented MEASUREMENTS are the risk, not counts the model derives
 * from its own reading.
 */
const EXEMPT = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]);

/**
 * ─── UNDER A TOOL LOOP THE INPUT IS A UNION ────────────────────────────────
 *
 * With the frozen registry the bundle was fixed and this file knew every
 * number that entered. With a loop the model chooses WHICH tools to call, so
 * the input differs per question and must be assembled from what was actually
 * returned.
 *
 * IT FAILS CLOSED. If a tool errored, or the model saw a result that never
 * reached this union, validation REJECTS rather than passes: a boundary that
 * silently skips an unrecorded source is worse than no boundary, because it
 * reports success on numbers it never checked.
 *
 * @param results  the array of tool results, each carrying `tool` and `rows`
 */
function unionOf(results) {
  const missing = [];
  const parts = [];
  for (const r of results || []) {
    if (!r || r.error) { missing.push((r && r.tool) || 'unknown'); continue; }
    // A result with no rows_returned was not produced by tools.js — it cannot
    // be attributed, so it counts as missing rather than as empty.
    if (typeof r.rows_returned !== 'number') { missing.push(r.tool || 'unattributed'); continue; }
    parts.push(r);
  }
  return { input: parts, missing };
}

function validate(response, input, { tolerance = 0.02, missingSources = [], derivations = null } = {}) {
  const rejections = [];
  const warnings = [];

  // Fail closed. Named first so it cannot be buried under number checks.
  if (missingSources.length) {
    rejections.push({
      why: 'a tool result never reached the boundary',
      detail: `${missingSources.join(', ')} — the answer may rest on numbers `
        + 'that were never checked, so it is rejected rather than trusted',
    });
  }

  if (!response || typeof response !== 'object') {
    return { ok: false, rejections: ['response is not an object'], warnings };
  }

  // ---- J26 · no numeric fields, at any depth -----------------------------
  const walk = (obj, path = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const here = path ? `${path}.${k}` : k;
      if (FORBIDDEN_FIELDS.includes(k)) {
        rejections.push(`field "${here}" is forbidden — the AI may not produce a ${k}. ` +
          'Order prices come from pricing.js, never from the model.');
      }
      if (typeof v === 'object') walk(v, here);
    }
  };
  walk(response);

  if (response.verdict != null && !VERDICTS.has(String(response.verdict).toUpperCase())) {
    rejections.push(`verdict "${response.verdict}" is not one of ${[...VERDICTS].join('/')}`);
  }

  // ---- J27 · every number must be traceable ------------------------------
  const available = numbersAvailable(input);
  // Same-row derivations, each carrying HOW it was reached.
  const derived = derivedIndex(input);
  const prose = [response.reasoning, response.message, response.line,
                 ...(Array.isArray(response.lines) ? response.lines : [])]
    .filter((x) => typeof x === 'string').join(' ');

  const uncited = [];
  const usedDerivations = [];
  for (const n of numbersIn(prose)) {
    if (EXEMPT.has(n) || available.has(n)) continue;

    // A same-row derivation: chg_fils / prev_close, shares / 1e6, and so on.
    if (derived.has(n)) { usedDerivations.push({ value: n, from: derived.get(n) }); continue; }

    // 20% for 20.4 is a fair reading; every percentage need not be restated to
    // a decimal place nobody reads.
    const near = [...available].some((a) =>
      a !== 0 && Math.abs(a - n) / Math.max(Math.abs(a), 1) <= tolerance);
    if (near) continue;

    const nearDerived = [...derived.keys()].find((a) =>
      a !== 0 && Math.abs(a - n) / Math.max(Math.abs(a), 1) <= tolerance);
    if (nearDerived !== undefined) {
      usedDerivations.push({ value: n, from: derived.get(nearDerived), rounded: true });
      continue;
    }

    uncited.push(n);
  }
  if (derivations) derivations.push(...usedDerivations);
  if (uncited.length) {
    rejections.push(`numbers not present in the input: ${uncited.join(', ')}. ` +
      'A number the model invented is indistinguishable from a real one in prose, and ' +
      'cannot be checked mid-session.');
  }

  // ---- L8 · what it must not become --------------------------------------
  if (/\bwill (rise|fall|go up|go down|reach)\b/i.test(prose)
      || /\bexpect(ed)? to (rise|fall)\b/i.test(prose)) {
    rejections.push('directional prediction. 131 tests have failed; it must not be ' +
      'reintroduced in prose.');
  }

  /*
   * CR-34 · a depth-direction claim needs a sample. An earlier reading of nine
   * minutes concluded the OPPOSITE of the full session — five observations
   * inside a falling stretch, and the sign inverted.
   */
  if (/\bdeep bid\b|\bbid depth\b|\bthin bid\b/i.test(prose)) {
    const snaps = Number(input?.depth?.snapshots ?? input?.snapshots ?? 0);
    if (!(snaps >= DEPTH.minSnapshots)) {
      rejections.push(`a depth-direction claim needs ${DEPTH.minSnapshots} snapshots and this ` +
        `has ${snaps}. An earlier reading of nine minutes concluded the opposite.`);
    }
  }

  if (/\b(looks good|should be fine|probably fine|looks strong)\b/i.test(prose)) {
    warnings.push('reassurance without a number — "this looks good" is not commentary');
  }
  if (/\bcould go either way\b/i.test(prose)) {
    warnings.push('hedged into uselessness — adds nothing');
  }

  return { ok: rejections.length === 0, rejections, warnings };
}

/**
 * Which columns produced which numbers.
 *
 * Stored on ai_note.cited_values so a wrong comment can be traced to WRONG
 * DATA rather than wrong reasoning — those need completely different fixes and
 * look identical after the fact.
 */
function citedValues(response, input) {
  const prose = [response?.reasoning, response?.message, response?.line]
    .filter((x) => typeof x === 'string').join(' ');
  const used = numbersIn(prose);
  const cited = {};
  const walk = (obj, path = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const here = path ? `${path}.${k}` : k;
      if (typeof v === 'number' && used.has(normalise(v))) cited[here] = v;
      else if (typeof v === 'object') walk(v, here);
    }
  };
  walk(input);
  return cited;
}

module.exports = { validate, unionOf, citedValues, numbersIn, numbersAvailable,
  derivedIndex, derivationsFrom,
  FORBIDDEN_FIELDS, VERDICTS };
