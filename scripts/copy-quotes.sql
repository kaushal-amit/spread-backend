-- Copy public.stock_quotes -> spread.quote
--
-- SAME DATABASE, so no CSV round trip. `\copy` was only ever needed when the
-- two lived apart.

INSERT INTO spread.quote
  (symbol, market, session, last_price, last_qty,
   bid, bid_qty, offer, offer_qty, trades, volume, created_at)
SELECT symbol, market, session, last_price, last_qty,
       bid, bid_qty, offer, offer_qty, trades, volume, created_at
  FROM public.stock_quotes;
-- expected: 768,618 rows

-- Verify, and check all four session values arrived. Only one of them is
-- non-executable, and a missing value means the views silently drop data.
SELECT count(*) AS rows,
       count(DISTINCT symbol) AS symbols,
       count(DISTINCT (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date) AS days,
       min((created_at AT TIME ZONE 'UTC' + interval '3 hours')::date) AS oldest,
       max((created_at AT TIME ZONE 'UTC' + interval '3 hours')::date) AS newest
  FROM spread.quote;

SELECT session, count(*) FROM spread.quote GROUP BY session ORDER BY 2 DESC;

-- The broker order record. 26 fills, and the only place the broker's own net
-- value lives — commission included, no model involved.
INSERT INTO spread.broker_order_snapshot (symbol, net_value_kd, raw, created_at)
SELECT symbol, net_value, raw, created_at FROM public.order_list_snapshots;
