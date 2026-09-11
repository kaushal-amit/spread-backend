'use strict';
/**
 * ============================================================================
 *  api/trading_routes.js — the five writes that move a position or cash
 * ============================================================================
 * Split out of routes.js so the invariants sit together:
 *
 *   1. A FILLED leg writes TWO cash rows (notional, fee) in the SAME
 *      transaction as the leg. A fill that does not move cash is the same
 *      class of bug as a fill that does not save.
 *   2. A SELL never exceeds what is held (B-08). Quantity is checked against
 *      positions.openBuy().remaining_shares, inside the transaction.
 *   3. contract_seq is allocated under a per-symbol lock (B-09).
 *   4. The one-position rule applies on EVERY path that creates a FILLED BUY
 *      (B-10): record, resolve — not only the claim.
 *   5. Prices come from TODAY's quote (B-11), and hit-bid refuses when the
 *      market is closed. Fees carry the instrument's market (B-12).
 * ============================================================================
 */
const { pool } = require('../db');
const rules = require('../lib/orderRules');
const COMMISSION = require('../lib/commission');
const gateStore = require('../services/gateStore');
const positions = require('./positions');
const { wrap, refused, notFound, badRequest, notReady } = require('./errors');
const { dayParam, symbolParam, amountParam } = require('./params');

const LEG_STATUS = ['POSTED', 'FILLED', 'CANCELLED', 'EXPIRED', 'CARRIED', 'AUCTION_SUBMITTED'];

/** The board cache lives in routes.js; resolved late because the require is circular. */
function invalidate() { return require('./routes').invalidate(); }
const contracts = positions.contracts;

/** Two cash rows for a fill, on the transaction client. */
async function bookFill(client, { day, leg, side, shares, priceFils, feeKd, symbol }) {
  const notionalKd = (Number(priceFils) * Number(shares)) / 1000;
  const isBuy = side === 'BUY';
  await client.query(
    `INSERT INTO spread.cash_movement (trading_day, kind, amount_kd, order_leg_id, note)
     VALUES ($1,$2,$3,$4,$5),($1,'FEE',$6,$4,$7);`,
    [day, isBuy ? 'BUY' : 'SELL', isBuy ? -notionalKd : notionalKd, leg.id,
     `${symbol} ${Number(shares).toLocaleString('en-US')} @ ${priceFils}`,
     -feeKd, `${symbol} ${side.toLowerCase()} commission`]);
  return notionalKd;
}

/**
 * B-10 · the one-position rule, on every path that opens one.
 *
 * 3.8 · a CLAIM is a position that has not filled yet. It reserves the slot
 * (sizing counts it as committed), so it counts here too: with EQUIPMENT
 * claimed, a filled buy in KFIC is a second position, not a first. The
 * symbol being acted on is excepted — filling the claim you hold is the
 * point of holding it.
 */
async function assertPositionRoom(db, { exceptSymbol = null, day = null } = {}) {
  const open = await positions.openBuys(db);
  const { rows: claims } = await db.query(
    'SELECT symbol FROM spread.claim WHERE trading_day = $1;', [day || require('../jobs/daily').kuwaitDay()]);
  const held = new Map();
  for (const o of open) held.set(o.symbol, 'open');
  for (const c of claims) if (!held.has(c.symbol)) held.set(c.symbol, 'claimed');
  if (exceptSymbol) held.delete(exceptSymbol);
  // R-13 / A2 · the slot and the fee band come from the SET session budget +
  // commission.js, not a literal: one round trip on the full slot vs two on half
  // each. No budget set → 503, never a fee band off a default number.
  const slotKd = gateStore.sessionBudgetKd();
  if (slotKd == null) throw notReady('no session budget is set', 'set it with PUT /gates {"session-budget": 2000}');
  const COMMISSION = require('../lib/commission');
  // Dated: the settlement fee is abolished from 1 October 2026 and the fee
  // band must move with it, or the split-vs-single decision here disagrees
  // with the ledger by 1 KD a round trip from that day.
  const feeDay = day || require('../jobs/daily').kuwaitDay();
  const feeSingleKd = COMMISSION.roundTripKd(slotKd, slotKd, { day: feeDay }).kd;
  const feeSplitKd = 2 * COMMISSION.roundTripKd(slotKd / 2, slotKd / 2, { day: feeDay }).kd;
  const guard = rules.checkNewPosition({
    openPositions: held.size,
    maxPositions: gateStore.effective().BUDGET.maxPositions,
    slotKd, feeSingleKd, feeSplitKd,
  });
  if (!guard.allowed) {
    throw refused(guard.message,
      [...held].map(([s, k]) => `${s} (${k})`).join(', ') + ' — release the claim (POST /trading/untrade) or close the position first');
  }
}

