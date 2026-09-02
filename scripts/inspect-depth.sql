-- Run against the OLD database. Send me the output.
--
-- I guessed stock_depth's shape and got it wrong. spread.depth must match
-- whatever this returns, because CR-34 reads it and a mismatched column is a
-- silent null rather than an error.

\echo '=== stock_depth columns ==='
SELECT ordinal_position AS pos, column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'stock_depth'
 ORDER BY ordinal_position;

\echo ''
\echo '=== three rows, so I can see what the values look like ==='
SELECT * FROM public.stock_depth ORDER BY id DESC LIMIT 3;

\echo ''
\echo '=== how much depth is there, and for how many symbols ==='
SELECT count(*) AS snapshots,
       count(DISTINCT symbol) AS symbols,
       min(created_at)::date AS oldest,
       max(created_at)::date AS newest
  FROM public.stock_depth;

\echo ''
\echo '=== snapshots per symbol per day — CR-34 needs 100+ ==='
SELECT (created_at AT TIME ZONE 'UTC' + interval '3 hours')::date AS day,
       symbol, count(*) AS snapshots
  FROM public.stock_depth
 GROUP BY 1, 2
 HAVING count(*) > 20
 ORDER BY 1 DESC, 3 DESC
 LIMIT 20;
