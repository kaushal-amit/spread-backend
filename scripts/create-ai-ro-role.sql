-- ============================================================================
--  scripts/create-ai-ro-role.sql — the read-only role the MCP server insists on
-- ============================================================================
-- src/mcp/server.js refuses DATABASE_URL and connects with MCP_DATABASE_URL,
-- which must be this role: SELECT only, on both schemas, with every
-- transaction read-only at the role level so a tool that tries to write is
-- refused by Postgres, not by a check in our code.
--
-- Run ONCE, as a superuser or the database owner, against the live database:
--   psql kse -v pw="'<a long random password>'" -f scripts/create-ai-ro-role.sql
-- Then set MCP_DATABASE_URL=postgres://ai_ro:<that password>@host:5432/kse.
--
-- Not a migration on purpose: roles are cluster-wide and carry a password,
-- and a migration runs unattended with whatever DATABASE_URL it is given.
-- ============================================================================

CREATE ROLE ai_ro LOGIN PASSWORD :pw;
GRANT USAGE ON SCHEMA public, spread TO ai_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public, spread TO ai_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, spread GRANT SELECT ON TABLES TO ai_ro;
ALTER ROLE ai_ro SET default_transaction_read_only = on;

-- Check: a write from this role must fail.
--   psql "postgres://ai_ro:...@host/kse" -c "INSERT INTO spread.event_log DEFAULT VALUES"
--   ERROR:  cannot execute INSERT in a read-only transaction