/**
 * R-19 / R-20 · the market gate and the session stops, enforced where a NEW
 * position is decided. A refusal names the rule and the reading.
 */
async function assertCanOpen(day, { db = pool, now } = {}) {
  const st = await require('../services/stops').evaluate(day, { db, now });
  if (!st.canOpen) {
    throw refused(`no new position: ${st.reasons[0]}`,
      (st.reasons.length > 1 ? st.reasons.slice(1).join(' · ') + ' — ' : '') +
      `mode ${st.mode.toUpperCase()}${st.market?.breadthPct != null ? `, breadth ${st.market.breadthPct}% at ${st.market.clock}` : ''}`);
  }
  return st;
}

/** A FILLED BUY that lands while a stop is in force is booked AND recorded as a breach. */
async function breachIfStopped(db, day, symbol, detail) {
  const st = await require('../services/stops').evaluate(day, { db }).catch(() => null);
  if (!st || st.canOpen) return null;
  const breach = { mode: st.mode, reasons: st.reasons, at: new Date().toISOString() };
  await logEvent(db, { day, symbol, action: 'STOP_BREACHED', detail: { ...breach, ...detail } });
  return breach;
}

/** 3.8 · a claim's life is recorded, not erased. */
async function logEvent(db, { day, symbol, action, detail }) {
  await db.query(
    `INSERT INTO spread.event_log (trading_day, symbol, action, detail) VALUES ($1,$2,$3,$4);`,
    [day, symbol, action, JSON.stringify(detail || {})]);
}

