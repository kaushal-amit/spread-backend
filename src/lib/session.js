'use strict';
/**
 * ============================================================================
 *  lib/session.js — THE session clock. One source for every "what time is it
 *  in the session" question.
 * ============================================================================
 * Two kinds of clock, kept apart:
 *
 *   EXCHANGE FACTS (spread.config SESSION) — open 09:00, continuous trading
 *   ends 13:00, closing auction runs to 13:25, data is complete from 13:26.
 *   `open` (can a NEW position be opened) follows the 13:00 close; the DATA
 *   WINDOW runs to 13:30 — a capture at 13:20 is real, a "market closed"
 *   verdict from a quote at 13:05 is right.
 *
 *   OPERATOR THRESHOLDS (spread.kb_threshold, migration 040) — step_down_hhmm
 *   (11:00), late_session_hhmm (12:00), hard_exit_hhmm (12:30), flat_by_hhmm
 *   (12:45). Loaded at boot and on every gate reload; the config literals are
 *   the fallback only until the rows exist.
 *
 * socket.js used to hold sessionPhase() with 540/600/660/720/780 literals,
 * /api/session had its own 720 and 660, EXIT had '11:00' and '12:30', and
 * stops.js closed the day at 13:30. They now all read from here.
 * ============================================================================
 */
const { SESSION, EXIT } = require('../config/spread.config');

const hhmmToMins = (v) => {
  if (v == null) return null;
  if (typeof v === 'string' && v.includes(':')) { const [h, m] = v.split(':').map(Number); return h * 60 + (m || 0); }
  const n = Number(v); return Math.floor(n / 100) * 60 + (n % 100);
};
const minsToClock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The fallbacks (config literals) until kb_threshold is loaded. */
const DEFAULTS = {
  openAt: hhmmToMins(SESSION.openAt),               // 09:00
  closeAt: hhmmToMins(SESSION.closeAt),             // 13:00 · continuous trading ends → canOpen false
  auctionCloseAt: hhmmToMins(SESSION.auctionCloseAt), // 13:25
  // F5 · Trading at Last: 13:10–13:30, trades at the closing-auction price only.
  // No new position; an OPEN position may still be closed (canClose) — the last
  // honest exit of the day, not "into the auction".
  talStartAt: hhmmToMins(SESSION.talStartAt),       // 13:10
  talEndAt: hhmmToMins(SESSION.talEndAt),           // 13:30
  dataWindowEndAt: 13 * 60 + 30,                    // 13:30 · captures after this are a stuck script
  stepDownAt: hhmmToMins(EXIT.stepDownAtClock),     // 11:00
  lateSessionAt: 12 * 60,                           // 12:00
  hardExitAt: hhmmToMins(EXIT.hardExitAtClock),     // 12:30
  flatByAt: 12 * 60 + 45,                           // 12:45
};
let clocks = { ...DEFAULTS, loadedFrom: 'config' };

/** Load the operator thresholds. Missing rows keep their fallback. */
async function load(db = require('../db').pool) {
  const { rows } = await db.query(
    `SELECT key, value FROM spread.kb_threshold
      WHERE still_true AND key IN ('step_down_hhmm','late_session_hhmm','hard_exit_hhmm','flat_by_hhmm');`)
    .catch(() => ({ rows: [] }));
  const t = Object.fromEntries(rows.map((r) => [r.key, hhmmToMins(r.value)]));
  clocks = {
    ...DEFAULTS,
    stepDownAt: t.step_down_hhmm ?? DEFAULTS.stepDownAt,
    lateSessionAt: t.late_session_hhmm ?? DEFAULTS.lateSessionAt,
    hardExitAt: t.hard_exit_hhmm ?? DEFAULTS.hardExitAt,
    flatByAt: t.flat_by_hhmm ?? DEFAULTS.flatByAt,
    loadedFrom: rows.length ? 'kb_threshold' : 'config',
  };
  return clocks;
}

/** The current clocks (minutes since midnight Kuwait) plus HH:MM forms. */
function get() {
  const c = clocks;
  return { ...c,
    stepDownClock: minsToClock(c.stepDownAt), lateSessionClock: minsToClock(c.lateSessionAt),
    hardExitClock: minsToClock(c.hardExitAt), flatByClock: minsToClock(c.flatByAt),
    closeClock: minsToClock(c.closeAt), dataWindowEndClock: minsToClock(c.dataWindowEndAt),
    talStartClock: minsToClock(c.talStartAt), talEndClock: minsToClock(c.talEndAt) };
}

/** Kuwait wall-clock minutes and weekday of an instant. */
function kuwait(now = new Date()) {
  const k = new Date(new Date(now).getTime() + SESSION.timezoneOffsetHours * 3600000);
  return { mins: k.getUTCHours() * 60 + k.getUTCMinutes(), dow: k.getUTCDay(), k };
}

/**
 * The phase. `open` = a new position may be opened as far as the CLOCK is
 * concerned (Sun–Thu, 09:00 ≤ t < 13:00; the stops and the calendar have
 * their own say). `canClose` = an open position may be CLOSED now: while open,
 * and during Trading at Last (13:10–13:30, at the auction price only — F5).
 * `tal` is that window. `dataWindow` = a capture now is a live capture (t < 13:30).
 */
function sessionPhase(now = new Date()) {
  const c = clocks;
  const { mins, dow } = kuwait(now);
  const weekend = dow === 5 || dow === 6;
  const dataWindow = !weekend && mins < c.dataWindowEndAt;
  const tal = !weekend && mins >= c.talStartAt && mins < c.talEndAt;
  const base = {
    minutesToStepDown: Math.max(0, c.lateSessionAt - mins),
    pastStepDown: mins >= c.stepDownAt, pastHardExit: mins >= c.hardExitAt, pastFlatBy: mins >= c.flatByAt,
    dataWindow, tal, canClose: false, clocks: get(),
  };
  if (weekend) return { ...base, open: false, phase: 'closed', note: 'weekend', minutesToStepDown: 0 };
  if (mins < c.openAt) return { ...base, open: false, phase: 'pre_open', note: `opens at ${minsToClock(c.openAt)}` };
  if (tal) return { ...base, open: false, canClose: true, phase: 'tal', note: `Trading at Last to ${minsToClock(c.talEndAt)} — close at the auction price only, no new positions`, minutesToStepDown: 0 };
  if (mins >= c.closeAt) return { ...base, open: false, phase: 'closed', note: mins < c.talStartAt ? `closing auction — no new positions; Trading at Last opens ${minsToClock(c.talStartAt)}` : 'session over', minutesToStepDown: 0 };
  if (mins < c.openAt + 60) return { ...base, open: true, canClose: true, phase: 'open', note: 'first hour — widest spreads' };
  if (mins < c.stepDownAt) return { ...base, open: true, canClose: true, phase: 'peak', note: 'peak hour' };
  if (mins < c.lateSessionAt) return { ...base, open: true, canClose: true, phase: 'step_down', note: 'past the step-down' };
  return { ...base, open: true, canClose: true, phase: 'late', note: 'last hour — drift is negative' };
}

module.exports = { load, get, sessionPhase, kuwait, hhmmToMins, minsToClock, DEFAULTS };
