'use strict';
/**
 * ============================================================================
 *  api/routes.js — one endpoint per frontend service method
 * ============================================================================
 * The frontend's `src/services/api/*.service.ts` interfaces are the spec. Each
 * method there gets exactly one route here, returning exactly the type in
 * `src/types/`.
 *
 * Nothing is renamed on the client. A translation layer in the browser is one
 * more place to get a name wrong, and a mismatched name is a silent `undefined`
 * rather than an error.
 * ============================================================================
 */

const express = require('express');
const { pool } = require('../db');
const { toDay } = require('../lib/day');
const daily = require('../jobs/daily');
const screening = require('../services/screening');
const live = require('../services/live');
const depth = require('../services/depth');
const claude = require('../services/ai/claude');
const rules = require('../lib/orderRules');
const pricing = require('../lib/pricing');
const present = require('./present');
const history = require('./history');
const gateStore = require('../services/gateStore');
const COMMISSION = require('../lib/commission');
const { wrap, refused, notFound, badRequest } = require('./errors');
const { BUDGET, SESSION, GATES, DIRECTION } = require('../config/spread.config');

const K = "AT TIME ZONE 'UTC' + interval '3 hours'";

/**
 * A BUY leg whose contract has not been sold.
 *
 * A-01 and A-02 were both this predicate missing. Written once and reused,
 * because the same check expressed two different ways is what inverted the
 * answer three times in this system's history.
 *
 * `l` is the alias of the order_leg row being tested.
 */
const OPEN_BUY = (l = 'l') => `
  ${l}.side = 'BUY' AND ${l}.status IN ('FILLED','CARRIED')
  AND NOT EXISTS (
    SELECT 1 FROM spread.order_leg s
     WHERE s.symbol = ${l}.symbol
       AND s.contract_seq = ${l}.contract_seq
       AND s.side = 'SELL' AND s.status = 'FILLED')`;

/**
 * The board, cached for the length of one tick.
 *
 * Six frontend hooks ask for slices of the same screen. Recomputing it per
 * request would run the funnel six times over identical data.
 */
let cache = { key: null, at: 0, value: null };
const CACHE_MS = 5000;