function mount(r) {
  const day = (req) => dayParam(req.query.date ?? req.body?.date);

  r.post('/trading/move', wrap(async (req, res) => {
    const d = day(req);
    // `placement` was sent by the client and destructured as `override`, so
    // INSIDE vs AT_BID was silently discarded on every call.
    const { amountKd, placement, override } = req.body || {};
    const symbol = symbolParam(req.body?.symbol);
    // 3.6 / A2 · finite, > 0, and no larger than the slot; absent = the slot.
    // The slot is the SET session budget; no budget → 503, never a default.
    const slot = gateStore.sessionBudgetKd();
    if (slot == null) throw notReady('no session budget is set', 'set it with PUT /gates {"session-budget": 2000}');
    const kd = amountParam(amountKd, { max: slot, fallback: slot });
    if (placement != null && !['AT_BID', 'INSIDE_GAP'].includes(placement)) {
      throw badRequest(`placement "${placement}" is not AT_BID or INSIDE_GAP`);
    }

    // A-01 · count OPEN positions, not every buy ever filled — and claims.
    await assertPositionRoom(pool, { exceptSymbol: symbol, day: d });
    // R-19 / R-20 · a claim is a decision to open; the gate and the stops apply.
    await assertCanOpen(d);

    const { rows: [claim] } = await pool.query(
      `INSERT INTO spread.claim (trading_day, symbol, amount_kd, is_override, placement)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (trading_day, symbol) DO UPDATE
         SET amount_kd = $3, is_override = $4, placement = $5, at = now()
       RETURNING *;`,
      [d, symbol, kd, !!override, placement || null]);
    await logEvent(pool, { day: d, symbol, action: 'CLAIM_PLACED', detail: claim });

    invalidate();
    res.json({ ok: true, contracts: await contracts(d) });
  }));

  r.post('/trading/untrade', wrap(async (req, res) => {
    const d = day(req);
    const symbol = symbolParam(req.body?.symbol);
    // 3.8 · the released claim is written to event_log BEFORE the row goes,
    // in one transaction: a claim that was placed and released leaves a
    // record, where a hard delete left nothing to review.
    const client = await pool.connect();
    let released = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'DELETE FROM spread.claim WHERE trading_day = $1 AND symbol = $2 RETURNING *;', [d, symbol]);
      if (rows[0]) {
        released = Number(rows[0].amount_kd || 0);
        await logEvent(client, { day: d, symbol, action: 'CLAIM_RELEASED', detail: rows[0] });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    invalidate();
    res.json({ symbol, releasedKd: released, released: released > 0 });
  }));

  /*
   * Recording a leg.
   *
   * `filledShares` is optional: a FILLED leg fills `shares` unless told
   * otherwise, and a partial fill (filledShares < shares) is a real state the
   * ledger must carry — B-08.
   */
  r.post('/trading/record', wrap(async (req, res) => {
    const d = day(req);
    const { side, status, priceFils, shares, seq, note, executions, filledShares } = req.body || {};

    const sym = symbolParam(req.body?.symbol);
    if (!['BUY', 'SELL'].includes(side)) throw badRequest('side must be BUY or SELL');
    if (!LEG_STATUS.includes(status)) throw badRequest(`status "${status}" is not a leg status`);
    if (!(Number(priceFils) > 0)) throw badRequest('priceFils must be positive');
    if (!(Number(shares) > 0) || !Number.isInteger(Number(shares))) {
      throw badRequest('shares must be a positive whole number');
    }
    if (executions != null && !(Number(executions) >= 1)) {
      throw badRequest('executions must be 1 or more when given');
    }
    if (seq != null && !Number.isInteger(Number(seq))) throw badRequest('seq must be an integer');

    const isFill = status === 'FILLED' || status === 'CARRIED';
    let filled = null;
    if (isFill) {
      filled = filledShares == null ? Number(shares) : Number(filledShares);
      if (!(filled > 0) || filled > Number(shares) || !Number.isInteger(filled)) {
        throw badRequest('filledShares must be a whole number between 1 and shares');
      }
    }

    const premier = await positions.isPremier(sym);
    const client = await pool.connect();
    // Hoisted so the response can be built AFTER the transaction has closed.
    let committed = false, warning = null, fee = null, expectedExecutions = null, ruleBreach = null;
    try {
      await client.query('BEGIN');
      // Every read below is INSIDE the transaction and behind the symbol lock,
      // so two concurrent records cannot both see "no open position".
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${sym}`]);
      const openBuy = await positions.openBuy(sym, client);

      let contractSeq = seq == null ? null : Number(seq);
      warning = null;

      if (side === 'SELL') {
        if (!openBuy) {
          throw refused(`there is no open position in ${sym} to sell`,
            'record the buy first, or use a different symbol');
        }
        if (contractSeq == null) contractSeq = Number(openBuy.contract_seq);
        else if (Number(openBuy.contract_seq) !== contractSeq) {
          // V-02 · a stale seq is refused, not trusted.
          throw refused(`contract ${contractSeq} is not the open contract in ${sym}`,
            `the open contract is ${openBuy.contract_seq}. Leave the contract field blank to ` +
            'let the engine resolve it, or correct it to the open one.');
        }
        // B-08 · never sell what is not held.
        const qty = isFill ? filled : Number(shares);
        if (qty > openBuy.remaining_shares) {
          throw refused(
            `${qty.toLocaleString('en-US')} shares exceeds the ${openBuy.remaining_shares.toLocaleString('en-US')} held in ${sym}`,
            'a sell larger than the position books proceeds for shares you do not own');
        }
        // D3 at the source — warn, never block, because closing flat can be
        // deliberate. 3.8 · against the buy on THIS contract and the last
        // sell posted on THIS contract, so "moved down" means moved down
        // from where this position's exit was, not from another contract's.
        const { rows: [prior] } = await client.query(
          `SELECT price_fils FROM spread.order_leg
            WHERE symbol = $1 AND contract_seq = $2 AND side = 'SELL'
              AND status IN ('POSTED','CANCELLED','EXPIRED')
            ORDER BY posted_at DESC, id DESC LIMIT 1;`, [sym, contractSeq]);
        const chk = rules.checkSellAmend({
          newPriceFils: Number(priceFils), avgCostFils: Number(openBuy.price_fils),
          currentPriceFils: prior ? Number(prior.price_fils) : null,
          shares: qty, commissionKd: Number(openBuy.commission_kd || 0) * 2 });
        if (!chk.allowed || chk.warning) warning = chk.message || chk.warning;
      } else {
        // BUY. One filled buy per contract (017), one open position (B-10).
        // R-19 / R-20 · a POSTED buy is a decision: refused under a stop. A
        // FILLED buy is a fact: booked, and the breach recorded (below).
        if (!isFill) await assertCanOpen(d, { db: client });
        // One open position per symbol — POSTED or FILLED. The check ran only
        // on a fill: a POSTED BUY while holding the symbol was accepted, and
        // resolving it FILLED (whose room check excludes the symbol itself)
        // booked a SECOND open contract in the same stock. Adding to a
        // position is not a shape this ledger records; refuse it at the post.
        if (openBuy) {
          throw refused(`${sym} already has an open position (contract ${openBuy.contract_seq}, ` +
            `${openBuy.remaining_shares.toLocaleString('en-US')} held)`,
            'sell it first — adding to a position is not a shape this ledger records');
        }
        if (isFill) await assertPositionRoom(client, { exceptSymbol: sym, day: d });
        if (contractSeq == null) contractSeq = await positions.allocateSeq(client, sym);
      }

      const notionalKd = (Number(priceFils) * (filled ?? Number(shares))) / 1000;
      fee = isFill
        ? COMMISSION.sideFeeKd(notionalKd, { day: d, premier, executions: executions ?? null })
        : { kd: 0, known: true, executions: null };

      expectedExecutions = null;
      if (isFill && !fee.known) {
        const { rows: [prof] } = await client.query(
          `SELECT avg_trade_shares FROM spread.symbol_day
            WHERE symbol = $1 AND trading_day = $2;`, [sym, d]);
        expectedExecutions = COMMISSION.expectedExecutions(
          filled, Number(prof?.avg_trade_shares || 0));
      }

      // 3.8 · exit_venue from the ROUTE: a filled sell recorded here was a
      // resting limit order that filled. hit-bid writes MARKET.
      const exitVenue = side === 'SELL' && isFill ? 'LIMIT' : null;
      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, executions, posted_at, resolved_at, note, exit_venue)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),
                 CASE WHEN $5='POSTED' THEN NULL ELSE now() END,$11,$12)
         RETURNING *;`,
        [d, sym, contractSeq, side, status, priceFils, shares,
         filled, fee.kd, executions ?? null, note ?? null, exitVenue]);

      ruleBreach = null;
      if (isFill) {
        await bookFill(client, { day: d, leg, side, shares: filled, priceFils, feeKd: fee.kd, symbol: sym });
        if (side === 'BUY') ruleBreach = await breachIfStopped(client, d, sym, { legId: leg.id, priceFils, shares: filled });
      }
      await client.query('COMMIT');
      committed = true;
      invalidate();
    } catch (e) {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    // AFTER the transaction, outside its try: this read used to sit inside it,
    // so a failure here (a pool hiccup on contracts()) answered the client with
    // an error for a write that HAD committed — and a retry booked it twice.
    // The write is done; if the read-back fails, say so without un-saying it.
    let contractsNow = null, readBackError = null;
    try { contractsNow = await contracts(d); }
    catch (e) { readBackError = 'the record is saved; the position list could not be re-read — refresh'; }
    res.json({
      ok: true, warning: ruleBreach ? `${warning ? warning + ' · ' : ''}STOP BREACHED: ${ruleBreach.reasons.join(' · ')}` : warning,
      ruleBreach,
      commissionKnown: fee.known,
      expectedExecutions,
      partial: isFill && filled < Number(shares) ? { filled, of: Number(shares) } : null,
      contracts: contractsNow,
      note: readBackError,
    });
  }));

  /*
   * Selling into the bid — the LAST rung of the exit ladder.
   *
   * Sells what is STILL HELD, at TODAY's bid, while the market is open.
   * Refuses if a sell is already resting — two exits for one position is how
   * a short happens.
   */
  r.post('/trading/hit-bid', wrap(async (req, res) => {
    const d = day(req);
    const sym = symbolParam(req.body?.symbol);
    const executions = Number.isFinite(Number(req.body?.executions))
      ? Number(req.body.executions) : null;

    const { sessionPhase } = require('../socket');
    const phase = sessionPhase();
    if (!phase?.open) {
      throw refused('the market is closed — there is no bid to hit',
        'a hit-bid records a trade at the current bid; outside the session the latest quote is stale');
    }
    // R-08 · flat by 12:45, not into the auction. The 12:30 alert is the
    // warning; this is the rule. After the flat-by clock a hit-bid is refused —
    // by then you should already be flat, and selling into the pre-close
    // auction window is the 30 August −12.59 lesson.
    {
      const stops = await require('../services/stops').evaluate(d).catch(() => null);
      if (stops && stops.pastFlatBy) {
        throw refused(`past ${stops.flatBy} — you should be flat, not trading into the auction`,
          'the flat-by rule (FLOW step 7): a sell after this window records into the pre-close auction, where a 30 August exit filled 11 fils away');
      }
    }

    const q = await positions.latestQuote(sym, d);
    if (!q?.bid) throw notFound(`no bid for ${sym} today — nothing to sell into`);
    const premier = await positions.isPremier(sym);

    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${sym}`]);
      const buy = await positions.openBuy(sym, client);
      if (!buy) throw notFound(`no open position in ${sym}`);

      const { rows: [resting] } = await client.query(
        `SELECT id, price_fils, shares FROM spread.order_leg
          WHERE symbol = $1 AND contract_seq = $2 AND side = 'SELL' AND status = 'POSTED'
          LIMIT 1;`, [sym, buy.contract_seq]);
      if (resting) {
        throw refused(`a sell of ${Number(resting.shares).toLocaleString('en-US')} at ${resting.price_fils} is already resting in ${sym}`,
          `cancel leg ${resting.id} first (POST /trading/resolve {legId, status: "CANCELLED"}), then hit the bid`);
      }

      const bid = Number(q.bid);
      const entry = Number(buy.price_fils);
      const shares = buy.remaining_shares;
      const notionalKd = (bid * shares) / 1000;
      const fee = COMMISSION.sideFeeKd(notionalKd, { day: d, premier, executions: executions ?? null });
      const roundTrip = Number(buy.commission_kd || 0) + fee.kd;
      const costKd = Number((((bid - entry) * shares) / 1000 - roundTrip).toFixed(3));

      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, executions, posted_at, resolved_at, exit_venue, note)
         VALUES ($1,$2,$3,'SELL','FILLED',$4,$5,$5,$6,$7,now(),now(),'MARKET',$8)
         RETURNING id;`,
        [d, sym, buy.contract_seq, bid, shares, fee.kd, executions ?? null,
         'hit the bid — last rung of the exit ladder']);
      await bookFill(client, { day: d, leg, side: 'SELL', shares, priceFils: bid, feeKd: fee.kd, symbol: sym });
      await client.query('COMMIT');

      out = {
        costKd, commissionKnown: fee.known,
        note: `Sold ${shares.toLocaleString('en-US')} at ${bid} against an entry of ${entry}. ` +
              `Net ${costKd >= 0 ? '+' : ''}${costKd.toFixed(2)} KD after ${roundTrip.toFixed(2)} ` +
              'commission. Dumping into the bid measured −5,270 KD against +3,014 for waiting.',
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    invalidate();
    res.json({ ...out, contracts: await contracts(d) });
  }));

  /*
   * R-42 · CANCEL the resting SELL and HIT the bid in ONE transaction. The
   * detail page's two buttons are one write and one message: a refusal on
   * either half (past the flat-by clock, no open position, no bid) rolls BOTH
   * back — the resting offer is left exactly where it was, never cancelled into
   * a hit that then refused. Degrades to a plain hit when nothing is resting.
   */
  r.post('/trading/cancel-and-hit', wrap(async (req, res) => {
    const d = day(req);
    const sym = symbolParam(req.body?.symbol);
    const executions = Number.isFinite(Number(req.body?.executions)) ? Number(req.body.executions) : null;

    const { sessionPhase } = require('../socket');
    if (!sessionPhase()?.open) {
      throw refused('the market is closed — there is no bid to hit',
        'a hit-bid records a trade at the current bid; outside the session the latest quote is stale');
    }
    const q = await positions.latestQuote(sym, d);
    if (!q?.bid) throw notFound(`no bid for ${sym} today — nothing to sell into`);
    const premier = await positions.isPremier(sym);

    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${sym}`]);
      const buy = await positions.openBuy(sym, client);
      if (!buy) throw notFound(`no open position in ${sym}`);

      // ── the CANCEL half ──────────────────────────────────────────────────
      const { rows: [resting] } = await client.query(
        `SELECT id, price_fils, shares FROM spread.order_leg
          WHERE symbol = $1 AND contract_seq = $2 AND side = 'SELL' AND status = 'POSTED'
          ORDER BY id LIMIT 1;`, [sym, buy.contract_seq]);
      let cancelled = null;
      if (resting) {
        await client.query("UPDATE spread.order_leg SET status = 'CANCELLED', resolved_at = now() WHERE id = $1;", [resting.id]);
        cancelled = { legId: resting.id, priceFils: Number(resting.price_fils), shares: Number(resting.shares) };
      }

      // ── the HIT half ─────────────────────────────────────────────────────
      // R-08 · flat by 12:45. A refusal here rolls the cancel back with it, so
      // the resting offer is never lost to a hit that did not happen.
      const stops = await require('../services/stops').evaluate(d, { db: client }).catch(() => null);
      if (stops && stops.pastFlatBy) {
        throw refused(`past ${stops.flatBy} — you should be flat, not trading into the auction`,
          'the flat-by rule (FLOW step 7): the hit is refused and the resting offer is left in place — nothing was cancelled');
      }

      const bid = Number(q.bid);
      const entry = Number(buy.price_fils);
      const shares = buy.remaining_shares;
      const notionalKd = (bid * shares) / 1000;
      const fee = COMMISSION.sideFeeKd(notionalKd, { day: d, premier, executions: executions ?? null });
      const roundTrip = Number(buy.commission_kd || 0) + fee.kd;
      const costKd = Number((((bid - entry) * shares) / 1000 - roundTrip).toFixed(3));

      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, executions, posted_at, resolved_at, exit_venue, note)
         VALUES ($1,$2,$3,'SELL','FILLED',$4,$5,$5,$6,$7,now(),now(),'MARKET',$8)
         RETURNING id;`,
        [d, sym, buy.contract_seq, bid, shares, fee.kd, executions ?? null,
         cancelled ? `cancelled the resting ${cancelled.priceFils} offer and hit the bid` : 'hit the bid — last rung of the exit ladder']);
      await bookFill(client, { day: d, leg, side: 'SELL', shares, priceFils: bid, feeKd: fee.kd, symbol: sym });
      await client.query('COMMIT');

      out = {
        cancelled, costKd, commissionKnown: fee.known,
        note: `${cancelled ? `Cancelled the ${cancelled.priceFils} offer and s` : 'S'}old ${shares.toLocaleString('en-US')} at ${bid} against an entry of ${entry}. `
          + `Net ${costKd >= 0 ? '+' : ''}${costKd.toFixed(2)} KD after ${roundTrip.toFixed(2)} commission.`,
      };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }

    invalidate();
    res.json({ ...out, contracts: await contracts(d) });
  }));

  /*
   * V-05 · only a POSTED order can resolve, and only into the three outcomes a
   * posted order has. A FILLED outcome books cash; a FILLED SELL is checked
   * against what is held; a FILLED BUY is checked against the position limit.
   */
  r.post('/trading/resolve', wrap(async (req, res) => {
    const executions = Number.isFinite(Number(req.body?.executions))
      ? Number(req.body.executions) : null;
    const { legId, status, filledShares } = req.body || {};
    const OUTCOMES = ['FILLED', 'EXPIRED', 'CANCELLED'];

    if (!Number.isInteger(Number(legId))) throw badRequest('legId must be an integer');
    if (!OUTCOMES.includes(status)) {
      throw badRequest(`status must be one of ${OUTCOMES.join(', ')}`);
    }

    const d = day(req);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [leg] } = await client.query(
        'SELECT * FROM spread.order_leg WHERE id = $1 FOR UPDATE;', [legId]);
      if (!leg) throw notFound(`no leg ${legId}`);
      if (leg.status !== 'POSTED') {
        throw refused(`leg ${legId} is ${leg.status}, not POSTED`,
          'only a resting order can be resolved — a filled leg is already settled, and moving it ' +
          'would put the cash ledger out of step with the position');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${leg.symbol}`]);

      let shares = Number(leg.shares);
      let fee = { kd: 0, known: true };
      if (status === 'FILLED') {
        if (filledShares != null) {
          const f = Number(filledShares);
          if (!(f > 0) || f > shares || !Number.isInteger(f)) {
            throw badRequest('filledShares must be a whole number between 1 and shares');
          }
          shares = f;
        }
        if (leg.side === 'SELL') {
          const buy = await positions.openBuy(leg.symbol, client);
          if (!buy) throw refused(`no open position in ${leg.symbol} for this sell to close`);
          if (shares > buy.remaining_shares) {
            throw refused(`${shares.toLocaleString('en-US')} exceeds the ${buy.remaining_shares.toLocaleString('en-US')} held in ${leg.symbol}`,
              'resolve with filledShares no larger than the position');
          }
        } else {
          // The same rule at the fill: a second open contract in one symbol
          // is refused even if a POSTED leg slipped through earlier.
          const already = await positions.openBuy(leg.symbol, client);
          if (already && Number(already.id) !== Number(leg.id)) {
            throw refused(`${leg.symbol} already has an open position (contract ${already.contract_seq}, ` +
              `${already.remaining_shares.toLocaleString('en-US')} held) — this fill would open a second one`,
              'cancel this leg (status CANCELLED) or sell the position first');
          }
          await assertPositionRoom(client, { exceptSymbol: leg.symbol, day: d });
        }
        const premier = await positions.isPremier(leg.symbol, client);
        const notionalKd = (Number(leg.price_fils) * shares) / 1000;
        fee = COMMISSION.sideFeeKd(notionalKd, { day: d, premier, executions: executions ?? null });
      }

      await client.query(
        `UPDATE spread.order_leg
            SET status=$2, resolved_at=now(),
                filled_shares = CASE WHEN $2='FILLED' THEN $3 ELSE filled_shares END,
                commission_kd = CASE WHEN $2='FILLED' THEN $4 ELSE commission_kd END,
                executions    = CASE WHEN $2='FILLED' THEN $5 ELSE executions END,
                -- 3.8 · a resting sell that filled is a LIMIT exit.
                exit_venue    = CASE WHEN $2='FILLED' AND side='SELL' THEN 'LIMIT' ELSE exit_venue END
          WHERE id=$1;`, [legId, status, shares, fee.kd, executions ?? null]);

      let ruleBreach = null;
      if (status === 'FILLED') {
        await bookFill(client, { day: d, leg, side: leg.side, shares,
          priceFils: leg.price_fils, feeKd: fee.kd, symbol: leg.symbol });
        if (leg.side === 'BUY') ruleBreach = await breachIfStopped(client, d, leg.symbol, { legId: leg.id, priceFils: Number(leg.price_fils), shares });
      }
      await client.query('COMMIT');
      invalidate();
      res.json({ ok: true, ruleBreach,
        warning: ruleBreach ? `STOP BREACHED: ${ruleBreach.reasons.join(' · ')}` : null,
        contracts: await contracts(d) });
      return;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }));
}

module.exports = { mount, bookFill, assertPositionRoom, assertCanOpen };
