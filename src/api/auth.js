'use strict';
/**
 * ============================================================================
 *  auth.js — a shared secret on every write
 * ============================================================================
 * `POST /api/ledger` moves money. `POST /api/trading/record` writes the trading
 * record. `PUT /api/gates/:id` changes what the screen will trade tomorrow.
 * All three were open.
 *
 * DELIBERATELY MINIMAL. This is a single-operator system on one account, so a
 * shared secret is the right weight — sessions, roles and a user table would be
 * ceremony around one person. What it must NOT be is absent at a public
 * hostname.
 *
 * READS STAY OPEN when no token is configured, so localhost keeps working
 * unchanged. Configure SPREAD_API_TOKEN and everything is checked.
 * ============================================================================
 */

const { unauthorised } = require('./errors');

const TOKEN = process.env.SPREAD_API_TOKEN || null;
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.get('x-spread-token') || null);
}

function middleware(req, res, next) {
  if (!TOKEN) {
    /*
     * No token configured. Reads and writes both pass — but say so ONCE at
     * boot rather than silently, because "it worked on localhost" is how an
     * open write endpoint reaches a public hostname.
     */
    return next();
  }
  if (!WRITE.has(req.method)) return next();
  if (bearer(req) === TOKEN) return next();

  const e = unauthorised('this endpoint requires a token');
  res.status(e.status).json({ error: e.message, code: e.code,
    detail: 'set SPREAD_API_TOKEN in the backend and send it as Authorization: Bearer <token>' });
}

function warnIfOpen(log = console) {
  if (!TOKEN) {
    log.warn('[auth] SPREAD_API_TOKEN is not set — ledger, trading and gate writes are OPEN. ' +
             'Acceptable on localhost; set it before any public hostname.');
  }
  const origin = process.env.CORS_ORIGIN;
  if (!origin || origin === '*') {
    log.warn('[auth] CORS_ORIGIN is "*" — set it to the terminal origin before deploying.');
  }
}

module.exports = { middleware, warnIfOpen, hasToken: () => !!TOKEN };
