'use strict';
/**
 * ============================================================================
 *  phrases.js — the ladder's short labels (R-24)
 * ============================================================================
 * BACKEND_spec §1.3 / FRONTEND_contract §5. A ladder marker is DECIDED in
 * depth.js (deterministic, testable) and LABELLED here, from spread.kb_phrase.
 *
 * The split exists for one reason: notes refresh every 15 seconds across 20
 * rows — 80 model calls a minute is too slow and too expensive — and a string
 * literal in the source cannot be edited without a deploy. The table can.
 *
 * NOT A MODEL CALL, and NOT a place for judgement: `{n}` and `{p}` are
 * substituted HERE, by the caller, never by the AI. A phrase missing from the
 * table falls back to the spec default so a marker is never blank.
 *
 * Loaded once at boot (load()); invalidate() drops the cache so an edit to the
 * table is picked up without a restart.
 * ============================================================================
 */
const { pool } = require('../db');

// The spec defaults (BACKEND_spec §1.3) — the fallback if a row is absent, so a
// marker always has a label even before 022 is applied or if a row is deleted.
const DEFAULTS = {
  AGED: 'held {n}m',
  BAIT: '{n}m old',
  THIN: 'thin — clears fast',
  PARKED: 'parked, {n} changes',
  CEILING: 'ceiling · {n}% of session',
  UNDERCUT: 'undercut — seller below {n}',
  PLACED: '+{n}, nothing traded',
  PULLED: '−{n} withdrawn',
  RELOCATED: '{n} moved from {p}',
  SHELF: 'round number — stops sit here',
  NOPROT: '{n} — nothing beneath',
  CATCH: 'catch bid — price chosen',
  // F8 · the flow markers (042 seeds the rows; these are the fallbacks).
  // PLACED_TRADING is the PLACED label when something may have traded: the
  // growth is still placed size, but "nothing traded" cannot be said.
  PLACED_TRADING: '+{n} while up to {p} traded',
  TRADED: '{n} traded',
  WALKDOWN: 'walk-down, step {n}',
};

let cache = null; // event -> text (still_true only), or null until loaded

async function load(db = pool) {
  try {
    const { rows } = await db.query(
      'SELECT event, text FROM spread.kb_phrase WHERE still_true');
    const m = {};
    for (const r of rows) m[r.event] = r.text;
    cache = m;
  } catch {
    cache = {}; // the table may not exist yet in a bare test DB — defaults cover it
  }
  return cache;
}

function invalidate() { cache = null; }

/** The raw template for an event: the table's text if present and true, else the spec default. */
function template(event) {
  if (cache && Object.prototype.hasOwnProperty.call(cache, event)) return cache[event];
  return DEFAULTS[event] || null;
}

/**
 * The rendered label for a marker. `subs` supplies {n} and {p}; each is
 * substituted verbatim (already formatted by the caller — a qty with its commas,
 * an age as an integer). A template with no placeholder ignores subs.
 */
function render(event, subs = {}) {
  const t = template(event);
  if (t == null) return null;
  return t
    .replace(/\{n\}/g, subs.n != null ? String(subs.n) : '')
    .replace(/\{p\}/g, subs.p != null ? String(subs.p) : '');
}

/** A marker object for the ladder row: the machine-readable event and its label. */
function marker(event, subs = {}) {
  return { event, text: render(event, subs) };
}

module.exports = { load, invalidate, template, render, marker, DEFAULTS };
