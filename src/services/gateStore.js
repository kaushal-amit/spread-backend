'use strict';
/**
 * ============================================================================
 *  gateStore.js — the gate thresholds that are actually enforced
 * ============================================================================
 * `PUT /gates/:id` used to insert a version row that NOTHING EVER READ. The
 * screening funnel took its thresholds from `spread.config.js`, so an edit
 * appeared to save and changed nothing — the worst possible outcome, because
 * the operator then believes the board reflects a setting it does not.
 *
 * Now the newest `gate_config` row is loaded at boot and merged OVER the file
 * defaults. The file remains the source of the EVIDENCE and the shape; the
 * database carries the operator's overrides.
 * ============================================================================
 */

const { pool } = require('../db');
const { GATES, DIRECTION, EXIT, BUDGET, QUALITY } = require('../config/spread.config');

/** Which config key each gate id writes to. One place, so a rename cannot drift. */
const BINDING = {
  'g1-floor':        ['GATES', 'priceFloorFils'],
  'g2-net':          ['GATES', 'netFloorKd'],
  'g3-size':         ['GATES', 'minAvgTradeShares'],
  'g4-moves':        ['GATES', 'minPriceMoves'],
  'g5-tape':         ['GATES', 'maxPctMovesSub100'],
  'g6-postable':     ['GATES', 'minPctPostable'],
  'g7-exit':         ['GATES', 'minPctExitableRatio'],
  'g8-dist':         ['GATES', 'distVolumeRatio'],
  'g9-consistency':  ['GATES', 'minDaysActive5d'],
  'g10-direction':   ['DIRECTION', 'warnChange1dFils'],
  'session-budget':  ['BUDGET', 'slotKd'],
  'quality-capture': ['QUALITY', 'minCapturePct'],
  /*
   * N-08 · five controls existed on screen with nowhere to be saved.
   *
   * The outward-flow half of Gate 8 and the whole target-capture block lived
   * only in the page's local state, so those toggles were exactly the pre-fix
   * bug: they appeared to save and changed nothing.
   *
   * The target checkboxes are stored as 1/0 — a wider capture is a HARDER
   * capture, and turning one on changes which stocks are even in band.
   */
  'g8-flow':          ['GATES', 'distFlowRatio'],
  'target-1tick':     ['TARGETS', 'allow1Tick'],
  'target-2ticks':    ['TARGETS', 'allow2Ticks'],
  'target-3ticks':    ['TARGETS', 'allow3Ticks'],
  'target-2gap-pct':  ['TARGETS', 'minGapPctFor2Tick'],
  'target-3range':    ['TARGETS', 'minRangeFilsFor3Tick'],
};

/*
 * G1's FLOOR CANNOT BE OVERRIDDEN, and the refusal lives here rather than in
 * the UI. Below 100 fils the exchange tick is 0.1: one tick pays about 1.05 KD
 * against 3.36 in commission, negative at any budget on any day. That is
 * arithmetic, not judgement, and a control that only ever loses money should
 * not exist at any layer.
 */
const LOCKED = new Set(['g1-floor']);

let overrides = {};
let version = 0;
let loadedAt = null;

async function load(db = pool) {
  const { rows } = await db.query(
    `SELECT version, config, effective_from FROM spread.gate_config
      ORDER BY version DESC LIMIT 1;`);
  if (rows[0]) {
    overrides = rows[0].config || {};
    version = Number(rows[0].version);
    loadedAt = rows[0].effective_from;
  }
  return { version, overrides, loadedAt };
}

/** The effective config: file defaults with the stored overrides on top. */
function effective() {
  const out = {
    GATES: { ...GATES }, DIRECTION: { ...DIRECTION },
    EXIT: { ...EXIT }, BUDGET: { ...BUDGET }, QUALITY: { ...QUALITY },
    /*
     * Target capture. Default 1 and 2 ON, 3 OFF — every fill in the record has
     * been a 1-fil target and a 3-tick capture has never been attempted, so
     * shipping it on would put untested trades at the top of the board.
     */
    TARGETS: {
      allow1Tick: 1, allow2Ticks: 1, allow3Ticks: 0,
      // A 2-fil spread must be present often enough to enter at queue zero.
      // One stock had the widest range on the board at 16.6 fils and still
      // failed: its gap was present only 22% of the session.
      minGapPctFor2Tick: 30,
      minRangeFilsFor3Tick: 6,
    },
  };
  for (const [id, val] of Object.entries(overrides)) {
    const b = BINDING[id];
    if (!b || LOCKED.has(id)) continue;
    const v = typeof val === 'object' ? val.numericValue : val;
    if (v == null || Number.isNaN(Number(v))) continue;
    out[b[0]][b[1]] = Number(v);
    if (id === 'g10-direction' && typeof val === 'object' && val.mode) {
      // The explicit switch. Setting a threshold without also setting mode
      // does nothing, so intent is read once rather than inferred.
      out.DIRECTION.mode = val.mode === 'block' ? 'block' : 'warn';
    }
  }
  return out;
}

/** One version row per user action, not one per gate. */
async function save(changes, { changedBy = 'ui', note = null, db = pool,
                              passesBefore = null, passesAfter = null } = {}) {
  const locked = Object.keys(changes).filter((id) => LOCKED.has(id));
  if (locked.length) {
    const e = new Error(`${locked.join(', ')} cannot be changed — it is structural, not a preference`);
    e.status = 409; e.code = 'REFUSED';
    e.detail = 'Below 100 fils the exchange tick is 0.1 fil. One tick pays about 1.05 KD ' +
               'against 3.36 in commission: negative at any budget, on any day.';
    throw e;
  }

  const merged = { ...overrides, ...changes };
  const { rows: [r] } = await db.query(
    `INSERT INTO spread.gate_config
       (version, config, changed_by, change_note, passes_before, passes_after)
     VALUES ((SELECT COALESCE(max(version),0)+1 FROM spread.gate_config), $1,$2,$3,$4,$5)
     RETURNING version, effective_from;`,
    [JSON.stringify(merged), changedBy, note, passesBefore, passesAfter]);

  overrides = merged;
  version = Number(r.version);
  loadedAt = r.effective_from;
  return { version, loadedAt };
}

const meta = () => ({ version, loadedAt, overrides, locked: [...LOCKED] });

module.exports = { load, effective, save, meta, BINDING, LOCKED };