async function board(day, budgetKd) {
  // Keyed on the gate VERSION too, so an edit takes effect on the next read
  // rather than after the cache happens to expire.
  const cfg = gateStore.effective();
  const key = `${day}:${budgetKd}:${gateStore.meta().version}`;
  if (cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  // R-01 · TARGETS travels with GATES. Passing only GATES meant the target
  // capture toggles were stored, never read, and reset on reload.
  const value = await screening.screen(day, budgetKd,
    { cfg: cfg.GATES, targets: cfg.TARGETS });
  cache = { key, at: Date.now(), value };
  return value;
}
const invalidate = () => { cache = { key: null, at: 0, value: null }; };

/** Realised P&L, for the account strip. */
async function pnlSummary(day, db = pool) {
  const { rows } = await db.query(
    `WITH legs AS (
       SELECT trading_day, symbol, contract_seq,
              COALESCE(carried_from_day, trading_day) AS contract_day,
              side, price_fils, filled_shares, commission_kd
         FROM spread.order_leg WHERE status = 'FILLED'
     ), pairs AS (
       SELECT contract_day, symbol, contract_seq,
              sum(CASE WHEN side='SELL' THEN price_fils*filled_shares/1000.0
                       ELSE -price_fils*filled_shares/1000.0 END) AS gross_kd,
              sum(commission_kd) AS commission_kd,
              count(*) AS fills,
              count(*) FILTER (WHERE side='SELL') AS sells
         FROM legs GROUP BY 1,2,3
     )
     SELECT sum(gross_kd - commission_kd) FILTER (WHERE contract_day = $1) AS today_kd,
            count(*) FILTER (WHERE contract_day = $1 AND sells > 0)        AS today_trips,
            sum(gross_kd - commission_kd)                                  AS since_kd,
            sum(fills)                                                     AS since_fills
       FROM pairs;`, [day]);
  /*
   * R-07 · this used to swallow the error and return an empty row, so a
   * database failure showed as "today: 0.00 KD" — indistinguishable from a
   * session with no trades. The account strip would have read calm and wrong.
   */
  const r = rows[0] || {};
  return {
    todayKd: Number(r.today_kd || 0), todayTrips: Number(r.today_trips || 0),
    sinceKd: Number(r.since_kd || 0), sinceFills: Number(r.since_fills || 0),
  };
}

/** Open positions, shaped as the frontend's TradingContract. */
async function contracts(day, db = pool) {
  /*
   * Every leg of every contract that is not yet closed.
   *
   * The SELL legs are needed as well as the buys — a POSTED sell is what tells
   * the screen an offer is resting, and I2 escalates when there is none.
   */
  const { rows: legs } = await db.query(
    `SELECT l.*, COALESCE(l.carried_from_day, l.trading_day) AS contract_day
       FROM spread.order_leg l
      WHERE l.status IN ('POSTED','FILLED','CARRIED','AUCTION_SUBMITTED')
      ORDER BY l.posted_at;`)/* a DB failure must not become an empty list — see errors.js */;

  const { rows: claims } = await db.query(
    'SELECT * FROM spread.claim WHERE trading_day = $1;', [day])/* a DB failure must not become an empty list — see errors.js */;

  const bySeq = new Map();
  for (const l of legs) {
    const k = `${l.symbol}:${toDay(l.contract_day)}:${l.contract_seq}`;
    if (!bySeq.has(k)) bySeq.set(k, { symbol: l.symbol, contract_seq: l.contract_seq, legs: [] });
    bySeq.get(k).legs.push(l);
  }

  const out = [];
  for (const c of bySeq.values()) {
    const buy = c.legs.find((l) => l.side === 'BUY' && l.status === 'FILLED');
    if (!buy) continue;
    const sold = c.legs.some((l) => l.side === 'SELL' && l.status === 'FILLED');
    if (sold) continue;

    /*
     * A symbol with no quote today is a real state — it did not trade. A failed
     * QUERY is not, and swallowing it marked the position at its entry price,
     * showing an unrealised of exactly zero on a position that had moved.
     */
    const { rows: [q] } = await pool.query(
      `SELECT bid, offer FROM spread.v_quote_screening
        WHERE symbol = $1 ORDER BY created_at DESC LIMIT 1;`, [c.symbol]);

    const entry = Number(buy.price_fils);
    const shares = Number(buy.filled_shares || buy.shares);
    const bid = Number(q?.bid || entry);
    const rt = Number(buy.commission_kd || 0) * 2;
    const breakEven = entry + Math.ceil((rt * 1000) / shares);

    /*
     * I-05 · a position open across sessions is CARRIED, whether or not the
     * carry was recorded.
     *
     * Rule 8 says never carry overnight, and every overnight hold in ten
     * sessions lost money — the worst -44.94 over a weekend. A row that has
     * simply been open since a prior day must show as carried rather than as a
     * fresh holding, or the 12:30 flatten prompt reads as routine.
     */
    const openedOn = toDay(buy.carried_from_day || buy.trading_day);
    const isCarried = !!buy.carried_from_day || (openedOn && openedOn < day);

    out.push(present.tradingContract({
      symbol: c.symbol, contract_seq: c.contract_seq,
      state: isCarried ? 'carried' : 'holding',
      shares, entry, bid, offer: Number(q?.offer || entry + 1),
      committedKd: (entry * shares) / 1000,
      unrealisedKd: ((bid - entry) * shares) / 1000,
      breakEvenFils: breakEven,
      // Arm at the first PROFITABLE tick, not at break-even. On one position
      // they were 239 and 240, and 239 was worth +0.001 KD.
      trailArmFils: breakEven + 1,
      trailingOfferFils: Math.max(breakEven + 1, Number(buy.peak_bid_fils || entry) - 1),
      peakBidFils: Number(buy.peak_bid_fils || entry),
      legs: c.legs,
    }));
  }

  for (const cl of claims) {
    if (out.some((o) => o.symbol === cl.symbol)) continue;
    out.push(present.tradingContract({
      symbol: cl.symbol, contract_seq: 0, state: 'picked',
      shares: 0, entry: 0, bid: 0, offer: 0,
      committedKd: Number(cl.amount_kd), unrealisedKd: 0,
      breakEvenFils: 0, trailArmFils: 0, trailingOfferFils: 0, peakBidFils: 0, legs: [],
    }));
  }
  return out;
}

function build() {
  const r = express.Router();
  const day = (req) => req.query.date || req.body?.date || daily.kuwaitDay();
  // The effective slot size, not the file constant — the operator can change it.
  const budget = (req) =>
    Number(req.query.budgetKd || req.body?.budgetKd) || gateStore.effective().BUDGET.slotKd;
  /*
   * N-15 · every handler reports through the typed explainer.
   *
   * `500 {error}` made a missing table indistinguishable from a bad request,
   * and the client's retry policy could not make a sensible decision about
   * either. `wrap` turns a thrown ApiError into its status and a Postgres code
   * into 503 SCHEMA_MISSING or DB_DOWN.
   */
  const fail = (res) => (e) => {
    const { status, body } = require('./errors').toResponse(e);
    res.status(status).json(body);
  };

  // ---- health -----------------------------------------------------------
  r.get('/health', async (_req, res) => {
    try {
      const { rows: [t] } = await pool.query('SELECT now() AS t');
      res.json({ status: 'ok', time: t.t });
    } catch (e) { res.status(503).json({ status: 'down', error: e.message }); }
  });

  // ---- stocks · IStockService ------------------------------------------
  const section = (name) => async (req, res) => {
    try {
      const b = await board(day(req), budget(req));
      res.json((b[name] || []).map((x) => present.stockCandidate(x, budget(req))));
    } catch (e) { fail(res)(e); }
  };
  r.get('/stocks/recommended', section('recommended'));
  r.get('/stocks/near-miss', section('nearMiss'));
  r.get('/stocks/rejected', section('rejected'));

  // EVERY symbol. `passed` is a property of a row, not a reason to omit it —
  // filters once hid three of the four best candidates and nobody could see it.
  r.get('/stocks', async (req, res) => {
    try {
      const b = await board(day(req), budget(req));
      res.json([...b.recommended, ...b.nearMiss, ...b.rejected]
        .map((x) => present.stockCandidate(x, budget(req))));
    } catch (e) { fail(res)(e); }
  });

  r.get('/stocks/:symbol', async (req, res) => {
    try {
      const b = await board(day(req), budget(req));
      const hit = [...b.recommended, ...b.nearMiss, ...b.rejected]
        .find((x) => x.symbol.toUpperCase() === req.params.symbol.toUpperCase());
      res.json(hit ? present.stockCandidate(hit, budget(req)) : null);
    } catch (e) { fail(res)(e); }
  });

  r.post('/stocks/:symbol/override', async (req, res) => {
    const d = day(req);
    try {
      const b = await board(d, budget(req));
      const hit = [...b.nearMiss, ...b.rejected]
        .find((x) => x.symbol.toUpperCase() === req.params.symbol.toUpperCase());
      if (!hit) return res.status(404).json({ error: 'not on the board' });

      // A structural failure is ARITHMETIC, not judgement. There is no market
      // condition under which a 0.1-fil tick wins, so the button only ever
      // loses money and the server refuses rather than the UI hiding it.
      if (hit.structural) {
        return res.status(409).json({
          error: 'cannot override a structural gate',
          detail: hit.reasons[0],
        });
      }

      await pool.query(
        `INSERT INTO spread.override_log
           (trading_day, symbol, verdict_at_override, gates_overridden, reason)
         VALUES ($1,$2,$3,$4,$5);`,
        [d, hit.symbol, hit.passed ? 'TRADABLE' : 'NOT_RECOMMENDED',
         hit.failed, req.body?.note || null]);

      invalidate();
      const out = present.stockCandidate(hit, budget(req));
      res.json({ ...out, overrideLogged: true, overrideNote: req.body?.note });
    } catch (e) { fail(res)(e); }
  });

  // ---- order book ------------------------------------------------------
  r.get('/orderbook/:symbol', async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    try {
      const { rows: [q] } = await pool.query(
        `SELECT symbol, bid, bid_qty, offer, offer_qty, last_price, trades, created_at
           FROM spread.v_quote_screening
          WHERE upper(symbol) = $1 ORDER BY created_at DESC LIMIT 1;`, [sym]);
      if (!q) return res.status(404).json({ error: `no quote for ${sym}` });

      // The day row may legitimately not exist before the 13:30 job runs, so
      // an empty result is fine — a thrown error is not.
      const { rows: [d] } = await pool.query(
        `SELECT high_fils, low_fils FROM spread.symbol_day
          WHERE upper(symbol) = $1 AND trading_day = $2;`, [sym, day(req)]);

      // The ladder. Ten levels are captured and no screen has shown more than
      // one — a 42,400 bid with 10,000 behind it is a different book from one
      // with 500,000 behind it.
      const { rows: ladder } = await pool.query(
        `SELECT level, bid, bid_qty, offer, offer_qty
           FROM spread.depth
          WHERE upper(symbol) = $1
            AND capture_id = (SELECT capture_id FROM spread.depth
                               WHERE upper(symbol) = $1
                               ORDER BY COALESCE(captured_at, created_at) DESC LIMIT 1)
          ORDER BY level;`, [sym])/* a DB failure must not become an empty list — see errors.js */;

      const levels = [];
      for (const l of ladder) {
        if (l.bid != null) levels.push({ side: 'bid', price: l.bid, qty: l.bid_qty });
        if (l.offer != null) levels.push({ side: 'offer', price: l.offer, qty: l.offer_qty });
      }

      res.json(present.orderBook({ ...q, ...d }, levels));
    } catch (e) { fail(res)(e); }
  });

  // ---- trading · ITradingService ---------------------------------------
  r.get('/trading/contracts', async (req, res) => {
    try { res.json(await contracts(day(req))); } catch (e) { fail(res)(e); }
  });

  r.post('/trading/move', async (req, res) => {
    const d = day(req);
    try {
      // `placement` was sent by the client and destructured as `override`, so
      // INSIDE vs AT_BID was silently discarded on every call.
      const { symbol, amountKd, placement, override } = req.body || {};

      /*
       * A-01 · COUNT OPEN POSITIONS, NOT EVERY BUY EVER FILLED.
       *
       * This counted the entire history with no day filter and no exclusion of
       * sold contracts, so after the FIRST completed round trip the count was
       * permanently >= 1 and every later claim returned 409. The system took
       * one trade and then refused all further work, forever.
       *
       * One position, full size, is the rule: 2 x 400 KD earned +0.02 where
       * 1 x 850 KD earned +1.16, because the settlement fee is per order.
       * "One position" means one OPEN position.
       */
      const { rows: [open] } = await pool.query(
        `SELECT count(*) AS n FROM spread.order_leg l WHERE ${OPEN_BUY('l')};`);
      const guard = rules.checkNewPosition({
        openPositions: Number(open.n),
        // The effective limit, so a saved change is honoured.
        maxPositions: gateStore.effective().BUDGET.maxPositions,
      });
      if (!guard.allowed) return res.status(409).json(guard);

      await pool.query(
        `INSERT INTO spread.claim (trading_day, symbol, amount_kd, is_override, placement)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (trading_day, symbol) DO UPDATE
           SET amount_kd = $3, is_override = $4, placement = $5, at = now();`,
        // The EFFECTIVE slot size. The file constant ignored a saved change,
        // so a claim was made at a budget the operator had already altered.
        [d, String(symbol).toUpperCase(),
         Number(amountKd) || gateStore.effective().BUDGET.slotKd,
         !!override, placement || null]);

      invalidate();
      res.json({ ok: true, contracts: await contracts(d) });
    } catch (e) { fail(res)(e); }
  });

  r.post('/trading/untrade', async (req, res) => {
    const d = day(req);
    try {
      const { rows } = await pool.query(
        'DELETE FROM spread.claim WHERE trading_day = $1 AND symbol = $2 RETURNING amount_kd;',
        [d, String(req.body?.symbol).toUpperCase()]);
      invalidate();
      res.json({ symbol: req.body?.symbol, releasedKd: Number(rows[0]?.amount_kd || 0) });
    } catch (e) { fail(res)(e); }
  });

  /*
   * Recording a leg. Every FILLED leg posts TWO cash rows — notional and fee —
   * in the same transaction. A fill that does not move cash is the same class
   * of bug as a fill that does not save.
   */
  r.post('/trading/record', async (req, res) => {
    const d = day(req);
    const client = await pool.connect();
    try {
      const { symbol, side, status, priceFils, shares, seq, note, executions } = req.body || {};

      /*
       * I-06 · validate before writing.
       *
       * None of these were checked. `String(undefined).toUpperCase()` yields
       * the literal "UNDEFINED", and a negative priceFils posted a negative
       * cash movement.
       */
      const sym = String(symbol || '').trim().toUpperCase();
      if (!sym) throw badRequest('symbol is required');
      if (!['BUY', 'SELL'].includes(side)) throw badRequest('side must be BUY or SELL');
      if (!['POSTED', 'FILLED', 'CANCELLED', 'EXPIRED', 'CARRIED', 'AUCTION_SUBMITTED'].includes(status)) {
        throw badRequest(`status "${status}" is not a leg status`);
      }
      if (!(Number(priceFils) > 0)) throw badRequest('priceFils must be positive');
      if (!(Number(shares) > 0)) throw badRequest('shares must be positive');
      if (executions != null && !(Number(executions) >= 1)) {
        throw badRequest('executions must be 1 or more when given');
      }

      /*
       * A-02 · A SELL CLOSES THE OPEN BUY. IT DOES NOT OPEN A NEW CONTRACT.
       *
       * `COALESCE($3, max(contract_seq)+1)` is right for OPENING a contract and
       * wrong for closing one. With no `seq` sent, the buy landed as seq 1 and
       * the sell as seq 2, so every consumer that groups by seq saw a buy with
       * no sell and a sell with no cost basis:
       *
       *   contracts()      the position renders `holding` forever
       *   accountSummary() investedKd and marketKd keep counting a sold
       *                    position, so equity is overstated by roughly the
       *                    position value while the cash from the sale is
       *                    ALSO counted
       *   the A-01 guard   never decremented — which is why A-01 bit on the
       *                    very first trade
       *
       * `hit-bid` was the only correct exit because it looks the buy up and
       * passes the seq explicitly. The normal path now does the same.
       */
      let contractSeq = seq ?? null;
      if (side === 'SELL') {
        const { rows: [openBuy] } = await pool.query(
          `SELECT contract_seq FROM spread.order_leg l
            WHERE upper(l.symbol) = $1 AND ${OPEN_BUY('l')}
            ORDER BY l.posted_at DESC LIMIT 1;`, [sym]);

        if (contractSeq == null) {
          if (openBuy) contractSeq = Number(openBuy.contract_seq);
        } else if (openBuy && Number(openBuy.contract_seq) !== Number(contractSeq)) {
          /*
           * V-02 · A STALE SEQ IS REFUSED, not trusted.
           *
           * The client seeded its contract field with a constant, so every sell
           * carried seq 1. After the first round trip that is a CLOSED
           * contract, and writing to it left the real position open while the
           * ledger recorded a sale — A-02's symptoms returning through a
           * different door.
           *
           * The server knows which contract is open. A caller naming a
           * different one is either stale or mistaken, and both deserve a
           * refusal rather than a silent write.
           */
          throw refused(
            `contract ${contractSeq} is not the open contract in ${sym}`,
            `the open contract is ${openBuy.contract_seq}. Leave the contract field blank to ` +
            'let the engine resolve it, or correct it to the open one.');
        } else if (!openBuy) {
          throw refused(`there is no open position in ${sym} to sell`,
            'record the buy first, or use a different symbol');
        }
      }

      let warning = null;
      if (side === 'SELL') {
        const { rows: [buy] } = await client.query(
          `SELECT price_fils, filled_shares, commission_kd FROM spread.order_leg
            WHERE symbol = $1 AND side='BUY' AND status='FILLED'
            ORDER BY posted_at DESC LIMIT 1;`, [sym]);
        if (buy) {
          // D3 at the source. Three amendments below cost lost 19.52 KD in one
          // session — warn, never block, because closing flat can be deliberate.
          const chk = rules.checkSellAmend({
            newPriceFils: Number(priceFils), avgCostFils: Number(buy.price_fils),
            shares: Number(shares), commissionKd: Number(buy.commission_kd || 0) * 2 });
          if (!chk.allowed || chk.warning) warning = chk.message || chk.warning;
        }
      }

      await client.query('BEGIN');
      const notionalKd = (Number(priceFils) * Number(shares)) / 1000;
      const fee = status === 'FILLED'
        ? COMMISSION.sideFeeKd(notionalKd, { day: d, executions: executions ?? null })
        : { kd: 0, known: true, executions: null };

      /*
       * I-03 · how LIKELY a fragmented fill was, so the caveat carries
       * information instead of firing on every save.
       *
       * `executions` is optional and rarely supplied, so `known` was false on
       * every FILLED leg and the warning appeared every time — which is how a
       * caveat stops being read, inverting the intent of the fix that added it.
       *
       * Fragmentation is estimable: the counterparty stream is a renewal
       * process, so E[executions] ~= 1 + shares / avg_trade_size. Near 1, a
       * single execution is likely and the caveat is noise.
       */
      let expectedExecutions = null;
      if (status === 'FILLED' && !fee.known) {
        const { rows: [prof] } = await client.query(
          `SELECT avg_trade_shares FROM spread.symbol_day
            WHERE upper(symbol) = $1 AND trading_day = $2;`, [sym, d]);
        expectedExecutions = COMMISSION.expectedExecutions(
          Number(shares), Number(prof?.avg_trade_shares || 0));
      }

      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, executions, posted_at, resolved_at, note)
         VALUES ($1,$2,COALESCE($3,(SELECT COALESCE(max(contract_seq),0)+1
                                      FROM spread.order_leg WHERE symbol=$2)),
                 $4,$5,$6,$7,$8,$9,$10,now(),
                 CASE WHEN $5='POSTED' THEN NULL ELSE now() END,$11)
         RETURNING *;`,
        [d, sym, contractSeq, side, status, priceFils, shares,
         status === 'FILLED' ? shares : null, fee.kd, executions ?? null, note ?? null]);

      if (status === 'FILLED') {
        const isBuy = side === 'BUY';
        await client.query(
          `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, order_leg_id, note)
           VALUES ($1,$2,$3,$4,$5),($1,'FEE',$6,$4,$7);`,
          [d, isBuy ? 'BUY' : 'SELL', isBuy ? -notionalKd : notionalKd, leg.id,
           `${sym} ${Number(shares).toLocaleString('en-US')} @ ${priceFils}`,
           -fee.kd, `${sym} ${side.toLowerCase()} commission`]);
      }
      await client.query('COMMIT');
      invalidate();

      res.json({
        ok: true, warning,
        // FALSE when the execution count is unknown — the fee is charged per
        // execution and a two-piece fill costs 0.50-0.75 more than the
        // single-order formula predicts.
        commissionKnown: fee.known,
        contracts: await contracts(d),
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      fail(res)(e);
    } finally { client.release(); }
  });

  /*
   * Selling into the bid — the LAST rung of the exit ladder.
   *
   * The client used to POST here, receive a 404, and then BUILD ITS OWN
   * result from hardcoded fallbacks: entry 238, shares 3,500, commission 3.51.
   * The operator saw a confident "DUMP INTO BID EXECUTED" for an action that
   * never happened.
   *
   * It records a real SELL at the current bid and returns what it cost. The
   * cost comes back with the result because dumping into the bid measured
   * −5,270 KD against +3,014 for waiting.
   */
  r.post('/trading/hit-bid', wrap(async (req, res) => {
    const d = day(req);
    const sym = String(req.body?.symbol || '').toUpperCase();
    if (!sym) throw badRequest('symbol is required');
    // Optional, and rarely sent. When absent sideFeeKd assumes ONE execution
    // and every split fill under-reports; the nightly reconciliation corrects
    // it from the broker's own charge.
    const executions = Number.isFinite(Number(req.body?.executions))
      ? Number(req.body.executions) : null;

    const { rows: [buy] } = await pool.query(
      `SELECT * FROM spread.order_leg
        WHERE symbol=$1 AND side='BUY' AND status IN ('FILLED','CARRIED')
          AND NOT EXISTS (SELECT 1 FROM spread.order_leg s
                           WHERE s.symbol=$1 AND s.contract_seq=spread.order_leg.contract_seq
                             AND s.side='SELL' AND s.status='FILLED')
        ORDER BY posted_at DESC LIMIT 1;`, [sym]);
    if (!buy) throw notFound(`no open position in ${sym}`);

    const { rows: [q] } = await pool.query(
      `SELECT bid FROM spread.v_quote_screening WHERE upper(symbol)=$1
        ORDER BY created_at DESC LIMIT 1;`, [sym]);
    if (!q?.bid) throw notFound(`no bid for ${sym} — nothing to sell into`);

    const bid = Number(q.bid);
    const entry = Number(buy.price_fils);
    const shares = Number(buy.filled_shares || buy.shares);
    const notionalKd = (bid * shares) / 1000;
    /**
     * executions is passed when the caller knows it.
     *
     * With it null, sideFeeKd assumes ONE execution — so every split fill
     * under-reports the charge, always in the same direction. A 6,100-share
     * sell filling as 5,350 + 750 computes 1.680 against an actual 2.285.
     *
     * The nightly reconciliation corrects what is still wrong here, from the
     * broker's own net_value.
     */
    const fee = COMMISSION.sideFeeKd(notionalKd, { day: d, executions: executions ?? null });
    const roundTrip = Number(buy.commission_kd || 0) + fee.kd;
    const costKd = Number((((bid - entry) * shares) / 1000 - roundTrip).toFixed(3));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, posted_at, resolved_at, exit_venue, note)
         VALUES ($1,$2,$3,'SELL','FILLED',$4,$5,$5,$6,now(),now(),'MARKET',$7)
         RETURNING id;`,
        [d, sym, buy.contract_seq, bid, shares, fee.kd,
         'hit the bid — last rung of the exit ladder']);
      await client.query(
        `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, order_leg_id, note)
         VALUES ($1,'SELL',$2,$3,$4),($1,'FEE',$5,$3,$6);`,
        [d, notionalKd, leg.id, `${sym} ${shares.toLocaleString('en-US')} @ ${bid}`,
         -fee.kd, `${sym} sell commission`]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    invalidate();
    res.json({
      costKd,
      note: `Sold ${shares.toLocaleString('en-US')} at ${bid} against an entry of ${entry}. ` +
            `Net ${costKd >= 0 ? '+' : ''}${costKd.toFixed(2)} KD after ${roundTrip.toFixed(2)} ` +
            'commission. Dumping into the bid measured −5,270 KD against +3,014 for waiting.',
      contracts: await contracts(d),
    });
  }));

  /*
   * V-05 · this took any legId and any status with no checks.
   *
   * It could move any leg to any status, including flipping a FILLED buy back
   * to CANCELLED — which would silently un-close a contract and put the cash
   * ledger out of step with the position.
   *
   * Only a POSTED order can resolve, and only into the three outcomes a posted
   * order actually has.
   */
  r.post('/trading/resolve', wrap(async (req, res) => {
    const executions = Number.isFinite(Number(req.body?.executions))
      ? Number(req.body.executions) : null;
    const { legId, status } = req.body || {};
    const OUTCOMES = ['FILLED', 'EXPIRED', 'CANCELLED'];

    if (!Number.isInteger(Number(legId))) throw badRequest('legId must be an integer');
    if (!OUTCOMES.includes(status)) {
      throw badRequest(`status must be one of ${OUTCOMES.join(', ')}`);
    }

    const { rows: [leg] } = await pool.query(
      'SELECT * FROM spread.order_leg WHERE id = $1;', [legId]);
    if (!leg) throw notFound(`no leg ${legId}`);
    if (leg.status !== 'POSTED') {
      throw refused(`leg ${legId} is ${leg.status}, not POSTED`,
        'only a resting order can be resolved — a filled leg is already settled, and moving it ' +
        'would put the cash ledger out of step with the position');
    }

    const d = day(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const shares = Number(leg.shares);
      const notionalKd = (Number(leg.price_fils) * shares) / 1000;
      const fee = status === 'FILLED'
        ? COMMISSION.sideFeeKd(notionalKd, { day: d, executions: executions ?? null })
        : { kd: 0 };

      await client.query(
        `UPDATE spread.order_leg
            SET status=$2, resolved_at=now(),
                filled_shares = CASE WHEN $2='FILLED' THEN $3 ELSE filled_shares END,
                commission_kd = CASE WHEN $2='FILLED' THEN $4 ELSE commission_kd END
          WHERE id=$1;`, [legId, status, shares, fee.kd]);

      /*
       * A fill moves cash. This previously did not, so resolving a posted sell
       * as FILLED closed the position without recording the proceeds — the same
       * class of bug as a fill that does not save.
       */
      if (status === 'FILLED') {
        const isBuy = leg.side === 'BUY';
        await client.query(
          `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, order_leg_id, note)
           VALUES ($1,$2,$3,$4,$5),($1,'FEE',$6,$4,$7);`,
          [d, isBuy ? 'BUY' : 'SELL', isBuy ? -notionalKd : notionalKd, leg.id,
           `${leg.symbol} ${shares.toLocaleString('en-US')} @ ${leg.price_fils}`,
           -fee.kd, `${leg.symbol} ${leg.side.toLowerCase()} commission`]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    invalidate();
    res.json({ ok: true, contracts: await contracts(d) });
  }));

  // ---- account and ledger · ILedgerService ------------------------------
  r.get('/account', async (req, res) => {
    const d = day(req);
    try {
      const [a, pnl] = await Promise.all([accountSummary(d), pnlSummary(d)]);
      res.json(present.accountState(a, pnl));
    } catch (e) { fail(res)(e); }
  });

  r.get('/ledger', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.*, l.symbol,
                sum(c.amount_kd) OVER (ORDER BY c.at, c.id) AS balance_kd
           FROM spread.cash_movement c
           LEFT JOIN spread.order_leg l ON l.id = c.order_leg_id
          ORDER BY c.at, c.id;`);
      res.json(rows.map(present.ledgerEntry));
    } catch (e) { fail(res)(e); }
  });

  r.post('/ledger', async (req, res) => {
    const d = day(req);
    try {
      const { kind, amountKd, note } = req.body || {};
      const amt = Number(amountKd);

      // I-06 · `kind` was unchecked, so an arbitrary string could be written
      // into a column the whole account balance is summed from.
      const KINDS = ['DEPOSIT', 'WITHDRAWAL', 'ADJUSTMENT'];
      if (!KINDS.includes(kind)) {
        throw badRequest(`kind must be one of ${KINDS.join(', ')}`,
          'BUY, SELL and FEE rows are written by the trading path, not by hand');
      }
      if (!(amt > 0)) throw badRequest('amount must be positive');
      if (!Number.isFinite(amt) || amt > 1e9) throw badRequest('amount is out of range');

      if (kind === 'WITHDRAWAL') {
        // EQUITY IS NOT BUYING POWER. Refusing has to name both numbers —
        // "insufficient funds" against a four-figure account reads like a bug.
        const a = await accountSummary(d);
        const available = Number(a.settledKd);
        if (amt > available) {
          return res.status(409).json({
            error: `only ${available.toFixed(2)} KD is available`,
            detail: `equity is ${(Number(a.cashKd) + Number(a.marketKd)).toFixed(2)} but ` +
                    `${Number(a.investedKd).toFixed(2)} is in an open position`,
          });
        }
      }

      await pool.query(
        `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, note)
         VALUES ($1,$2,$3,$4);`,
        [d, kind, kind === 'DEPOSIT' ? amt : -amt, note || null]);

      const [a, pnl] = await Promise.all([accountSummary(d), pnlSummary(d)]);
      res.json({ ok: true, account: present.accountState(a, pnl) });
    } catch (e) { fail(res)(e); }
  });

  // ---- gates · IGateService --------------------------------------------
  r.get('/gates', async (_req, res) => {
    try {
      const cfg = gateStore.effective();
      const configs = present.gateConfigs(cfg, gateStore.meta());
      const d = daily.kuwaitDay();
      // N-16 · the EFFECTIVE budget. Using the file constant meant a saved slot
      // size never moved rejectsCount, so the panel reported the cost of a
      // threshold at a budget the operator had already changed.
      const b = await board(d, cfg.BUDGET.slotKd).catch(() => null);
      if (b) {
        /*
         * Keyed off the STABLE gate id, not a word derived from the display
         * name. `gateName.split(' ')[0]` produced "price", "net", "average" —
         * none of which are keys in `counts`, so every count read 0 and the
         * panel silently said no gate was rejecting anything.
         */
        const COUNT_KEY = {
          'g1-floor': 'price band', 'g2-net': 'profit floor', 'g3-size': 'trade size',
          'g4-moves': 'movement', 'g5-tape': 'tape quality', 'g6-postable': 'postable',
          'g7-exit': 'exit depth', 'g8-dist': 'distribution', 'g9-consistency': 'consistency',
          'g10-direction': 'direction',
        };
        for (const c of configs) {
          c.rejectsCount = Number(b.counts[COUNT_KEY[c.id]] || 0);
        }
      }
      res.json(configs);
    } catch (e) { fail(res)(e); }
  });

  /*
   * `PUT /gates/:id` removed.
   *
   * Superseded by the bulk endpoint below. It also produced one version row per
   * gate — fourteen for a single user action, and a reset re-saved identical
   * values as a "change", which is what B-16 was raised to eliminate.
   */

  /*
   * B-16 · BULK. `resetGateChanges` fired one PUT per gate — fourteen requests
   * and fourteen version rows for a single user action, and a reset re-saved
   * identical values as a "change".
   */
  r.put('/gates', wrap(async (req, res) => {
    const changes = req.body?.changes;
    if (!changes || typeof changes !== 'object') throw badRequest('changes object is required');
    const before = await board(daily.kuwaitDay(), gateStore.effective().BUDGET.slotKd)
      .catch(() => null);
    await gateStore.save(changes, {
      changedBy: req.body?.changedBy || 'ui', note: req.body?.note || null,
      passesBefore: before?.recommended.length ?? null });
    invalidate();
    const after = await board(daily.kuwaitDay(), gateStore.effective().BUDGET.slotKd)
      .catch(() => null);
    res.json(present.gateConfigs(gateStore.effective(), {
      version: gateStore.meta().version, loadedAt: gateStore.meta().loadedAt,
      passesBefore: before?.recommended.length, passesAfter: after?.recommended.length }));
  }));

  // ---- session · ISessionService ---------------------------------------
  r.get('/session', wrap(async (req, res) => {
    const { sessionPhase } = require('../socket');
    const p = sessionPhase();
    const k = new Date(Date.now() + SESSION.timezoneOffsetHours * 3600000);

    /*
     * B-14 · drift was a hardcoded map {9: 0.203, 10: 0.296, ...}, and
     * SessionBanner rendered the same four numbers again from its own copy.
     *
     * MEASURED: the market-wide average change from the open, by hour, over the
     * captured sessions. Null when there is not enough history — an honest gap
     * beats four constants that look like a finding.
     */
    const { rows } = await pool.query(
      `WITH h AS (
         SELECT (created_at ${K})::date AS d, symbol,
                EXTRACT(hour FROM created_at ${K})::int AS hr,
                last_price::numeric AS px,
                first_value(last_price::numeric) OVER (
                  PARTITION BY (created_at ${K})::date, symbol
                  ORDER BY created_at) AS open_px
           FROM spread.v_quote_screening
          WHERE (created_at ${K})::date >= current_date - 20
       )
       SELECT hr, round(avg(px - open_px)::numeric, 3) AS drift, count(DISTINCT d) AS sessions
         FROM h WHERE open_px > 0 GROUP BY hr ORDER BY hr;`)/* a DB failure must not become an empty list — see errors.js */;

    const row = rows.find((r2) => Number(r2.hr) === k.getUTCHours());
    res.json({
      ...present.sessionInfo({ ...p, hour: k.getUTCHours(),
        timeStr: k.toISOString().slice(11, 16) },
        row ? Number(row.drift) : 0),
      // The whole curve, so the banner stops carrying its own copy.
      driftByHour: rows.map((r2) => ({
        hour: Number(r2.hr), driftFils: Number(r2.drift), sessions: Number(r2.sessions) })),
      driftMeasured: !!row,
    });
  }));

  // ---- AI · IAiService --------------------------------------------------
  r.get('/ai/history', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, created_at, reasoning, rejected FROM spread.ai_note
          WHERE trading_day = $1 AND NOT rejected
          ORDER BY created_at DESC LIMIT 50;`, [day(req)]);
      res.json(rows.reverse().map((x) => ({
        id: String(x.id),
        timestamp: new Date(x.created_at).toISOString(),
        text: x.reasoning,
      })));
    } catch (e) { fail(res)(e); }
  });

  r.post('/ai/ask', async (req, res) => {
    try {
      const { symbol, prompt, question, tradingState } = req.body || {};
      const out = await claude.ask({
        symbol, question: prompt || question, position: tradingState,
        tradingDay: day(req), budgetKd: budget(req), surface: 'DETAIL',
      });
      // `text` is what the existing frontend reads. Kept.
      res.json({ text: out.text, ok: out.ok, source: out.ok ? 'engine' : out.code });
    } catch (e) { fail(res)(e); }
  });

  // ---- live · used by the detail page and the alert ---------------------
  r.get('/live/filltime/:symbol', async (req, res) => {
    try { res.json(await live.fillTime(req.params.symbol, { budgetKd: budget(req) })); }
    catch (e) { fail(res)(e); }
  });

  r.get('/live/depth/:symbol', async (req, res) => {
    try { res.json(await depth.signalFor(req.params.symbol, day(req))); }
    catch (e) { fail(res)(e); }
  });

  r.get('/live/wakeups', async (req, res) => {
    try { res.json(await live.wakeUpScan(day(req))); } catch (e) { fail(res)(e); }
  });

  // ---- history · the three feeds the pages were inventing ---------------
  r.get('/orders', wrap(async (req, res) => {
    res.json(await history.orders({ from: req.query.from || null, to: req.query.to || null }));
  }));

  r.get('/performance/daily', wrap(async (req, res) => {
    res.json(await history.dailyPnl({ from: req.query.from || null, to: req.query.to || null }));
  }));

  r.get('/candles/:symbol', wrap(async (req, res) => {
    res.json(await history.candles(req.params.symbol, {
      day: req.query.date || null, minutes: Number(req.query.minutes) || 5 }));
  }));

  // ---- order rules · called before the form accepts a price -------------
  r.post('/rules/sell-amend', (req, res) => res.json(rules.checkSellAmend(req.body || {})));
  r.post('/rules/buy-reposition', (req, res) => res.json(rules.checkBuyReposition(req.body || {})));
  r.post('/rules/stranded', (req, res) => res.json(rules.checkStranded(req.body || {})));

  return r;
}

