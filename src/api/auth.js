'use strict';
const log = require('../lib/log');
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
 * ─── REQUIRED OFF LOOPBACK, OPTIONAL ON IT ─────────────────────────────────
 *
 * An unset token used to let every write through from ANY host. No error, and
 * behaviour that looks correct right up until the service has a public
 * hostname — the same shape as every other failure found this week: silent,
 * plausible, wrong.
 *
 * So: with no token configured, a write from 127.0.0.1 passes and a write from
 * anywhere else is REFUSED, naming the reason. Development is unchanged and
 * "it worked on localhost" can no longer become an open write endpoint.
 * ============================================================================
 */

const crypto = require('crypto');
const { unauthorised } = require('./errors');

const TOKEN = process.env.SPREAD_API_TOKEN || null;

/*
 * Phase 3 · READS TOO.
 *
 * Writes were checked and reads were open: /api/ledger, /api/account,
 * /api/orders and /api/ai/history — the whole account — to anyone who could
 * reach the port. A trading terminal's reads ARE the sensitive surface. The
 * one exception is /api/health, which a load balancer must be able to call
 * and which returns nothing about the account.
 */
const OPEN_PATHS = new Set(['/health']);

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.get('x-spread-token') || null);
}

/** Constant-time. `===` leaks the length and the position of the first mismatch. */
function tokenMatches(presented) {
  if (!TOKEN || typeof presented !== 'string') return false;
  const a = Buffer.from(presented), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Is this request from the machine the server runs on?
 *
 * ::1 and ::ffff:127.0.0.1 are the IPv6 forms Node reports for a loopback
 * connection, and both must count or a local request is refused as remote.
 *
 * A forwarded header is NOT trusted: anything behind a proxy is remote by
 * definition, and X-Forwarded-For can be set by the caller.
 */
function isLoopback(req) {
  if (req.get('x-forwarded-for')) return false;
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

let warned = false;

function middleware(req, res, next) {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.method === 'OPTIONS') return next();

  if (!TOKEN) {
    if (isLoopback(req)) {
      // Once, not per request: a warning on every call is a warning nobody
      // reads.
      if (!warned) {
        warned = true;
        log.warn('[auth] SPREAD_API_TOKEN is not set. The API answers loopback only. '
          + 'Set it before this service has a public hostname.');
      }
      return next();
    }

    const e = unauthorised('the API requires a token when the request is not local');
    return res.status(e.status).json({
      error: e.message,
      code: e.code,
      detail: 'SPREAD_API_TOKEN is not configured on this server, so the API is '
        + 'restricted to 127.0.0.1. Set it and send Authorization: Bearer <token>.',
    });
  }
  if (tokenMatches(bearer(req))) return next();

  const e = unauthorised('this endpoint requires a token');
  res.status(e.status).json({ error: e.message, code: e.code,
    detail: 'set SPREAD_API_TOKEN in the backend and send it as Authorization: Bearer <token>' });
}

/**
 * Socket.IO handshake. The token travels in `auth: { token }` on connect (the
 * socket.io-client option), or the connection must be from loopback.
 */
function socketMiddleware(socket, next) {
  const presented = socket.handshake?.auth?.token || socket.handshake?.headers?.['x-spread-token'] || null;
  const addr = socket.handshake?.address || '';
  const fwd = socket.handshake?.headers?.['x-forwarded-for'];
  const local = !fwd && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
  if (TOKEN ? tokenMatches(presented) : local) return next();
  const e = new Error(TOKEN ? 'socket requires a token' : 'socket answers loopback only until SPREAD_API_TOKEN is set');
  e.data = { code: 'UNAUTHORISED' };
  return next(e);
}

/**
 * Refuse to start misconfigured in production. A warning is read once; a
 * process that will not boot is read every time.
 */
function assertProductionConfig({ env = process.env, log: out = log } = {}) {
  const prod = env.NODE_ENV === 'production';
  const origin = env.CORS_ORIGIN;
  const problems = [];
  if (!TOKEN) problems.push('SPREAD_API_TOKEN is not set — the API and socket answer loopback only');
  if (!origin || origin === '*') problems.push('CORS_ORIGIN is unset or "*" — set it to the terminal origin');
  if (prod && problems.length) {
    out.error('[auth] refusing to start in production:\n  ' + problems.join('\n  ')
      + '\n  see .env.example, "PRODUCTION"');
    return false;
  }
  for (const p of problems) out.warn('[auth] ' + p);
  // Advisory in production: the model id must be pinned, or an upstream
  // default change alters every answer overnight without a deploy.
  if (prod && !env.ANTHROPIC_MODEL) out.warn('[auth] ANTHROPIC_MODEL is not pinned — the AI layer will use the code default');
  return true;
}

function warnIfOpen(out = log) { return assertProductionConfig({ log: out }); }

module.exports = { middleware, socketMiddleware, warnIfOpen, assertProductionConfig,
  tokenMatches, hasToken: () => !!TOKEN };
