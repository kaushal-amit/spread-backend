// Real SQL execution. pg-mem, not a mock — the migrations must actually parse.
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });

// pg-mem implements very few natives. Stub only what the migrations need.
mem.public.registerFunction({ name: 'round', args: ['float', 'int'], returns: 'float',
  implementation: (v, d) => (v == null ? null : Number(Number(v).toFixed(d))) });
for (const n of ['pg_advisory_lock', 'pg_advisory_unlock']) {
  mem.public.registerFunction({ name: n, args: ['int'], returns: 'bool', implementation: () => true });
}
// The source tables live in public and are written by the scrapers.
mem.public.none(`
CREATE TABLE public.stock_quotes (
  id serial primary key, symbol text, market text, session text,
  last_price numeric, last_qty bigint, bid numeric, bid_qty bigint,
  offer numeric, offer_qty bigint, trades bigint, volume bigint,
  created_at timestamptz);
CREATE TABLE public.stock_depth (
  id serial primary key, symbol text, level int, bid numeric, bid_qty bigint,
  offer numeric, offer_qty bigint, created_at timestamptz);
`);
const pg = mem.adapters.createPg();
module.exports = { mem, pool: new pg.Pool() };
