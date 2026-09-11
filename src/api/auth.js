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

/**
 * The floor for SPREAD_API_TOKEN. The deployed value was 8 characters, shared
 * with the scraper's ingest token and compiled into the public terminal
 * bundle. In production a token under this length refuses to boot
 * (assertProductionConfig); elsewhere it warns.
 */
const MIN_TOKEN_LENGTH = 24;

/**
 * Behind a reverse proxy (TRUST_PROXY set) nothing is loopback: the socket
 * peer is always nginx on 127.0.0.1, so "is this request local?" cannot be
 * answered from the address, and the X-Forwarded-For check below only fires
 * when nginx sets that header. The operator states the topology in
 * TRUST_PROXY (index.js); this reads the same variable so the two agree.
 */
const BEHIND_PROXY = (() => {
  const raw = process.env.TRUST_PROXY;
  return raw != null && raw !== '' && raw !== 'false';
})();

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
  if (BEHIND_PROXY) return false;
  if (req.get('x-forwarded-for')) return false;
  const ip = req.ip || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

let warned = false;

/*
 * ─── D3 · TWO CREDENTIALS, ONE DECISION ──────────────────────────────────────
 *
 * The static SPREAD_API_TOKEN used to be compiled into the public terminal
 * bundle — anyone who loaded the site once held it. Now:
 *
 *   service   the static token, presented by the scraper, the scripts, the
 *             cron jobs. Accepted from ANY address (it is no longer in a
 *             browser), compared constant-time, first because it is cheap.
 *   user      a Firebase ID token from the SPA (Google sign-in). Verified by
 *             lib/firebaseAuth (Admin SDK, local signature check), then the
 *             uid must be in SPREAD_ALLOWED_UIDS. Cached by token hash until
 *             its exp so a 10-second poll does not re-verify the same JWT.
 *
 * The refusal names its reason — NO_TOKEN, BAD_TOKEN, TOKEN_EXPIRED,
 * UID_NOT_ALLOWED, NOT_CONFIGURED — because the SPA acts on it: expired →
 * refresh and retry once; not allowed → show the sentence and a sign-out.
 * A signed-in stranger is logged with the email: the loud form of "someone
 * who is not you signed in".
 */
const ALLOWED_UIDS = new Set(String(process.env.SPREAD_ALLOWED_UIDS || '')
  .split(',').map((x) => x.trim()).filter(Boolean));
let verifier = null;                 // injectable: tests pass { verify }
const setVerifier = (v) => { verifier = v; verified.clear(); };
const getVerifier = () => verifier || require('../lib/firebaseAuth');
const verified = new Map();          // sha256(token) -> { uid, email, exp }
const VERIFIED_MAX = 100;

class AuthRefused extends Error {
  constructor(code, message, status = 401) { super(message); this.code = code; this.status = status; }
}

/**
 * → { kind: 'service' } | { kind: 'user', uid, email, exp }
 * throws AuthRefused(code)
 */
async function authenticate(presented, { local = false } = {}) {
  // No service token configured: loopback passes as before (development),
  // whatever it presents; anything else is refused naming the variable.
  if (!TOKEN && local) return { kind: 'local' };
  if (!presented) {
    throw new AuthRefused('NO_TOKEN', TOKEN
      ? 'this endpoint requires a sign-in or a service token'
      : 'the API requires a token when the request is not local');
  }
  if (tokenMatches(presented)) return { kind: 'service' };
  // Not the service token → it must be a sign-in. A short opaque string is
  // never a JWT; refuse it as BAD_TOKEN without asking the verifier.
  if (typeof presented !== 'string' || presented.split('.').length !== 3) {
    throw new AuthRefused('BAD_TOKEN', 'the token is neither the service token nor a sign-in token');
  }
  const key = crypto.createHash('sha256').update(presented).digest('hex');
  const hit = verified.get(key);
  const nowS = Math.floor(Date.now() / 1000);
  if (hit && hit.exp > nowS) return { kind: 'user', ...hit };
  if (hit) verified.delete(key);
  let d;
  try { d = await getVerifier().verify(presented); }
  catch (e) {
    if (e?.code === 'NOT_CONFIGURED') throw new AuthRefused('NOT_CONFIGURED', e.message);
    throw new AuthRefused(e?.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'BAD_TOKEN', e.message || 'the sign-in token is not valid');
  }
  if (!ALLOWED_UIDS.has(d.uid)) {
    log.warn('[auth] sign-in refused: uid not in SPREAD_ALLOWED_UIDS', { uid: d.uid, email: d.email });
    throw new AuthRefused('UID_NOT_ALLOWED', `${d.email || d.uid} is signed in but not allowed on this terminal`, 403);
  }
  const user = { uid: d.uid, email: d.email || null, exp: d.exp };
  if (verified.size >= VERIFIED_MAX) verified.delete(verified.keys().next().value);
  verified.set(key, user);
  return { kind: 'user', ...user };
}

