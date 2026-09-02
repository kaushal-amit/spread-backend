'use strict';
/**
 * ============================================================================
 *  seed-symbols.js — populate spread.symbol from whatever has traded
 * ============================================================================
 * A SHORTCUT, and it says so. The market comes from whatever the scraper
 * recorded, so `market_verified` stays FALSE and commission.js flags the
 * assumption rather than silently applying the Main rate to a Premier stock.
 *
 * Boursa Kuwait listing data replaces this properly. Until then a wrong market
 * misprices every trade on that symbol by a third of the commission.
 * ============================================================================
 */

const { pool } = require('../db');

const K = "AT TIME ZONE 'UTC' + interval '3 hours'";

async function seed({ db = pool, log = console } = {}) {
  const { rows: [src] } = await db.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_name IN ('stock_quotes','quote') AND table_schema IN ('public','spread')
      ORDER BY CASE table_schema WHEN 'public' THEN 0 ELSE 1 END LIMIT 1;`);
  if (!src) throw new Error('no quote source found — run npm run migrate first');
  const source = `${src.table_schema}.${src.table_name}`;

  const { rowCount } = await db.query(
    `INSERT INTO spread.symbol (symbol, market, market_verified, first_seen_on, last_seen_on)
     SELECT symbol,
            -- Uppercased so MAIN and Main are one market, not two.
            upper(COALESCE(max(market), 'MAIN')),
            false,
            min((created_at ${K})::date),
            max((created_at ${K})::date)
       FROM ${source}
      WHERE symbol IS NOT NULL
      GROUP BY symbol
     ON CONFLICT (symbol) DO UPDATE SET
       first_seen_on = LEAST(spread.symbol.first_seen_on, EXCLUDED.first_seen_on),
       last_seen_on  = GREATEST(spread.symbol.last_seen_on, EXCLUDED.last_seen_on),
       updated_at    = now();`);

  const { rows: [n] } = await db.query(
    `SELECT count(*) AS total, count(*) FILTER (WHERE NOT market_verified) AS unverified
       FROM spread.symbol;`);

  log.log(`[symbols] ${rowCount} written from ${source}`);
  if (Number(n.unverified)) {
    log.warn(`[symbols] ${n.unverified} symbols have an UNVERIFIED market. Premier pays 0.10% ` +
             'against Main\'s 0.15%, so a wrong market misprices every trade on that symbol. ' +
             'Populate from Boursa Kuwait listing data when you can.');
  }
  return { written: rowCount, total: Number(n.total), unverified: Number(n.unverified), source };
}

module.exports = { seed };

if (require.main === module) {
  seed().then((r) => { console.log(JSON.stringify(r, null, 1)); process.exit(0); })
        .catch((e) => require('../lib/dberror').die(e));
}
