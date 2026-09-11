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
const { wrap, refused, notFound, badRequest, notReady, ApiError } = require('./errors');
const { dayParam, symbolParam, amountParam } = require('./params');

const LEG_STATUS = ['POSTED', 'FILLED', 'CANCELLED', 'EXPIRED', 'CARRIED', 'AUCTION_SUBMITTED'];

/**
 * F3 / F4 · a refusal the operator MAY take anyway, with a reason. 409 like a
 * refusal, but its own code so the terminal offers TAKE IT ANYWAY instead of
 * a dead end. A structural refusal (below tick, above the ceiling, no funds)
 * stays plain REFUSED — arithmetic, not judgement.
 */
const overridable = (code, msg, detail) => new ApiError(409, code, msg, detail);

/**
 * F2 · the stop, recorded ON THE BUY LEG at the fill and fixed thereafter.
 * "The stop was set before the fill. Moving it is how the large losses
 * happened." No aged shelf at that instant → null, said on the leg's note —
 * never a stop invented from the touch.
 */
async function stopAtFill(client, { legId, symbol, day, entryFils }) {
  const depth = require('../services/depth');
  const s = await depth.stopFor(symbol, day, entryFils, { now: new Date() })
    .catch((e) => ({ stopFils: null, reason: `stop not computed: ${e.message}` }));
  await client.query(
    `UPDATE spread.order_leg
        SET stop_fils = $2::numeric,
            note = CASE WHEN $2::numeric IS NULL THEN concat_ws(' · ', note, $3::text) ELSE note END
      WHERE id = $1;`,
    [legId, s.stopFils, s.stopFils == null ? `no stop at the fill: ${s.reason}` : null]);
  return { stopFils: s.stopFils, reason: s.reason };
}

/**
 * F3 / F4 · the facts a POSTED BUY is judged on: the sizing band for the
 * symbol at this budget, and the board's bucket for it. Returns the facts;
 * throws when they refuse and no override was given.
 *
 *   structural (below tick / above the ceiling / cannot fund the floor)
 *                                     → REFUSED, no override (CR-8)
 *   kd outside [floor, ceiling]       → OUTSIDE_SIZE_BAND, overridable
 *   card not TAKE                     → NOT_TAKE, overridable
 *   board not computed                → BOARD_NOT_COMPUTED, overridable —
 *                                        loud, never a silent pass
 *
 * An override needs the operator's reason (400 without one); it is written
 * on the leg (is_override, override_reason) with the facts in the note.
 */
