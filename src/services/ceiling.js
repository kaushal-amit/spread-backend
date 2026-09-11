'use strict';
/**
 * ============================================================================
 *  services/ceiling.js — the 3.5 KD band ceiling cannot be forgotten on 1 Oct
 * ============================================================================
 * `ceilingCommissionKd` (3.5) bounds the price bands: it is the most commission
 * a round trip may carry, resting on the pre-October 3.4 KD trip (0.15% × 2 +
 * 0.500 × 2). From 1 October 2026 the settlement fee is gone and the figure
 * is stale by 1 KD — every band boundary moves — but a threshold does not
 * expire on its own. commission.js says "re-derive it on that date"; this is
 * the thing that makes sure it happens:
 *
 *   - at boot, and once a day, from the abolition date onward: if no
 *     gate_config version has set `band-ceiling` on or after that date, a WARN
 *     line and a data_alarm (CEILING_NOT_REDERIVED) — open until the operator
 *     saves a value (PUT /gates {"band-ceiling": …}), which is what
 *     "re-derived" means.
 * ============================================================================
 */
const { pool } = require('../db');
const { COMMISSION } = require('../config/spread.config');
const log = require('../lib/log');

const ABOLISHED = COMMISSION.settlementAbolishedFrom; // '2026-10-01'

/** Has band-ceiling been saved on/after the abolition date? */
async function rederived(db = pool) {
  const { rows } = await db.query(
    `SELECT version, effective_from, config->>'band-ceiling' AS ceiling
       FROM spread.gate_config
      WHERE config ? 'band-ceiling' AND effective_from >= $1::date
      ORDER BY version DESC LIMIT 1;`, [ABOLISHED]).catch(() => ({ rows: [] }));
  return rows[0] ? { yes: true, version: Number(rows[0].version), at: rows[0].effective_from, value: Number(rows[0].ceiling) } : { yes: false };
}

/**
 * The check. `day` is the Kuwait day being judged (today). Returns what it
 * found so a caller can surface it; raises the alarm itself.
 */
async function check(day, { db = pool, current = null } = {}) {
  if (day < ABOLISHED) return { due: false, rederived: null };
  const r = await rederived(db);
  if (r.yes) return { due: true, rederived: r };
  const detail = {
    note: `the settlement fee was abolished on ${ABOLISHED}; ceilingCommissionKd (${current ?? '?'}) still rests on the `
      + '3.4 KD pre-October round trip and has not been re-derived — every band boundary is 1 KD too tight',
    fix: 'PUT /gates {"band-ceiling": <new KD>} — saving any value on/after the date clears this',
  };
  log.warn(`[ceiling] ${detail.note}`);
  await db.query(
    `INSERT INTO spread.data_alarm (trading_day, table_name, column_name, alarm, detail)
     VALUES ($1, 'gate_config', 'band-ceiling', 'CEILING_NOT_REDERIVED', $2)
     ON CONFLICT (table_name, alarm, COALESCE(trading_day, '0001-01-01'::date),
                  COALESCE(column_name, ''), COALESCE(symbol, '')) WHERE resolved_at IS NULL DO NOTHING;`,
    [day, JSON.stringify(detail)]).catch((e) => log.warn('[ceiling] alarm', e.message));
  return { due: true, rederived: null, alarm: 'CEILING_NOT_REDERIVED' };
}

module.exports = { check, rederived, ABOLISHED };
