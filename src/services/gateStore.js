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
const thresholds = require('../config/thresholds');
const { refused } = require('../api/errors');

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

/*
 * R-36 · the ONE threshold store. Each gate id below draws its enforced number
 * from a spread.kb_threshold row (loaded once at boot by config/thresholds.js),
 * not from spread.config.js. The file keeps the same value as the seed and the
 * evidence behind it, but the TABLE is what a change edits — a `PUT /gates` on
 * one of these writes the row and reloads the store, so the funnel and the
 * sizing service now read the same number. Keys not listed here (target
 * toggles, direction mode, the budget slot) stay in gate_config as before.
 */
const KB = {
  'g1-floor':       'tick_min_price',
  'g2-net':         'net_floor_kd',
  'g3-size':        'avg_trade_shares_min',
  'g4-moves':       'moves_min',
  'g5-tape':        'tiny_pct_max',
  'g6-postable':    'postable_min_pct',
  'g7-exit':        'exitable_ratio_min_pct',
  'g8-dist':        'dist_volume_ratio',
  'g8-flow':        'dist_flow_ratio',
  'g9-consistency': 'days_active_min',
  'target-2gap-pct': 'gap2_min_pct',
  'target-3range':   'range3_min_fils',
};
/* Gate thresholds with a kb row but no operator control on the board — still
 * sourced from the table so the store is genuinely single. */
const KB_EXTRA = {
  'GATES.minPriceMoves2plus':      'up2_min',
  'GATES.minPctExitableForSize':   'exitable_size_min_pct',
};

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
  // R-36 · the gate thresholds, into the frozen store effective() reads. The
  // authoritative boot check (a missing key aborts) lives in index.js; here it
  // is best-effort so a unit test that only loads gate overrides still gets the
  // table's numbers when the DB has them, and the file defaults when it does not.
  await thresholds.load(db).catch(() => {});
  return { version, overrides, loadedAt };
}

/*
 * R-36 · a gate edit for a kb-backed threshold writes the ROW, then reloads the
 * store so effective() serves the new number. Returned so the caller can bump a
 * gate_config version (invalidating the board cache) in the same action.
 */
async function writeThreshold(key, value, { changedBy = 'ui', db = pool } = {}) {
  await db.query(
    `UPDATE spread.kb_threshold
        SET prev_value = value, value = $2, changed_on = current_date, changed_by = $3
      WHERE key = $1`, [key, value, changedBy]);
  await thresholds.load(db);
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

  /*
   * R-36 · the table is the source for every gate threshold with a kb row. When
   * the store is loaded (at boot, and after a PUT /gates reload) its value wins
   * over the file default; before it loads — a unit test that never touched the
   * DB — the file default stands, so nothing here depends on a live table.
   */
  const t = thresholds.all();
  for (const [id, key] of Object.entries(KB)) {
    const v = t[key]; if (v == null || Number.isNaN(Number(v))) continue;
    const b = BINDING[id]; if (!b) continue;
    out[b[0]][b[1]] = Number(v);
  }
  for (const [path, key] of Object.entries(KB_EXTRA)) {
    const v = t[key]; if (v == null || Number.isNaN(Number(v))) continue;
    const [sec, f] = path.split('.'); out[sec][f] = Number(v);
  }

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
    // B-14 · an ApiError, so errors.js answers 409 rather than 500.
    throw refused(`${locked.join(', ')} cannot be changed — it is structural, not a preference`,
      'Below 100 fils the exchange tick is 0.1 fil. One tick pays about 1.05 KD ' +
      'against 3.36 in commission: negative at any budget, on any day.');
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

/*
 * A2 · the session budget's ONE source. The operator's set value from the gate
 * store — NOT the file default, which is a seed, not a runtime fallback. Returns
 * null when no budget has been set, so the caller answers 503 NOT_READY rather
 * than sizing off a literal (the R-36 pattern). `/sizing`'s old 720 default and
 * the file's slot are both gone from the live path.
 */
function sessionBudgetKd() {
  const o = overrides['session-budget'];
  const v = o && typeof o === 'object' ? o.numericValue : o;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const meta = () => ({ version, loadedAt, overrides, locked: [...LOCKED] });

module.exports = { load, effective, save, meta, writeThreshold, sessionBudgetKd, BINDING, LOCKED, KB };
