'use strict';
/**
 * src/services/ai/schema.js — the schema summary, generated.
 *
 * GENERATED FROM information_schema AT BOOT, never hand-written. A prose
 * description of a schema drifts the first time a column is added, and a model
 * told about a column that no longer exists will ask for it.
 *
 * Only the tables the tools touch. Forty tables and six hundred columns is
 * more prompt than the question, and the model cannot query anything else
 * anyway — it picks a tool, not a table.
 */

const { pool } = require('../../db');

const TABLES = [
  'public.symbol_day', 'public.market_day', 'public.awsat_stock_depth',
  'public.symbol_minute', 'public.signal_log', 'public.position',
  'public.awsat_order_list', 'public.awsat_market_summary',
  'public.instruments', 'spread.kb_rule',
];

let cached = null;

async function summary({ refresh = false } = {}) {
  if (cached && !refresh) return cached;

  const { rows } = await pool.query(`
    SELECT c.table_schema || '.' || c.table_name AS tbl,
           c.column_name AS col, c.data_type AS type
      FROM information_schema.columns c
     WHERE c.table_schema || '.' || c.table_name = ANY($1)
     ORDER BY c.table_schema, c.table_name, c.ordinal_position`, [TABLES]);

  const byTable = new Map();
  for (const r of rows) {
    if (!byTable.has(r.tbl)) byTable.set(r.tbl, []);
    const t = r.type === 'timestamp with time zone' ? 'timestamptz'
      : r.type === 'character varying' ? 'text'
        : r.type === 'double precision' ? 'float' : r.type;
    byTable.get(r.tbl).push(`${r.col} ${t}`);
  }

  const lines = [];
  for (const [tbl, cols] of byTable) lines.push(`${tbl}\n  ${cols.join(', ')}`);
  cached = lines.join('\n\n');
  return cached;
}

module.exports = { summary, TABLES };
