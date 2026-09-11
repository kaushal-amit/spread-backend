'use strict';
/**
 * ============================================================================
 *  services/snapshot.js — the terminal's state, in one message
 * ============================================================================
 * The socket plan (10 Sep). The SPA used to poll ~30 GETs a minute per tab
 * (/account 15 s, /budget 15 s, /trading/contracts 10 s, /session 30 s,
 * /market 60 s, /feeds 60 s, the detail 10 s, BooksView's own 30 s loop) on
 * top of a whole-board push every 15 s. The client ASKED for state the server
 * already had, and every ask was a database query.
 *
 * Now the server builds ONE snapshot — board, account, budget, session,
 * market, contracts, feeds, slots — and pushes it to the day room once a
 * minute (`spread:snapshot`), immediately after a write (a PARTIAL carrying
 * the sections the write touched), once more after the close (`final`), and
 * serves the same object over GET /api/bootstrap for the first paint.
 *
 * THE SAME BUILDERS THE REST ROUTES USE. board() / sessionView() /
 * marketView() / accountView() / budgetView() / contracts() / roster() are
 * the route bodies; a field present over one path and absent over the other
 * is a silent `undefined`, never an error — which is why nothing is shaped
 * here. PARTS names the sections; a write announces which it touched
 * (lib/events.js).
 *
 * Every section is built independently and FAILS INDEPENDENTLY: a section
 * that throws is { error: { code, error } } in the snapshot, the others
 * arrive, and the client renders that section as broken — never a quiet
 * empty board because the market strip's query timed out.
 *
 * `seq` is a monotonic counter per process. The heartbeat carries the same
 * number, so a client that sees the heartbeat's seq run ahead of its last
 * snapshot knows it MISSED one and re-bootstraps.
 * ============================================================================
 */
const log = require('../lib/log');

const PARTS = ['board', 'account', 'budget', 'session', 'market', 'contracts', 'feeds', 'slots'];

let seq = 0;
const nextSeq = () => ++seq;
const currentSeq = () => seq;

async function part(name, fn) {
  try { return await fn(); }
  catch (e) {
    log.warn(`[snapshot] ${name} failed:`, e.message);
    return { error: { code: e.code || 'PART_FAILED', error: e.message } };
  }
}

/** The board section — what the ticker's spread:update carried (socket.view()). */
async function boardPart(day, budgetKd) {
  return require('../socket').view(day, budgetKd);
}

const builders = {
  board: (day, budgetKd) => boardPart(day, budgetKd),
  account: (day) => require('../api/routes').accountView(day),
  budget: () => require('../api/sizing').budgetView(),
  session: () => require('../api/routes').sessionView(),
  market: (day) => require('../api/routes').marketView(day),
  contracts: (day) => require('../api/routes').contracts(day),
  feeds: () => require('./feedHealth').roster(),
  slots: async () => {
    const sc = require('./scraperClient');
    if (!sc.configured) return { error: { code: 'NOT_READY', error: 'the scraper is not configured on this backend (SCRAPER_INGEST_URL)' } };
    const list = await sc.depthSymbols();
    if (!list) return { error: { code: 'NOT_READY', error: 'the scraper did not answer /depth-symbols' } };
    return list;
  },
};

/**
 * @param {string}   day
 * @param {number}   budgetKd    null → the board section reports NOT_READY (view() does)
 * @param {object}   opts.parts  which sections; default all
 * @param {boolean}  opts.final  the post-close snapshot
 * @param {string}   opts.reason free text for the log / the client's feed
 */
async function snapshot(day, budgetKd, { parts = PARTS, final = false, reason = null } = {}) {
  const wanted = PARTS.filter((p) => parts.includes(p));
  const built = await Promise.all(wanted.map((name) => part(name, () => builders[name](day, budgetKd))));
  const out = {
    seq: nextSeq(), at: new Date().toISOString(), tradingDay: day, budgetKd,
    partial: wanted.length !== PARTS.length, parts: wanted, final: !!final, reason,
  };
  wanted.forEach((name, i) => { out[name] = built[i]; });
  return out;
}

module.exports = { snapshot, PARTS, currentSeq, nextSeq, builders, part };
