-- Run this in the NEW database. It answers "what actually exists".

\echo '=== which schemas and tables are there? ==='
SELECT table_schema, table_name
  FROM information_schema.tables
 WHERE table_schema IN ('public', 'spread')
 ORDER BY table_schema, table_name;

\echo ''
\echo '=== which migrations were recorded as applied? ==='
SELECT filename, applied_at, duration_ms
  FROM spread.schema_migration ORDER BY filename;

\echo ''
\echo '=== what do the views actually read? ==='
SELECT table_name, view_definition
  FROM information_schema.views
 WHERE table_schema = 'spread';
