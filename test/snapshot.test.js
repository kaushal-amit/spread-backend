/**
 * The socket plan · one snapshot a minute, partials on write, the focused
 * symbol on change, BOOKS on change, one final snapshot then idle, and a
 * heartbeat that dies with the ticker.
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('snapshot');
process.env.SPREAD_TEST_NOW = process.env.SPREAD_TEST_NOW || '2001-01-08T08:00:00Z'; // stops.js reads it: 11:00 Kuwait
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const gateStore = require('../src/services/gateStore');
const events = require('../src/lib/events');
let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DAY = fx.TEST_DAY;                 // 2001-01-08, a Monday
const SYM = 'SZTESTSNAP';

/** A fake io: rooms with members, an emitted log, and per-socket emits. */
function fakeIo(day) {
  const emitted = [];
  const sockets = new Map();
  const io = {
    emitted,
    sockets: { sockets, adapter: { rooms: new Map([[`day:${day}`, new Set(['s1'])]]) } },
    to: (r) => ({ emit: (ev, arg) => emitted.push({ room: r, ev, arg }) }),
  };
  return io;
}
const fakeSocket = (id, focus = null) => {
  const s = { id, data: { focus, focusSig: null, day: DAY }, emitted: [], emit: (ev, arg) => s.emitted.push({ ev, arg }) };
  return s;
};

