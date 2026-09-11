'use strict';
/**
 * api/ratelimit.js — a token bucket per key, in memory.
 *
 * Single-process, single-operator: an in-memory bucket is the right weight.
 * If a second backend instance ever exists, this moves to Postgres or Redis —
 * and the header of gateStore.js already says the same about its own state.
 */
function bucket({ capacity, refillPerSec }) {
  const state = new Map();     // key -> { tokens, at }
  return {
    take(key, cost = 1) {
      const now = Date.now();
      const b = state.get(key) || { tokens: capacity, at: now };
      b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
      b.at = now;
      if (b.tokens < cost) { state.set(key, b); return { ok: false, retryAfterSec: Math.ceil((cost - b.tokens) / refillPerSec) }; }
      b.tokens -= cost; state.set(key, b);
      return { ok: true };
    },
    // Housekeeping so a long-running process does not keep every IP forever.
    sweep(olderThanMs = 3600000) {
      const cut = Date.now() - olderThanMs;
      for (const [k, b] of state) if (b.at < cut) state.delete(k);
    },
  };
}

/** Express middleware. `keyOf` defaults to the client IP. */
function limit({ capacity = 10, refillPerSec = 10 / 60, keyOf = (req) => req.ip } = {}) {
  const b = bucket({ capacity, refillPerSec });
  setInterval(() => b.sweep(), 600000).unref();
  return (req, res, next) => {
    const r = b.take(keyOf(req));
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: 'too many requests', code: 'RATE_LIMITED',
      detail: `try again in ${r.retryAfterSec}s` });
  };
}

/** A concurrency gate: at most N in flight. */
function concurrency(max = 2) {
  let inFlight = 0;
  return (req, res, next) => {
    if (inFlight >= max) {
      return res.status(429).json({ error: 'busy', code: 'RATE_LIMITED',
        detail: `${max} question${max === 1 ? '' : 's'} already in flight` });
    }
    inFlight += 1;
    // ONE decrement per request. Both 'finish' and 'close' fire on a normal
    // response, so the count went down twice and concurrency(2) let three
    // through; a flag makes the second event a no-op.
    let released = false;
    const release = () => { if (released) return; released = true; inFlight = Math.max(0, inFlight - 1); };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

module.exports = { bucket, limit, concurrency };
