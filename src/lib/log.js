'use strict';
/**
 * ============================================================================
 *  lib/log.js — one JSON line per event, with a level (Step 3.7 / S-06)
 * ============================================================================
 * console.log scattered through seven files produced lines nothing could
 * filter: a boot message, a refused write and a socket disconnect all looked
 * the same to a log shipper. Every line here is
 *
 *   {"t":"2026-09-04T06:00:00.000Z","level":"warn","msg":"…","…fields"}
 *
 * LOG_LEVEL=debug|info|warn|error (default info) drops anything below it.
 * LOG_FORMAT=pretty (the default on a TTY) prints `HH:MM:SS level msg {…}`
 * for a human; JSON is the default everywhere else. Hand-rolled on purpose:
 * pino would be a dependency for forty lines, and this service has four.
 * ============================================================================
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold() {
  return LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
}
function pretty() {
  const f = process.env.LOG_FORMAT;
  if (f) return f === 'pretty';
  return !!process.stdout.isTTY;
}

/** Fields from the trailing arguments: an Error, an object, or loose values. */
function fieldsOf(rest) {
  const out = {};
  const loose = [];
  for (const r of rest) {
    if (r instanceof Error) { out.err = r.message; if (r.code) out.code = r.code; if (r.stack && threshold() <= LEVELS.debug) out.stack = r.stack; }
    else if (r && typeof r === 'object' && !Array.isArray(r)) Object.assign(out, r);
    else loose.push(r);
  }
  if (loose.length) out.detail = loose.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  return out;
}

// warn and error go to stderr, so `2>` catches what needs a human; the rest
// to stdout. Both are one JSON object per line.
const defaultSink = (line, level) => (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line + '\n');
let sink = defaultSink;

function emit(level, msg, rest) {
  if (LEVELS[level] < threshold()) return;
  const rec = { t: new Date().toISOString(), level, msg: String(msg), ...fieldsOf(rest) };
  if (pretty()) {
    const { t, level: l, msg: m, ...f } = rec;
    sink(`${t.slice(11, 19)} ${l.padEnd(5)} ${m}${Object.keys(f).length ? ' ' + JSON.stringify(f) : ''}`, level);
  } else {
    sink(JSON.stringify(rec), level);
  }
}

const log = {
  debug: (msg, ...rest) => emit('debug', msg, rest),
  info: (msg, ...rest) => emit('info', msg, rest),
  warn: (msg, ...rest) => emit('warn', msg, rest),
  error: (msg, ...rest) => emit('error', msg, rest),
  /** A logger that stamps a component on every line. */
  child: (fields) => ({
    debug: (m, ...r) => emit('debug', m, [fields, ...r]),
    info: (m, ...r) => emit('info', m, [fields, ...r]),
    warn: (m, ...r) => emit('warn', m, [fields, ...r]),
    error: (m, ...r) => emit('error', m, [fields, ...r]),
  }),
  /** Tests only: capture the lines instead of writing them. */
  _sink: (fn) => { sink = fn || defaultSink; },
  LEVELS,
};

module.exports = log;