async function assertPostable({ symbol, day, priceFils, shares, override, overrideReason }) {
  const kd = (Number(priceFils) * Number(shares)) / 1000;
  const facts = { kd: Number(kd.toFixed(3)), floorKd: null, ceilingKd: null, bucket: null, failed: [], refusals: [] };
  if (override && !(typeof overrideReason === 'string' && overrideReason.trim())) {
    throw badRequest('an override needs a reason — overrideReason is the operator\'s words, written on the leg');
  }

  // ── the sizing band ──
  const sizing = await require('./sizing').sizingFor(symbol)
    .catch((e) => ({ error: e.message, reasons: [], reachable: false, floor_kd: null, ceiling_kd: null }));
  facts.floorKd = sizing.floor_kd ?? null;
  facts.ceilingKd = sizing.ceiling_kd ?? null;
  if ((sizing.reasons || []).length) {
    // Below the tick band or above max_price_fils: arithmetic, no override.
    throw refused(`${symbol} cannot be traded at this budget: ${sizing.reasons[0]}`, 'structural — arithmetic, not judgement: no override');
  }
  if (sizing.error) {
    facts.refusals.push(`sizing not computed: ${sizing.error}`);
  } else {
    const minPos = Number((await require('./sizing').thresholds().catch(() => ({}))).min_position_kd);
    if (Number.isFinite(minPos) && sizing.basis && Number(sizing.basis.free_kd) < minPos) {
      throw refused(`free ${Number(sizing.basis.free_kd).toFixed(0)} KD is under the ${minPos} KD minimum position — nothing can be funded`,
        'structural — release the claim or close the position first');
    }
    // One lot of tolerance under the floor: suggested_shares is lot-rounded
    // DOWN, so the server's own suggestion can sit a lot under floor_kd.
    const lotKd = (Number(priceFils) * 100) / 1000;
    if (facts.floorKd != null && kd < facts.floorKd - lotKd) {
      facts.refusals.push(`${kd.toFixed(0)} KD is under the ${Number(facts.floorKd).toFixed(0)} KD floor — under the minimum share of the aged bid, invisible in the queue`);
    }
    if (facts.ceilingKd != null && kd > facts.ceilingKd + 0.001) {
      facts.refusals.push(`${kd.toFixed(0)} KD is over the ${Number(facts.ceilingKd).toFixed(0)} KD ceiling (you would be the level, or it exceeds free)`);
    }
  }
  if (facts.refusals.length && !override) {
    throw overridable('OUTSIDE_SIZE_BAND', `${symbol}: ${facts.refusals[0]}`,
      `band ${facts.floorKd == null ? '?' : Number(facts.floorKd).toFixed(0)}–${facts.ceilingKd == null ? '?' : Number(facts.ceilingKd).toFixed(0)} KD at ${priceFils} — resize, or take it anyway with a reason (override: true, overrideReason)`);
  }

  // ── the card's bucket ──
  const routes = require('./routes');
  const budget = gateStore.sessionBudgetKd();
  let card = null, boardError = null;
  try {
    const b = budget == null ? null : await routes.board(day, budget);
    if (b) {
      for (const k of ['take', 'oneAway', 'priceWarn', 'leave', 'notComputed']) {
        card = (b[k] || []).find((r) => r.symbol === symbol) || card;
        if (card) break;
      }
      if (!card) boardError = `${symbol} is not on the board for ${day}`;
    } else boardError = 'no session budget is set';
  } catch (e) { boardError = e.message; }
  if (card) {
    facts.bucket = card.bucket;
    facts.failed = card.failed || [];
    if (card.structural) {
      throw refused(`${symbol} is ${String(card.structuralReason || 'structural').replace(/_/g, ' ').toLowerCase()} on today's board`,
        'structural — arithmetic, not judgement: no override (CR-8)');
    }
    if (card.bucket !== 'TAKE' && !override) {
      throw overridable('NOT_TAKE', `${symbol} is ${card.bucket.replace(/_/g, ' ')}, not TAKE — ${facts.failed.length ? facts.failed.join(', ') : 'a gate is not computed'}`,
        'the card did not pass every gate. Take it anyway with a reason (override: true, overrideReason), and it is recorded as an override');
    }
  } else {
    facts.refusals.push(`board not computed: ${boardError}`);
    if (!override) {
      throw overridable('BOARD_NOT_COMPUTED', `the board could not judge ${symbol}: ${boardError}`,
        'a verdict that has not been read is not permission. Take it anyway with a reason, or wait for the board');
    }
  }
  return facts;
}

/**
 * Where a position can be CLOSED right now, and at what price (F5).
 *
 *   continuous trading   at the bid, venue MARKET — unless past the flat-by
 *                        clock (R-08: you should be flat, not trading into
 *                        the closing auction)
 *   Trading at Last      13:10–13:14, at the closing-auction price (the last
 *                        TAL print), venue AUCTION. The flat-by rule does not
 *                        apply: this IS the last honest exit of the day, at
 *                        one known price, not "into the auction".
 *   otherwise            refused — outside the session the latest quote is
 *                        stale and a "hit" records a trade that did not happen
 */