(async () => {
  const socket = require('../src/socket');
  const snapshotSvc = require('../src/services/snapshot');
  try {
    await gateStore.load();
    if (gateStore.sessionBudgetKd() == null) await gateStore.save({ 'session-budget': 790 }, { changedBy: 'snapshot.test' });
    await fx.clearQuotes(SYM); await fx.clearDepth(SYM); await fx.clearSymbolDay(SYM); await fx.instrument(SYM);
    await fx.symbolDay(SYM, DAY, { close: 200 });
    await fx.quote(SYM, { day: DAY, at: `${DAY}T06:00:00Z`, last: 200, bid: 199, offer: 201 });

    console.log('\n=== the snapshot is the union of the REST bodies, built by the same functions ===');
    const snap = await snapshotSvc.snapshot(DAY, 790, { reason: 'test' });
    chk('all eight sections present', snapshotSvc.PARTS.every((k) => k in snap), Object.keys(snap));
    chk('seq and at', Number.isInteger(snap.seq) && snap.seq > 0 && typeof snap.at === 'string', { seq: snap.seq });
    chk('not partial, not final', snap.partial === false && snap.final === false && snap.parts.length === 8);
    const routes = require('../src/api/routes');
    const [sess, mkt, acct, bud, con] = await Promise.all([routes.sessionView(), routes.marketView(DAY), routes.accountView(DAY), require('../src/api/sizing').budgetView(), routes.contracts(DAY)]);
    const keys = (o) => Object.keys(o || {}).sort().join(',');
    chk('session section = GET /session (same keys)', keys(snap.session) === keys(sess), { a: keys(snap.session), b: keys(sess) });
    chk('market section = GET /market', keys(snap.market) === keys(mkt));
    chk('account section = GET /account', keys(snap.account) === keys(acct));
    chk('budget section = GET /budget', keys(snap.budget) === keys(bud));
    chk('contracts section = GET /trading/contracts', Array.isArray(snap.contracts) && snap.contracts.length === con.length);
    chk('board section carries the CR-8 buckets and stops', snap.board && Array.isArray(snap.board.take) && 'stops' in snap.board, snap.board && Object.keys(snap.board));
    chk('slots section says NOT_READY when the scraper is not configured — an error, never a silent []',
        snap.slots && snap.slots.error && snap.slots.error.code === 'NOT_READY', snap.slots);
    const part = await snapshotSvc.snapshot(DAY, 790, { parts: ['account', 'budget'], reason: 'trade' });
    chk('a partial carries only its parts, marked', part.partial === true && part.parts.join() === 'account,budget' && !('board' in part) && 'account' in part);
    chk('seq is monotonic', part.seq === snap.seq + 1);
    const broken = await snapshotSvc.snapshot(DAY, null, { parts: ['board'] });
    chk('a section that cannot be built is an ERROR in the snapshot, not a quiet empty board', broken.board && broken.board.error && broken.board.error.code === 'NOT_READY', broken.board && broken.board.error);

    console.log('\n=== partials on write · debounced, the union of the parts ===');
    {
      const io = fakeIo(require('../src/jobs/daily').kuwaitDay());
      const pusher = socket.startPartialPusher(io, { debounceMs: 60 });
      events.changed(['account'], 'trade');
      events.changed(['contracts'], 'trade');
      await sleep(30);
      chk('nothing pushed inside the debounce', io.emitted.length === 0);
      await sleep(600);
      const snaps = io.emitted.filter((e) => e.ev === 'spread:snapshot');
      chk('ONE partial after the debounce, with the union of the parts', snaps.length === 1 && snaps[0].arg.partial && snaps[0].arg.parts.sort().join() === 'account,contracts', snaps.map((s) => s.arg.parts));
      chk('  and its reason names the writes', /trade/.test(snaps[0].arg.reason));
      io.emitted.length = 0;
      events.changed([], 'halt');
      await sleep(700);
      const full = io.emitted.filter((e) => e.ev === 'spread:snapshot');
      chk('no parts → everything (a halt re-snapshots the whole state)', full.length === 1 && full[0].arg.partial === false, full[0] && full[0].arg.parts);
      chk('  and the legacy spread:update alias rides with a board', io.emitted.some((e) => e.ev === 'spread:update'));
      pusher.stop();
    }

    console.log('\n=== the ticker · heartbeat every run; a snapshot a minute; one final; then idle ===');
    {
      const io = fakeIo(DAY);
      const clock = { now: new Date(`${DAY}T07:00:00Z`) };                     // 10:00 Kuwait, a Monday
      socket.tickerState.lastSnapshotAt = 0; socket.tickerState.finalDoneFor = null;
      const t = socket.startTicker(io, 3600000, { now: () => clock.now, day: () => DAY });
      clearInterval(t);
      await t.run();
      const evs = () => io.emitted.map((e) => e.ev);
      chk('10:00 · a heartbeat AND a snapshot', evs().includes('spread:tick') && evs().includes('spread:snapshot'), evs());
      const hb = io.emitted.find((e) => e.ev === 'spread:tick').arg;
      chk('  the heartbeat says active, with the phase', hb.active === true && hb.phase === 'peak', hb);
      io.emitted.length = 0;
      clock.now = new Date(`${DAY}T07:00:20Z`);
      await t.run();
      chk('20 s later · heartbeat only (a snapshot a minute)', evs().join() === 'spread:tick', evs());
      const hb2 = io.emitted[0].arg;
      chk('  the heartbeat carries the last snapshot\'s seq', hb2.seq === socket.tickerState.lastSnapshotSeq, { hb: hb2.seq, last: socket.tickerState.lastSnapshotSeq });
      io.emitted.length = 0;
      clock.now = new Date(`${DAY}T07:01:05Z`);
      await t.run();
      chk('65 s later · the next snapshot', evs().includes('spread:snapshot'), evs());
      io.emitted.length = 0;
      clock.now = new Date(`${DAY}T10:31:00Z`);                                // 13:31 Kuwait
      await t.run();
      const fin = io.emitted.filter((e) => e.ev === 'spread:snapshot');
      chk('13:31 · ONE final snapshot, marked', fin.length === 1 && fin[0].arg.final === true && fin[0].arg.reason === 'final', fin.map((f) => f.arg.final));
      io.emitted.length = 0;
      clock.now = new Date(`${DAY}T11:00:00Z`);                                // 14:00 Kuwait
      await t.run();
      chk('after the final · heartbeat only, marked final, no snapshot', evs().join() === 'spread:tick' && io.emitted[0].arg.final === true && io.emitted[0].arg.active === false, evs());
      io.emitted.length = 0;
      clock.now = new Date(`${DAY}T05:00:00Z`);                                // 08:00 Kuwait (pre-open)
      socket.tickerState.finalDoneFor = null;
      await t.run();
      chk('08:00 · pre-open: heartbeat only, not active', evs().join() === 'spread:tick' && io.emitted[0].arg.active === false, evs());
      const w = socket.tickerWindow(new Date('2001-01-12T07:00:00Z'));           // a Friday
      chk('a Friday is the weekend: never active', w.weekend === true);
    }

    console.log('\n=== the focused symbol · pushed on CHANGE, every 2 s otherwise nothing ===');
    {
      const io = fakeIo(DAY);
      const s1 = fakeSocket('s1', SYM);
      io.sockets.sockets.set('s1', s1);
      const t2 = socket.startFocusLoop(io, { everyMs: 40, day: () => DAY });
      await sleep(200);
      const first = s1.emitted.filter((e) => e.ev === 'spread:focus');
      chk('the first tick pushes the focus payload once', first.length === 1, first.length);
      const pay = first[0] && first[0].arg;
      chk('  it carries the symbol, the quote, the book and the contract slot', pay && pay.symbol === SYM && pay.quote && 'book' in pay && 'contract' in pay, pay && Object.keys(pay));
      await sleep(200);
      chk('no change → no further push', s1.emitted.filter((e) => e.ev === 'spread:focus').length === 1, s1.emitted.length);
      await fx.quote(SYM, { day: DAY, at: `${DAY}T06:05:00Z`, last: 201, bid: 200, offer: 202 });
      await sleep(250);
      const after = s1.emitted.filter((e) => e.ev === 'spread:focus');
      chk('a new quote → one more push, with the new bid', after.length === 2 && after[1].arg.quote.bid === 200, after.map((e) => e.arg.quote && e.arg.quote.bid));
      clearInterval(t2);
    }

    console.log('\n=== BOOKS on change · the row poller pushes a watched book when captured_at advances ===');
    {
      const io = fakeIo(require('../src/jobs/daily').kuwaitDay());
      const today = require('../src/jobs/daily').kuwaitDay();
      socket.watchedBySocket.set('s1', new Set([SYM]));
      await fx.clearDepth(SYM);
      const t3 = socket.startRowPoller(io, { everyMs: 40 });
      await sleep(250);
      const books = () => io.emitted.filter((e) => e.ev === 'spread:book' && e.arg.symbol === SYM);
      const n0 = books().length;
      chk('an empty book is pushed once (the tile learns there is nothing), not every tick', n0 === 1, n0);
      await fx.depthAt(SYM, `${today}T06:10:00Z`, [[1, 199, 1000]]);
      await sleep(250);
      chk('a capture → one push with the ladder', books().length === 2 && books()[1].arg.book.b.length === 1, books().length);
      await sleep(250);
      chk('no new capture → no push', books().length === 2, books().length);
      clearInterval(t3);
      socket.watchedBySocket.delete('s1');
    }

    console.log('\n=== /health · a silent ticker in-session is DEAD ===');
    {
      // the ticker last succeeded moments ago (the runs above); 2 minutes from
      // now it is silent beyond 3 × the heartbeat — reported with its name.
      const dead = socket.deadLoops({ now: new Date(Date.now() + 120000), force: true });
      chk('a ticker silent beyond 3× the heartbeat is reported, with its name and the limit', dead.some((d) => d.name === 'tick' && d.silentSec >= 120 && d.limitSec === 30), dead);
      chk('  a live one is not', socket.deadLoops({ now: new Date(), force: true }).some((d) => d.name === 'tick') === false);
      chk('outside the window (a Friday) nothing is dead by design', socket.deadLoops({ now: new Date('2001-01-12T07:00:00Z') }).length === 0);
    }
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 4).join(' | '));
  }
  await fx.clearQuotes(SYM).catch(() => {}); await fx.clearDepth(SYM).catch(() => {}); await fx.clearSymbolDay(SYM).catch(() => {}); await fx.clearInstruments(SYM).catch(() => {});
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
