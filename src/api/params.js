'use strict';
/**
 * ============================================================================
 *  api/params.js — the three inputs every handler takes, validated ONCE
 * ============================================================================
 * `day(req)` accepted any string from the query OR the body and passed it to
 * Postgres, which answered 22007 — reported as a 500 — and, worse, to string
 * comparisons and cache keys that never complained at all. `symbol` went
 * through `String(undefined).toUpperCase()` and became the literal "UNDEFINED",
 * which was then written into the ledger. `budget` accepted a negative number.
 *
 * A bad input is a 400 with the reason, before anything reads the database.
 * ============================================================================
 */
const { badRequest } = require('./errors');
const { kuwaitDay } = require('../jobs/daily');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SYMBOL_RE = /^[A-Z0-9]{2,16}$/;

/** YYYY-MM-DD, or today's Kuwait session when absent. Anything else is 400. */
function dayParam(v, fallback = kuwaitDay) {
  if (v == null || v === '') return typeof fallback === 'function' ? fallback() : fallback;
  const s = String(v).trim();
  if (!DAY_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw badRequest(`date "${v}" is not a day`, 'send YYYY-MM-DD, or omit it for today');
  }
  return s;
}

/** Upper-cased ticker. Never "UNDEFINED". */
function symbolParam(v, { required = true } = {}) {
  const s = v == null ? '' : String(v).trim().toUpperCase();
  if (!s) {
    if (!required) return null;
    throw badRequest('symbol is required');
  }
  if (!SYMBOL_RE.test(s)) throw badRequest(`"${v}" is not a symbol`, 'letters and digits, 2-16 long');
  return s;
}

/** A budget in KD: finite, positive, and below anything the account could hold. */
function budgetParam(v, fallback) {
  if (v == null || v === '') return typeof fallback === 'function' ? fallback() : fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e7) {
    throw badRequest(`budgetKd "${v}" is out of range`, 'a positive number of KD');
  }
  return n;
}

/**
 * A row limit: a whole number 1..max (default max 500). Absent → the default.
 * `?limit=9999` used to reach Postgres unchecked — 3.6 / S-08.
 */
function limitParam(v, { fallback = 200, max = 500 } = {}) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw badRequest(`limit "${v}" is out of range`, `a whole number from 1 to ${max}`);
  }
  return n;
}

/**
 * An amount of KD the operator commits: finite, > 0, and no larger than the
 * slot — a claim bigger than the slot is a typo, not a decision.
 */
function amountParam(v, { max, name = 'amountKd', fallback } = {}) {
  if (v == null || v === '') {
    if (fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
    throw badRequest(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw badRequest(`${name} "${v}" must be a positive number of KD`);
  if (max != null && n > max) throw badRequest(`${name} ${n} exceeds the slot of ${max} KD`, 'lower it, or raise the slot in the gate store');
  return n;
}

/** A whole number 1..max, for minutes / days / counts. */
function intParam(v, { name = 'value', fallback, min = 1, max = 1e6 } = {}) {
  if (v == null || v === '') {
    if (fallback !== undefined) return fallback;
    throw badRequest(`${name} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} "${v}" is not a whole number from ${min} to ${max}`);
  return n;
}

module.exports = { dayParam, symbolParam, budgetParam, limitParam, amountParam, intParam, DAY_RE, SYMBOL_RE };