async function closeVenue(day, symbol, { db = pool } = {}) {
  const phase = require('../socket').sessionPhase();
  const tal = !!phase?.tal;
  if (!phase?.open && !tal) {
    throw refused('the market is closed — there is no bid to hit',
      'a hit-bid records a trade at the current bid; outside the session the latest quote is stale');
  }
  if (!tal) {
    const stops = await require('../services/stops').evaluate(day, { db }).catch(() => null);
    if (stops && stops.pastFlatBy) {
      throw refused(`past ${stops.flatBy} — you should be flat, not trading into the auction`,
        `the flat-by rule (FLOW step 7): a sell after this window records into the pre-close auction, where a 30 August exit filled 11 fils away. Trading at Last (${phase.clocks?.talStartClock || '13:10'}–${phase.clocks?.talEndClock || '13:15'}) closes at the auction price`);
    }
  }
  if (tal) {
    // The auction price is the last 'Trading at Last' print, never the 12:59 bid.
    const cp = await positions.latestClosePrint(symbol, day, db);
    if (!cp?.last_price) throw notFound(`no Trading-at-Last print for ${symbol} yet — nothing to close at`, 'the auction price is the last Trading-at-Last print; none has been captured for this symbol today');
    return { tal: true, priceFils: Number(cp.last_price), exitVenue: 'AUCTION', quote: cp };
  }
  const q = await positions.latestQuote(symbol, day, db);
  if (!q?.bid) throw notFound(`no bid for ${symbol} today — nothing to sell into`);
  return { tal: false, priceFils: Number(q.bid), exitVenue: 'MARKET', quote: q };
}

/**
 * F1 · a BUY rest still queued on this symbol blocks a close: sold flat with
 * the bid's rest resting, the rest fills later and re-opens the contract
 * behind the operator's back. The rest is pulled in Awsat as well — this
 * refusal says so and names the write that records it.
 */
async function assertNoBuyRest(symbol, client, buy) {
  const rests = await positions.restingLegs(symbol, client, { side: 'BUY' });
  const rest = rests.find((r) => r.status === 'FILLED') || rests[0];
  if (!rest) return;
  throw refused(`${rest.resting_shares.toLocaleString('en-US')} of the bid is still resting in ${symbol} (leg ${rest.id}${buy ? `, contract ${buy.contract_seq}` : ''})`,
    rest.status === 'POSTED'
      ? `resolve leg ${rest.id} first (POST /trading/resolve FILLED or CANCELLED), then close`
      : `pull the rest in Awsat and record it (POST /trading/resolve-rest {legId: ${rest.id}, status: "CANCELLED"}), then close — a rest that fills after you are flat re-opens the contract`);
}

/** The note an overridden post carries: the reason, then the facts it overrode. */
function overrideNote(facts, reason, note) {
  const bits = [`[override] ${String(reason).trim()}`];
  if (facts.bucket && facts.bucket !== 'TAKE') bits.push(`card ${facts.bucket}${facts.failed.length ? ` (${facts.failed.join(', ')})` : ''}`);
  for (const r of facts.refusals) bits.push(r);
  if (note) bits.push(String(note));
  return bits.join(' · ');
}

/** The board cache lives in routes.js; resolved late because the require is circular. */
// Every trading write touches the account, the contracts, the board (open
// symbols, stops) and the session (the stops). Announced so the socket pushes
// a partial snapshot at once (lib/events).
function invalidate(reason = 'trade') { return require('./routes').invalidate(['account', 'contracts', 'board', 'session'], reason); }
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

/**
 * F3 · a FILLED BUY recorded directly (not resolved from a post) that sits
 * outside the sizing band: booked as the fact it is, logged as BAND_BREACHED.
 * Only the band — the card's bucket is a decision aid, not a fact about a fill.
 */
