'use strict';
/**
 * ============================================================================
 *  thresholds.js — the ONE threshold store (R-36 · BACKEND_spec §1.1)
 * ============================================================================
 * BACKEND_spec §1.1: "loaded once at boot into a typed config object… a missing
 * key must fail at boot." Before this, `spread.kb_threshold` was read per
 * request by the sizing/stops/halt services, while the SCREENING gates took
 * their numbers from `spread.config.js`. Two stores: changing 30 → 45 in the
 * table moved sizing and not the funnel.
 *
 * Now every gate threshold that has a `kb_threshold` row is sourced HERE. The
 * table is read once at boot into a frozen object; a REQUIRED key that is
 * missing aborts boot with its name rather than defaulting silently at request
 * time. `spread.config.js` keeps the shape and the evidence — not the numbers
 * the gates enforce.
 * ============================================================================
 */

const { pool } = require('../db');

/*
 * The gate thresholds now sourced from the table, each with the spread.config.js
 * value it replaced (migration 027 seeds these). A key the funnel reads that is
 * absent from the table aborts boot — the spec's "must fail at boot, not
 * silently default." Keys read only by a per-service loader (stops, halts,
 * sizing) keep their own require-at-use checks and are not repeated here.
 */
const REQUIRED = Object.freeze([
  'tick_min_price',            // GATES.priceFloorFils   100
  'net_floor_kd',              // GATES.netFloorKd        0.5
  'avg_trade_shares_min',      // GATES.minAvgTradeShares 3000
  'moves_min',                 // GATES.minPriceMoves     15
  'up2_min',                   // GATES.minPriceMoves2plus 3
  'tiny_pct_max',              // GATES.maxPctMovesSub100 20
  'postable_min_pct',          // GATES.minPctPostable    20
  'exitable_ratio_min_pct',    // GATES.minPctExitableRatio 70
  'exitable_size_min_pct',     // GATES.minPctExitableForSize 60
  'dist_volume_ratio',         // GATES.distVolumeRatio   2.0
  'dist_flow_ratio',           // GATES.distFlowRatio     1.3
  'days_active_min',           // GATES.minDaysActive5d   3
  'gap2_min_pct',              // TARGETS.minGapPctFor2Tick 30
  'range3_min_fils',           // TARGETS.minRangeFilsFor3Tick 6
  'exit_target_normal_fils',   // EXIT.targetNormalTicks   2  (A1, seeded — measured winner replaces)
  'exit_target_trending_fils', // EXIT.targetTrendingTicks 6  (A1, stays 6)
  'exit_hold_to_flat',         // EXIT.holdToFlatBy        1  (A1)
]);

let store = null;   // the frozen object, or null before load()

/**
 * Read spread.kb_threshold once. A REQUIRED key that is absent (or not a finite
 * number) throws NAMING the key — the caller is boot, so a bad table stops the
 * server rather than surfacing as a request-time notReady later.
 */
async function load(db = pool) {
  const { rows } = await db.query('SELECT key, value FROM spread.kb_threshold WHERE still_true');
  const out = {};
  for (const r of rows) { const v = Number(r.value); if (Number.isFinite(v)) out[r.key] = v; }
  const missing = REQUIRED.filter((k) => !Number.isFinite(out[k]));
  if (missing.length) {
    throw new Error(`kb_threshold is missing at boot: ${missing.join(', ')} — run npm run migrate (027 seeds the gate thresholds)`);
  }
  store = Object.freeze(out);
  return store;
}

/** The frozen object, or {} before load() — callers fall back to file defaults. */
function all() { return store || {}; }

/** One value, or undefined when the store is not loaded / the key is absent. */
function get(key) { return store ? store[key] : undefined; }

/** Test-only: drop the loaded store so a fresh load() can be observed. */
function _reset() { store = null; }

module.exports = { load, all, get, REQUIRED, _reset };
