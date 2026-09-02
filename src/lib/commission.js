'use strict';
/**
 * ============================================================================
 *  commission.js — THE ONLY MODULE THAT COMPUTES A FEE
 * ============================================================================
 * No other file computes a fee. `npm run lint:rules` fails the build if one
 * appears — A2 happened because a second implementation appeared LATER, not
 * because two were written at the same time.
 *
 * THE SETTLEMENT FEE IS CHARGED PER EXECUTION, NOT PER ORDER.
 *
 * Proven exactly. Order 26081128291, a 6,100 sell at 129 that filled as
 * 5,350 + 750:
 *
 *   per order                    1.6804    out by 0.605
 *   per execution, no minimum    2.1803    out by 0.105
 *   one rate, two settlements    2.1803    out by 0.105
 *   PER EXECUTION WITH MINIMUM   2.2852    EXACT — charged 2.285
 *
 * The 0.105 is the discriminator: the 96.75 KD piece fell under the 0.250
 * minimum and paid the floor rather than the percentage. Only that explanation
 * reproduces the figure, and no plausible rate explains it as a single order.
 * ============================================================================
 */

const { COMMISSION } = require('../config/spread.config');

const round3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);

/** One execution. The minimum and the settlement both apply per execution. */
function executionFeeKd(notionalKd, { premier = false, day = null, cfg = COMMISSION } = {}) {
  const rate = premier ? cfg.ratePremier : cfg.rateMain;
  const settlement = day && day >= cfg.settlementAbolishedFrom ? 0 : cfg.settlementPerExecution;
  return Math.max(cfg.minPerSide, rate * Number(notionalKd)) + settlement;
}

/**
 * One side of a trade.
 *
 * @param {number[]|null} executionSizes  notional KD per execution, when known
 * @returns {{kd, known, executions, note}}
 *
 * `known` is FALSE when the execution count is unknown. The caller must treat
 * the figure as a BEST CASE — assuming one execution silently reproduces the
 * bug this module exists to fix.
 */
function sideFeeKd(notionalKd, opts = {}) {
  const { executionSizes = null, executions = null } = opts;

  if (Array.isArray(executionSizes) && executionSizes.length) {
    const kd = executionSizes.reduce((a, n) => a + executionFeeKd(n, opts), 0);
    return { kd: round3(kd), known: true, executions: executionSizes.length, note: null };
  }

  if (Number.isFinite(executions) && executions > 1) {
    /*
     * Count known, sizes not. An EVEN SPLIT is the CHEAPEST arrangement —
     * every piece clears the percentage and none pays the minimum. So the true
     * cost is this or higher, never lower, and the estimate cannot flatter.
     */
    const each = Number(notionalKd) / executions;
    const kd = executions * executionFeeKd(each, opts);
    return { kd: round3(kd), known: false, executions,
      note: 'execution sizes unknown — even split assumed, which is the cheapest arrangement' };
  }

  return { kd: round3(executionFeeKd(notionalKd, opts)), known: executions === 1,
    executions: executions ?? null,
    note: executions == null
      ? 'execution count unknown — single execution assumed, this is a BEST CASE' : null };
}

/** Both sides. `known` is false if either side's count is unknown. */
function roundTripKd(entryNotionalKd, exitNotionalKd, opts = {}) {
  const buy = sideFeeKd(entryNotionalKd, opts.buy || opts);
  const sell = sideFeeKd(exitNotionalKd ?? entryNotionalKd, opts.sell || opts);
  return {
    kd: round3(buy.kd + sell.kd),
    known: buy.known && sell.known,
    buy, sell,
  };
}

/**
 * What fragmentation costs, so a card can show best and worst rather than only
 * the optimistic figure.
 *
 * E[executions] ~= 1 + shares / avg_trade_size. Simulated against a
 * right-skewed size distribution over 20,000 trials: predicted 1.83 at a 0.83
 * ratio against 1.91 observed. Posting INSIDE a gap fragments slightly more —
 * queue zero exposes you to the first arriving order, usually small.
 */
function expectedExecutions(shares, avgTradeShares, { insideGap = false } = {}) {
  if (!(shares > 0) || !(avgTradeShares > 0)) return null;
  const base = 1 + shares / avgTradeShares;
  return Number((insideGap ? base * 1.05 : base).toFixed(2));
}

module.exports = { executionFeeKd, sideFeeKd, roundTripKd, expectedExecutions };
