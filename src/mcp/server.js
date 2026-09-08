'use strict';
/**
 * ============================================================================
 *  mcp/server.js — read-only Postgres for Claude Desktop
 * ============================================================================
 * Stdio MCP server. Exposes the spread schema so a session can be analysed
 * from Claude Desktop rather than by hand.
 *
 * READ ONLY, and enforced twice:
 *   1. the connection uses the ai_ro role, which has SELECT and nothing else
 *   2. `query` rejects anything that is not a single SELECT
 *
 * The account tables: order_leg IS exposed — the trades are the analysis.
 * cash_movement is NOT — the balance is not, and it puts the P&L one prompt
 * away.
 * ============================================================================
 */

const readline = require('readline');
const { Pool } = require('pg');

/*
 * S-05 · READ-ONLY IS A ROLE, NOT A REGEX.
 *
 * This fell back to DATABASE_URL — the read-write role — and the regex
 * allowlist below is bypassable by any function that runs SQL
 * (query_to_xml, dblink, pg_read_file). With the RW role that was a write
 * path. The server now refuses to start without a connection string of its
 * own, and every session is forced read-only at the Postgres level, so even
 * a bypass of the regex cannot write.
 *
 *   CREATE ROLE ai_ro LOGIN PASSWORD '…';
 *   GRANT USAGE ON SCHEMA spread, public TO ai_ro;
 *   GRANT SELECT ON ALL TABLES IN SCHEMA spread, public TO ai_ro;
 *   REVOKE SELECT ON spread.cash_movement FROM ai_ro;
 *   MCP_DATABASE_URL=postgres://ai_ro:…@host/kse
 */
if (!process.env.MCP_DATABASE_URL) {
  process.stderr.write('mcp/server: MCP_DATABASE_URL (the ai_ro role) is required; refusing to fall back to DATABASE_URL\n');
  process.exit(2);
}
if (/^postgres(ql)?:\/\/[^:]*(postgres|spread|admin)[:@]/i.test(process.env.MCP_DATABASE_URL)) {
  process.stderr.write('mcp/server: MCP_DATABASE_URL names a read-write role; use ai_ro\n');
  process.exit(2);
}
const pool = new Pool({
  connectionString: process.env.MCP_DATABASE_URL,
  max: 4,
  statement_timeout: 15000,
});
pool.on('connect', (client) => {
  client.query('SET default_transaction_read_only = on; SET search_path = spread, public;').catch(() => {});
});

const ALLOWED = /^\s*select\b/i;
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy)\b/i;
const CASH_TABLES = /\bcash_movement\b/i;

const TOOLS = [
  { name: 'query',
    description: 'Run a single read-only SELECT against the spread schema. ' +
      'Tables: spread.symbol, symbol_day, symbol_profile, market_day, order_leg, ' +
      'depth_signal, entry_alert, ai_note, data_alarm, job_run. ' +
      'Views: spread.v_quote, v_quote_screening, v_depth.',
    inputSchema: { type: 'object', required: ['sql'],
      properties: { sql: { type: 'string' } } } },

  { name: 'getSymbolDay',
    description: 'Computed daily metrics for a symbol — every gate column.',
    inputSchema: { type: 'object', required: ['symbol'],
      properties: { symbol: { type: 'string' }, days: { type: 'number' } } } },

  { name: 'getContracts',
    description: 'The trading record: order legs paired into contracts, with commission ' +
      'and execution counts.',
    inputSchema: { type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } } } },

  { name: 'getDepth',
    description: 'Raw order book depth for a symbol and date. CR-34 raw material — ' +
      'a direction claim needs 100+ snapshots.',
    inputSchema: { type: 'object', required: ['symbol', 'date'],
      properties: { symbol: { type: 'string' }, date: { type: 'string' } } } },

  { name: 'getAlarms',
    description: 'Open data alarms: null fields, missing symbols, low capture coverage.',
    inputSchema: { type: 'object', properties: {} } },
];

async function runTool(name, args = {}) {
  if (name === 'query') {
    const sql = String(args.sql || '');
    if (!ALLOWED.test(sql) || FORBIDDEN.test(sql)) {
      throw new Error('read-only: a single SELECT is permitted and nothing else');
    }
    if (CASH_TABLES.test(sql)) {
      throw new Error('spread.cash_movement is not exposed over MCP — the trades are the ' +
        'analysis, the balance is not');
    }
    const { rows } = await pool.query(sql);
    return rows.slice(0, 500);
  }

  if (name === 'getSymbolDay') {
    const { rows } = await pool.query(
      `SELECT * FROM spread.symbol_day WHERE upper(symbol) = upper($1)
        ORDER BY trading_day DESC LIMIT $2;`,
      [args.symbol, Math.min(Number(args.days) || 10, 90)]);
    return rows;
  }

  if (name === 'getContracts') {
    const { rows } = await pool.query(
      `SELECT symbol, COALESCE(carried_from_day, trading_day) AS contract_day,
              contract_seq, side, status, price_fils, shares, filled_shares,
              commission_kd, executions, placement, posted_at, resolved_at,
              broker_net_value_kd
         FROM spread.order_leg
        WHERE trading_day BETWEEN COALESCE($1, '2000-01-01') AND COALESCE($2, '2100-01-01')
        ORDER BY posted_at;`, [args.from || null, args.to || null]);
    return rows;
  }

  if (name === 'getDepth') {
    const { rows } = await pool.query(
      `SELECT * FROM spread.v_depth
        WHERE upper(symbol) = upper($1)
          AND spread.kuwait_day(created_at) = $2
        ORDER BY created_at;`, [args.symbol, args.date]);
    return { snapshots: rows.length, sufficientForDirection: rows.length >= 100, rows };
  }

  if (name === 'getAlarms') {
    const { rows } = await pool.query(
      `SELECT * FROM spread.data_alarm WHERE resolved_at IS NULL
        ORDER BY raised_at DESC LIMIT 100;`);
    return rows;
  }

  throw new Error(`unknown tool: ${name}`);
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function start() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        return send({ jsonrpc: '2.0', id, result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'spread', version: '1.0.0' } } });
      }
      if (method === 'tools/list') {
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      }
      if (method === 'tools/call') {
        const out = await runTool(params.name, params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] } });
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
    }
  });
}

module.exports = { start, runTool, TOOLS };
if (require.main === module) start();