function middleware(req, res, next) {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.method === 'OPTIONS') return next();

  const local = isLoopback(req);
  if (!TOKEN && local) {
    // Once, not per request: a warning on every call is a warning nobody
    // reads.
    if (!warned) {
      warned = true;
      log.warn('[auth] SPREAD_API_TOKEN is not set. The API answers loopback only. '
        + 'Set it before this service has a public hostname.');
    }
    req.auth = { kind: 'local' };
    return next();
  }
  authenticate(bearer(req), { local }).then((a) => { req.auth = a; next(); }).catch((e) => {
    const status = e instanceof AuthRefused ? e.status : 401;
    const code = e instanceof AuthRefused ? e.code : 'UNAUTHORISED';
    res.status(status).json({
      error: e.message, code: status === 401 ? 'UNAUTHORISED' : 'FORBIDDEN', reason: code,
      detail: !TOKEN
        ? 'SPREAD_API_TOKEN is not configured on this server, so the API is restricted to 127.0.0.1. Set it and send Authorization: Bearer <token>.'
        : code === 'NOT_CONFIGURED' ? 'set FIREBASE_PROJECT_ID (and SPREAD_ALLOWED_UIDS) on the backend to accept sign-ins'
        : code === 'UID_NOT_ALLOWED' ? 'add the uid to SPREAD_ALLOWED_UIDS on the backend'
        : code === 'TOKEN_EXPIRED' ? 'refresh the sign-in token and retry'
        : 'sign in on the terminal, or send the service token as Authorization: Bearer <token>',
    });
  });
}

/**
 * Socket.IO handshake. The token travels in `auth: { token }` on connect (the
 * socket.io-client option — a FUNCTION on the client, so a reconnect presents
 * a fresh ID token), or the connection must be from loopback.
 *
 * A socket authenticated with an ID token is DISCONNECTED at the token's exp
 * (a 09:00 socket must not stay authorised all day after a sign-out): the
 * server emits `spread:reauth` then disconnects; the client reconnects with
 * a fresh token and re-watches. A service socket has no exp and lives on.
 */
function socketMiddleware(socket, next) {
  const presented = socket.handshake?.auth?.token || socket.handshake?.headers?.['x-spread-token'] || null;
  const addr = socket.handshake?.address || '';
  const fwd = socket.handshake?.headers?.['x-forwarded-for'];
  const local = !BEHIND_PROXY && !fwd && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
  authenticate(presented, { local }).then((a) => {
    socket.data = socket.data || {};
    socket.data.auth = a;
    if (a.kind === 'user' && a.exp) {
      const ms = Math.max(0, a.exp * 1000 - Date.now());
      const t = setTimeout(() => {
        socket.emit('spread:reauth', { reason: 'TOKEN_EXPIRED', at: new Date().toISOString() });
        socket.disconnect(true);
      }, ms);
      socket.on('disconnect', () => clearTimeout(t));
    }
    next();
  }).catch((err) => {
    const e = new Error(TOKEN ? err.message : 'socket answers loopback only until SPREAD_API_TOKEN is set');
    e.data = { code: err instanceof AuthRefused && err.status === 403 ? 'FORBIDDEN' : 'UNAUTHORISED', reason: err.code || 'NO_TOKEN' };
    next(e);
  });
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
  else if (TOKEN.length < MIN_TOKEN_LENGTH) {
    problems.push(`SPREAD_API_TOKEN is ${TOKEN.length} characters — use at least ${MIN_TOKEN_LENGTH}: `
      + 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
  }
  if (!origin || origin === '*') problems.push('CORS_ORIGIN is unset or "*" — set it to the terminal origin');
  // D3 · the terminal signs in; without a project id no sign-in verifies and
  // without an allowlist no signed-in user is allowed. Both are needed for the
  // SPA to reach the API at all in production — refuse rather than serve 401s.
  if (!env.FIREBASE_PROJECT_ID) problems.push('FIREBASE_PROJECT_ID is not set — the terminal\'s sign-in cannot be verified');
  if (!String(env.SPREAD_ALLOWED_UIDS || '').trim()) problems.push('SPREAD_ALLOWED_UIDS is empty — no signed-in user is allowed');
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
  tokenMatches, hasToken: () => !!TOKEN, MIN_TOKEN_LENGTH, isLoopback,
  authenticate, setVerifier, AuthRefused, allowedUids: () => new Set(ALLOWED_UIDS) };
