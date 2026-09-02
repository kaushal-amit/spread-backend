'use strict';
/**
 * ============================================================================
 *  errors.js — typed failures, so the client can tell them apart
 * ============================================================================
 * Every backend failure previously collapsed to `500 {error: e.message}`. A
 * missing table and a bad request were indistinguishable to the client, and a
 * retry policy cannot make a sensible decision about either.
 *
 * WORSE: several queries carried `.catch(() => ({ rows: [] }))`, which turns a
 * database failure into an EMPTY RESULT. An empty list and a failed fetch
 * render identically and only one of them is information — the same
 * conflation the proxy's 502 exists to prevent.
 * ============================================================================
 */

class ApiError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const badRequest = (msg, detail) => new ApiError(400, 'BAD_REQUEST', msg, detail);
const notFound = (msg, detail) => new ApiError(404, 'NOT_FOUND', msg, detail);
/** A deliberate refusal — a rule said no. NEVER retried by the client. */
const refused = (msg, detail) => new ApiError(409, 'REFUSED', msg, detail);
const unauthorised = (msg) => new ApiError(401, 'UNAUTHORISED', msg);

/** Postgres codes that mean "the schema is not what the code expects". */
const PG = {
  '42P01': ['SCHEMA_MISSING', 'a table or view is missing — run npm run migrate'],
  '42703': ['SCHEMA_MISSING', 'a column is missing — run npm run migrate'],
  '3D000': ['DB_MISSING', 'that database does not exist'],
  '28P01': ['DB_AUTH', 'the database rejected the credentials'],
  '23505': ['CONFLICT', 'that row already exists'],
};

function toResponse(err) {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: err.message, detail: err.detail, code: err.code } };
  }
  const pg = PG[err?.code];
  if (pg) {
    return { status: 503, body: { error: pg[1], detail: err.message, code: pg[0] } };
  }
  if (err?.code === 'ENOTFOUND' || err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED') {
    return { status: 503, body: {
      error: 'the database is not reachable', detail: err.message, code: 'DB_DOWN' } };
  }
  return { status: 500, body: { error: err?.message || 'unexpected', code: 'INTERNAL' } };
}

/**
 * Wrap a handler. A THROWN error becomes a typed response; a query that fails
 * is never quietly turned into an empty array.
 */
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    const { status, body } = toResponse(e);
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, e.message);
    res.status(status).json(body);
  }
};

module.exports = { ApiError, badRequest, notFound, refused, unauthorised, toResponse, wrap };
