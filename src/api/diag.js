'use strict';
/**
 * api/diag.js — the diagnostic reads, mounted at /api/diag.
 *
 * C-08 · every handler goes through wrap(). These were bare async handlers in
 * index.js, so `?date=abc` — pg 22007 — was an unhandled rejection, and on
 * Node 15+ that terminates the process. 3.6 · every parameter is validated
 * by params.js: a bad one is a 400 with the reason, never a 500.
 */
const express = require('express');
const { pool } = require('../db');
const depth = require('../services/depth');
const registry = require('../services/ai/tools');
const { wrap, notReady } = require('./errors');
const { dayParam, symbolParam, limitParam } = require('./params');

function build() {
  const r = express.Router();

  r.get('/alarms', wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT * FROM spread.data_alarm WHERE resolved_at IS NULL
        ORDER BY raised_at DESC LIMIT $1;`, [limitParam(req.query.limit, { fallback: 100, max: 500 })]);
    res.json(rows);
  }));

  r.get('/coverage', wrap(async (req, res) => {
    const day = dayParam(req.query.date);
    const { rows } = await pool.query(
      'SELECT * FROM spread.market_day WHERE trading_day = $1;', [day]);
    res.json(rows[0] || { note: 'no market_day row for this date' });
  }));

  r.get('/depth/:symbol', wrap(async (req, res) => {
    res.json(await depth.validate(symbolParam(req.params.symbol), dayParam(req.query.date)));
  }));

  r.get('/tools', wrap(async (req, res) => {
    let tools;
    try { tools = registry.assertReady(); }
    catch (e) { throw notReady(e.message, e.code); }
    res.json({ tools, recent: registry.recentCalls(limitParam(req.query.limit, { fallback: 20, max: 500 })) });
  }));

  return r;
}

module.exports = { build };