async function breachIfOutsideBand(db, day, symbol, { legId, priceFils, shares }) {
  const sizing = await require('./sizing').sizingFor(symbol).catch(() => null);
  if (!sizing || sizing.error || sizing.floor_kd == null) return null;
  const kd = (Number(priceFils) * Number(shares)) / 1000;
  const lotKd = (Number(priceFils) * 100) / 1000;
  const refusals = [];
  if (kd < Number(sizing.floor_kd) - lotKd) refusals.push(`${kd.toFixed(0)} KD is under the ${Number(sizing.floor_kd).toFixed(0)} KD floor`);
  if (kd > Number(sizing.ceiling_kd) + 0.001) refusals.push(`${kd.toFixed(0)} KD is over the ${Number(sizing.ceiling_kd).toFixed(0)} KD ceiling`);
  if (!refusals.length) return null;
  const breach = { kd: Number(kd.toFixed(3)), floorKd: sizing.floor_kd, ceilingKd: sizing.ceiling_kd, refusals, at: new Date().toISOString() };
  await logEvent(db, { day, symbol, action: 'BAND_BREACHED', detail: { legId, priceFils, shares, ...breach } });
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
    const { side, status, priceFils, shares, seq, note, executions, filledShares, override, overrideReason } = req.body || {};

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
    // F3 / F4 · a POSTED BUY is the decision: judged against the sizing band
    // and the card's bucket BEFORE the transaction — both are reads, and a
    // cold board is a full screen that must not run under the symbol lock.
    // The harder facts (an open position, a resting rest) are checked first
    // so their refusal wins, then re-checked under the lock below.
    let postFacts = null, isOverride = false, legNote = note ?? null;
    if (side === 'BUY' && !isFill) {
      const pre = await positions.openBuy(sym);
      if (!pre) {
        const [preRest] = await positions.restingLegs(sym, pool, { side: 'BUY' });
        if (!preRest) {
          // R-19 / R-20 first: a stop in force refuses before the band is judged.
          await assertCanOpen(d);
          postFacts = await assertPostable({ symbol: sym, day: d, priceFils, shares, override: !!override, overrideReason });
          isOverride = !!(override && (postFacts.refusals.length || (postFacts.bucket && postFacts.bucket !== 'TAKE')));
          if (isOverride) legNote = overrideNote(postFacts, overrideReason, note);
        }
      }
    }
    const client = await pool.connect();
    // Hoisted so the response can be built AFTER the transaction has closed.
    let committed = false, warning = null, fee = null, expectedExecutions = null, ruleBreach = null, stop = null, bandBreach = null, restStatus = null;
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
        // F1 · a BUY rest still queued (its contract sold flat, the rest not
        // yet resolved) would re-open THAT contract when it fills; a new buy
        // beside it is two contracts in one symbol. Resolve the rest first.
        const [buyRest] = await positions.restingLegs(sym, client, { side: 'BUY' });
        if (buyRest) {
          throw refused(`${sym} still has ${buyRest.resting_shares.toLocaleString('en-US')} resting from ${buyRest.status === 'POSTED' ? 'a posted bid' : 'a partial fill'} (leg ${buyRest.id}, contract ${buyRest.contract_seq})`,
            buyRest.status === 'POSTED' ? 'resolve it first (POST /trading/resolve)' : 'resolve the rest first (POST /trading/resolve-rest FILLED or CANCELLED)');
        }
        if (isFill) await assertPositionRoom(client, { exceptSymbol: sym, day: d });
        // F3 / F4 · the postability facts were computed before BEGIN (above);
        // a POSTED BUY that reached here without them lost a race with a fill
        // that has since closed — judge it now rather than post unjudged.
        if (!isFill && !postFacts) {
          postFacts = await assertPostable({ symbol: sym, day: d, priceFils, shares, override: !!override, overrideReason });
          isOverride = !!(override && (postFacts.refusals.length || (postFacts.bucket && postFacts.bucket !== 'TAKE')));
          if (isOverride) legNote = overrideNote(postFacts, overrideReason, note);
        }
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
      // F1 · a partial fill recorded directly: the remainder is RESTING
      // (rest_status POSTED) on this same leg until resolve-rest says otherwise.
      // A CARRIED partial has no rest — the day order expired with the session.
      restStatus = status === 'FILLED' && filled < Number(shares) ? 'POSTED' : null;
      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, executions, posted_at, resolved_at, note, exit_venue,
            rest_status, is_override, override_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),
                 CASE WHEN $5='POSTED' THEN NULL ELSE now() END,$11,$12,$13,$14,$15)
         RETURNING *;`,
        [d, sym, contractSeq, side, status, priceFils, shares,
         filled, fee.kd, executions ?? null, legNote, exitVenue,
         restStatus, isOverride, isOverride ? String(overrideReason).trim() : null]);

      ruleBreach = null;
      if (isFill) {
        await bookFill(client, { day: d, leg, side, shares: filled, priceFils, feeKd: fee.kd, symbol: sym });
        if (side === 'BUY') {
          ruleBreach = await breachIfStopped(client, d, sym, { legId: leg.id, priceFils, shares: filled });
          // F2 · the stop is fixed at the fill.
          stop = await stopAtFill(client, { legId: leg.id, symbol: sym, day: d, entryFils: priceFils });
          // F3 · a fill recorded directly is a fact; outside the band it is
          // logged as a breach (like STOP_BREACHED) and said in the reply.
          bandBreach = await breachIfOutsideBand(client, d, sym, { legId: leg.id, priceFils, shares: filled });
        }
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
    const warnings = [warning, ruleBreach ? `STOP BREACHED: ${ruleBreach.reasons.join(' · ')}` : null,
      bandBreach ? `OUTSIDE THE BAND: ${bandBreach.refusals.join(' · ')}` : null].filter(Boolean);
    res.json({
      ok: true, warning: warnings.length ? warnings.join(' · ') : null,
      ruleBreach, bandBreach,
      commissionKnown: fee.known,
      expectedExecutions,
      // F1 · the remainder is resting — resolve it with /trading/resolve-rest.
      partial: restStatus === 'POSTED' ? { filled, of: Number(shares), resting: Number(shares) - filled } : null,
      // F2 · the stop as recorded (null with the reason when no shelf had aged).
      stop,
      override: isOverride ? { reason: String(overrideReason).trim(), facts: postFacts } : null,
      contracts: contractsNow,
      note: readBackError,
    });
  }));

  /*
   * F1 · the REST of a partial fill. A FILLED leg whose rest_status is POSTED
   * still has (shares − filled_shares) queued in Awsat. When that rest fills it
   * fills INTO THIS LEG — filled_shares grows, a second execution, a second fee
   * (per execution, as the settlement fee is charged) — never as a second buy,
   * which 017's one-buy-per-contract index forbids and record refuses. When it
   * is pulled, rest_status is CANCELLED and the fill stands as it was.
   *
   *   status FILLED     filledShares (≤ the rest; default = all of it), executions
   *   status CANCELLED  nothing else
   */
  r.post('/trading/resolve-rest', wrap(async (req, res) => {
    const d = day(req);
    const { legId, status, filledShares } = req.body || {};
    const executions = Number.isFinite(Number(req.body?.executions)) ? Number(req.body.executions) : null;
    if (!Number.isInteger(Number(legId))) throw badRequest('legId must be an integer');
    if (!['FILLED', 'CANCELLED'].includes(status)) throw badRequest('status must be FILLED or CANCELLED');
    if (executions != null && !(executions >= 1)) throw badRequest('executions must be 1 or more when given');

    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      // Lock ORDER: the symbol's advisory lock first (every trading write takes
      // it first), then the row — taking the row first deadlocked against
      // cancel-and-hit, which holds the symbol lock and then updates this row.
      const { rows: [peek] } = await client.query('SELECT symbol FROM spread.order_leg WHERE id = $1;', [legId]);
      if (!peek) throw notFound(`no leg ${legId}`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${peek.symbol}`]);
      const { rows: [leg] } = await client.query('SELECT * FROM spread.order_leg WHERE id = $1 FOR UPDATE;', [legId]);
      if (!leg) throw notFound(`no leg ${legId}`);
      if (leg.status !== 'FILLED' || leg.rest_status !== 'POSTED') {
        throw refused(`leg ${legId} has no resting remainder (${leg.status}${leg.rest_status ? `, rest ${leg.rest_status}` : ''})`,
          'resolve-rest is for the queued rest of a partial fill; a POSTED leg resolves with /trading/resolve');
      }
      const rest = Number(leg.shares) - Number(leg.filled_shares);

      if (status === 'CANCELLED') {
        await client.query(
          `UPDATE spread.order_leg SET rest_status = 'CANCELLED',
                  note = concat_ws(' · ', note, $2::text) WHERE id = $1;`,
          [legId, `rest of ${rest.toLocaleString('en-US')} cancelled`]);
        await client.query('COMMIT');
        invalidate();
        out = { ok: true, rest: { of: rest, filled: 0, cancelled: rest }, note: `The rest (${rest.toLocaleString('en-US')}) is cancelled; the fill of ${Number(leg.filled_shares).toLocaleString('en-US')} stands.` };
      } else {
        const f = filledShares == null ? rest : Number(filledShares);
        if (!(f > 0) || f > rest || !Number.isInteger(f)) {
          throw badRequest(`filledShares must be a whole number between 1 and the resting ${rest}`);
        }
        if (leg.side === 'SELL') {
          const buy = await positions.openBuy(leg.symbol, client);
          if (!buy) throw refused(`no open position in ${leg.symbol} for this sell to close`);
          // V-02 · against ITS contract, not whichever is open now: a rest left
          // from a closed contract booked against a later one puts sold > bought.
          if (Number(buy.contract_seq) !== Number(leg.contract_seq)) {
            throw refused(`this rest belongs to contract ${leg.contract_seq}, which is closed; the open contract is ${buy.contract_seq}`,
              'cancel this rest (status CANCELLED) — it cannot sell shares its own contract no longer holds');
          }
          if (f > buy.remaining_shares) {
            throw refused(`${f.toLocaleString('en-US')} exceeds the ${buy.remaining_shares.toLocaleString('en-US')} held in ${leg.symbol}`,
              'resolve with filledShares no larger than the position');
          }
        }
        const premier = await positions.isPremier(leg.symbol, client);
        const notionalKd = (Number(leg.price_fils) * f) / 1000;
        // Its own execution(s): the settlement fee and the per-side minimum
        // apply to this piece on its own — "two fills cost two commissions".
        const fee = COMMISSION.sideFeeKd(notionalKd, { day: d, premier, executions: executions ?? null });
        const whole = f === rest;
        await client.query(
          `UPDATE spread.order_leg
              SET filled_shares = filled_shares + $2,
                  commission_kd = COALESCE(commission_kd, 0) + $3,
                  executions    = COALESCE(executions, 1) + COALESCE($4, 1),
                  rest_status   = $5,
                  note = concat_ws(' · ', note, $6::text)
            WHERE id = $1;`,
          [legId, f, fee.kd, executions, whole ? 'FILLED' : 'POSTED',
           `rest filled ${f.toLocaleString('en-US')} of ${rest.toLocaleString('en-US')} (second execution)`]);
        await bookFill(client, { day: d, leg, side: leg.side, shares: f, priceFils: leg.price_fils, feeKd: fee.kd, symbol: leg.symbol });
        await client.query('COMMIT');
        invalidate();
        out = { ok: true, commissionKnown: fee.known,
          rest: { of: rest, filled: f, resting: rest - f },
          note: `The rest filled: ${f.toLocaleString('en-US')} more at ${leg.price_fils}, ${fee.kd.toFixed(3)} KD commission on this execution.${whole ? '' : ` ${(rest - f).toLocaleString('en-US')} still resting.`}` };
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    res.json({ ...out, contracts: await contracts(d) });
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

    const venue = await closeVenue(d, sym);
    const premier = await positions.isPremier(sym);

    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${sym}`]);
      const buy = await positions.openBuy(sym, client);
      if (!buy) throw notFound(`no open position in ${sym}`);

      // F1 · a resting sell is a POSTED leg OR the queued rest of a partial one.
      const [resting] = await positions.restingLegs(sym, client, { side: 'SELL', contractSeq: Number(buy.contract_seq) });
      if (resting) {
        throw refused(`a sell of ${resting.resting_shares.toLocaleString('en-US')} at ${resting.price_fils} is already resting in ${sym}`,
          resting.status === 'POSTED'
            ? `cancel leg ${resting.id} first (POST /trading/resolve {legId, status: "CANCELLED"}), then hit the bid`
            : `cancel the rest of leg ${resting.id} first (POST /trading/resolve-rest {legId, status: "CANCELLED"}), then hit the bid`);
      }
      await assertNoBuyRest(sym, client, buy);

      const px = venue.priceFils;
      const entry = Number(buy.price_fils);
      const shares = buy.remaining_shares;
      const notionalKd = (px * shares) / 1000;
      const fee = COMMISSION.sideFeeKd(notionalKd, { day: d, premier, executions: executions ?? null });
      const roundTrip = Number(buy.commission_kd || 0) + fee.kd;
      const costKd = Number((((px - entry) * shares) / 1000 - roundTrip).toFixed(3));

      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, executions, posted_at, resolved_at, exit_venue, note)
         VALUES ($1,$2,$3,'SELL','FILLED',$4,$5,$5,$6,$7,now(),now(),$8,$9)
         RETURNING id;`,
        [d, sym, buy.contract_seq, px, shares, fee.kd, executions ?? null, venue.exitVenue,
         venue.tal ? 'closed in Trading at Last at the auction price' : 'hit the bid — last rung of the exit ladder']);
      await bookFill(client, { day: d, leg, side: 'SELL', shares, priceFils: px, feeKd: fee.kd, symbol: sym });
      await client.query('COMMIT');

      out = {
        costKd, commissionKnown: fee.known, venue: venue.exitVenue,
        note: `Sold ${shares.toLocaleString('en-US')} at ${px}${venue.tal ? ' (auction price, Trading at Last)' : ''} against an entry of ${entry}. ` +
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

    // The session, the flat-by rule and the price — all decided before the
    // transaction, so a refusal here leaves the resting offer untouched.
    const venue = await closeVenue(d, sym);
    const premier = await positions.isPremier(sym);

    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${sym}`]);
      const buy = await positions.openBuy(sym, client);
      if (!buy) throw notFound(`no open position in ${sym}`);

      // F1 · the bid's rest is the operator's to pull in Awsat too — refuse
      // before anything is cancelled, so a refusal leaves the offer in place.
      await assertNoBuyRest(sym, client, buy);

      // ── the CANCEL half ──────────────────────────────────────────────────
      // F1 · a POSTED sell is cancelled whole; the queued rest of a partial
      // sell is cancelled by rest_status — its fill stands.
      const [resting] = await positions.restingLegs(sym, client, { side: 'SELL', contractSeq: Number(buy.contract_seq) });
      let cancelled = null;
      if (resting) {
        if (resting.status === 'POSTED') {
          await client.query("UPDATE spread.order_leg SET status = 'CANCELLED', resolved_at = now() WHERE id = $1;", [resting.id]);
        } else {
          await client.query(
            `UPDATE spread.order_leg SET rest_status = 'CANCELLED',
                    note = concat_ws(' · ', note, $2::text) WHERE id = $1;`,
            [resting.id, `rest of ${resting.resting_shares.toLocaleString('en-US')} cancelled to hit the bid`]);
        }
        cancelled = { legId: resting.id, priceFils: Number(resting.price_fils), shares: resting.resting_shares, rest: resting.status !== 'POSTED' };
      }

      // ── the HIT half ─────────────────────────────────────────────────────
      const px = venue.priceFils;
      const entry = Number(buy.price_fils);
      const shares = buy.remaining_shares;
      const notionalKd = (px * shares) / 1000;
      const fee = COMMISSION.sideFeeKd(notionalKd, { day: d, premier, executions: executions ?? null });
      const roundTrip = Number(buy.commission_kd || 0) + fee.kd;
      const costKd = Number((((px - entry) * shares) / 1000 - roundTrip).toFixed(3));

      const { rows: [leg] } = await client.query(
        `INSERT INTO spread.order_leg
           (trading_day, symbol, contract_seq, side, status, price_fils, shares,
            filled_shares, commission_kd, executions, posted_at, resolved_at, exit_venue, note)
         VALUES ($1,$2,$3,'SELL','FILLED',$4,$5,$5,$6,$7,now(),now(),$8,$9)
         RETURNING id;`,
        [d, sym, buy.contract_seq, px, shares, fee.kd, executions ?? null, venue.exitVenue,
         cancelled ? `cancelled the resting ${cancelled.priceFils} offer and ${venue.tal ? 'closed in Trading at Last' : 'hit the bid'}`
           : venue.tal ? 'closed in Trading at Last at the auction price' : 'hit the bid — last rung of the exit ladder']);
      await bookFill(client, { day: d, leg, side: 'SELL', shares, priceFils: px, feeKd: fee.kd, symbol: sym });
      await client.query('COMMIT');

      out = {
        cancelled, costKd, commissionKnown: fee.known, venue: venue.exitVenue,
        note: `${cancelled ? `Cancelled the ${cancelled.priceFils} offer and s` : 'S'}old ${shares.toLocaleString('en-US')} at ${px}${venue.tal ? ' (auction price)' : ''} against an entry of ${entry}. `
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
      // Lock ORDER: symbol lock, then the row (see resolve-rest).
      const { rows: [peek] } = await client.query('SELECT symbol FROM spread.order_leg WHERE id = $1;', [legId]);
      if (!peek) throw notFound(`no leg ${legId}`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [`spread.order_leg:${peek.symbol}`]);
      const { rows: [leg] } = await client.query(
        'SELECT * FROM spread.order_leg WHERE id = $1 FOR UPDATE;', [legId]);
      if (!leg) throw notFound(`no leg ${legId}`);
      if (leg.status !== 'POSTED') {
        throw refused(`leg ${legId} is ${leg.status}, not POSTED`,
          'only a resting order can be resolved — a filled leg is already settled, and moving it ' +
          'would put the cash ledger out of step with the position');
      }

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
          if (Number(buy.contract_seq) !== Number(leg.contract_seq)) {
            throw refused(`this offer belongs to contract ${leg.contract_seq}, which is closed; the open contract is ${buy.contract_seq}`,
              'cancel it (status CANCELLED) — it cannot sell shares its own contract no longer holds');
          }
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

      // F1 · a partial fill leaves its rest RESTING on this leg (rest_status
      // POSTED) — PART FILLED — until /trading/resolve-rest says it filled or
      // was pulled. A whole fill has no rest.
      const partial = status === 'FILLED' && shares < Number(leg.shares);
      await client.query(
        `UPDATE spread.order_leg
            SET status=$2, resolved_at=now(),
                filled_shares = CASE WHEN $2='FILLED' THEN $3 ELSE filled_shares END,
                commission_kd = CASE WHEN $2='FILLED' THEN $4 ELSE commission_kd END,
                executions    = CASE WHEN $2='FILLED' THEN $5 ELSE executions END,
                rest_status   = CASE WHEN $6 THEN 'POSTED' ELSE rest_status END,
                -- 3.8 · a resting sell that filled is a LIMIT exit.
                exit_venue    = CASE WHEN $2='FILLED' AND side='SELL' THEN 'LIMIT' ELSE exit_venue END
          WHERE id=$1;`, [legId, status, shares, fee.kd, executions ?? null, partial]);

      let ruleBreach = null, stop = null;
      if (status === 'FILLED') {
        await bookFill(client, { day: d, leg, side: leg.side, shares,
          priceFils: leg.price_fils, feeKd: fee.kd, symbol: leg.symbol });
        if (leg.side === 'BUY') {
          ruleBreach = await breachIfStopped(client, d, leg.symbol, { legId: leg.id, priceFils: Number(leg.price_fils), shares });
          // F2 · the stop is fixed at the fill.
          stop = await stopAtFill(client, { legId: leg.id, symbol: leg.symbol, day: d, entryFils: Number(leg.price_fils) });
        }
      }
      await client.query('COMMIT');
      invalidate();
      res.json({ ok: true, ruleBreach, stop,
        partial: partial ? { filled: shares, of: Number(leg.shares), resting: Number(leg.shares) - shares } : null,
        commissionKnown: fee.known,
        warning: ruleBreach ? `STOP BREACHED: ${ruleBreach.reasons.join(' · ')}` : null,
        note: partial ? `${shares.toLocaleString('en-US')} of ${Number(leg.shares).toLocaleString('en-US')} filled; the rest (${(Number(leg.shares) - shares).toLocaleString('en-US')}) is still resting — REST FILLED or CANCEL THE REST when Awsat says. Two fills cost two commissions.` : null,
        contracts: await contracts(d) });
      return;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }));
}

module.exports = { mount, bookFill, assertPositionRoom, assertCanOpen };