/** Kept local so routes.js has one import for the account shape. */
async function accountSummary(day, db = pool) {
  const { rows: [c] } = await db.query(
    `SELECT COALESCE(sum(amount_kd),0) AS cash_kd,
            COALESCE(sum(amount_kd) FILTER (WHERE settles_on IS NULL OR settles_on <= $1),0) AS settled_kd,
            COALESCE(sum(amount_kd) FILTER (WHERE kind IN ('DEPOSIT','WITHDRAWAL')),0) AS net_deposited_kd
       FROM spread.cash_movement;`, [day]);

  const { rows: [cl] } = await db.query(
    'SELECT COALESCE(sum(amount_kd),0) AS claimed FROM spread.claim WHERE trading_day = $1;', [day]);

  const { rows: open } = await db.query(
    `SELECT l.symbol, l.price_fils, COALESCE(l.filled_shares, l.shares) AS shares,
            (SELECT bid FROM spread.v_quote_screening q
              WHERE q.symbol = l.symbol ORDER BY created_at DESC LIMIT 1) AS bid
       FROM spread.order_leg l
      WHERE ${OPEN_BUY('l')};`)/* a DB failure must not become an empty list — see errors.js */;

  let investedKd = 0, marketKd = 0;
  for (const p of open) {
    const sh = Number(p.shares), px = Number(p.price_fils);
    investedKd += (px * sh) / 1000;
    marketKd += (Number(p.bid ?? px) * sh) / 1000;
  }

  return {
    cashKd: Number(c.cash_kd), settledKd: Number(c.settled_kd),
    netDepositedKd: Number(c.net_deposited_kd), claimedKd: Number(cl.claimed),
    investedKd, marketKd, openPositions: open.length,
  };
}

module.exports = { build, board, invalidate, contracts, accountSummary, pnlSummary };
