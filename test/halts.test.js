/**
 * FLOW 6.7 · the halt-resume detector (items 1 and 2).
 *
 *   detect   session transitions across all symbols
 *   on HALT  direction fixed from the price five minutes prior; a slot requested
 *   on RESUME the verdict computed and pushed — two minutes is the whole trade
 *
 * The pure functions (sessionClass, transitions, sharesAt, verdict) are tested
 * against constructed data; poll() is tested end-to-end through spread.halt_event
 * over a simulated Trading → CB Auction → Trading sequence, including FUTUREKID
 * (buy 149, the +28.44 KD live trade that confirmed the study).
 */
const { requireTestDb } = require('./dbguard');
requireTestDb('halts');
const { pool } = require('../src/db');
const fx = require('./fixtures').bind(pool);
const halts = require('../src/services/halts');
const { kuwaitDay } = require('../src/jobs/daily');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };
const DAY = kuwaitDay();
const T = halts.DEFAULTS;

(async () => {
  try {
    console.log('\n=== the pure pieces ===');
    chk('CB Auction is a HALT state', halts.sessionClass('CB Auction') === 'HALT');
    chk('Trading is a TRADING state', halts.sessionClass('Trading') === 'TRADING');
    const tr = halts.transitions(
      new Map([['A', 'Trading'], ['B', 'CB Auction']]),
      new Map([['A', 'CB Auction'], ['B', 'Trading'], ['C', 'Trading']]));
    chk('Trading→CB Auction is a HALT, CB Auction→Trading is a RESUME, a new symbol is neither',
      tr.length === 2 && tr.find((x) => x.symbol === 'A').kind === 'HALT' && tr.find((x) => x.symbol === 'B').kind === 'RESUME', tr);
    chk('700 KD at 149 fils buys 4,600 shares (lot-floored)', halts.sharesAt(700, 149) === 4600, halts.sharesAt(700, 149));

    console.log('\n=== the verdict (§9 gates, 1–8) ===');
    const V = (o) => halts.verdict({ budgetKd: 700, ...o }, T).verdict;
    chk('an UP halt is skipped', V({ direction: 'UP', resumePrice: 149, bidQty: 5000, offerQty: 12000 }) === 'UP HALT — SKIP');
    chk('a price above the band is out of band', V({ direction: 'DOWN', resumePrice: 400, bidQty: 5000, offerQty: 12000 }) === 'PRICE OUT OF BAND');
    chk('a price below the band is out of band', V({ direction: 'DOWN', resumePrice: 90, bidQty: 5000, offerQty: 12000 }) === 'PRICE OUT OF BAND');
    chk('a touch bid at/over 50k is BOOK TOO DEEP', V({ direction: 'DOWN', resumePrice: 149, bidQty: 60000, offerQty: 120000 }) === 'BOOK TOO DEEP');
    chk('a skip-list symbol WARNs', V({ direction: 'DOWN', resumePrice: 149, bidQty: 10000, offerQty: 12000, skipReason: '2 halts, none paid' }) === 'WARN');

    console.log('\n=== gate 5 · a second halt today is a CASCADE ===');
    chk('the first halt is not a cascade', V({ direction: 'DOWN', resumePrice: 149, bidQty: 10000, offerQty: 20000, haltCountToday: 0 }) !== 'SECOND HALT — CASCADE');
    chk('a second halt today → SECOND HALT — CASCADE',
      V({ direction: 'DOWN', resumePrice: 149, bidQty: 10000, offerQty: 20000, haltCountToday: 1 }) === 'SECOND HALT — CASCADE');

    console.log('\n=== gate 7 · offer over 3x the bid → SELLERS STILL QUEUED ===');
    chk('offer 4× the bid → SELLERS STILL QUEUED',
      V({ direction: 'DOWN', resumePrice: 149, bidQty: 10000, offerQty: 40000 }) === 'SELLERS STILL QUEUED');
    chk('offer 2.5× the bid passes the ratio gate (not SELLERS)',
      V({ direction: 'DOWN', resumePrice: 149, bidQty: 10000, offerQty: 25000 }) !== 'SELLERS STILL QUEUED');

    console.log('\n=== sizing through pricing.js · halve once, else BOOK TOO DEEP ===');
    // 700 KD at 149 = 4,600 shares. your_pct = 4,600 / bid.
    const halvedOk = halts.verdict({ direction: 'DOWN', resumePrice: 149, bidQty: 10222, offerQty: 10000, budgetKd: 700 }, T);
    chk('your_pct 45 → halved to ~22 → passes (2,300 shares)',
      halvedOk.verdict === 'TRADEABLE' && halvedOk.halved === true && halvedOk.yourShares === 2300 && halvedOk.yourPctBid <= 30,
      { v: halvedOk.verdict, pct: halvedOk.yourPctBid, shares: halvedOk.yourShares, halved: halvedOk.halved });
    const halvedFail = halts.verdict({ direction: 'DOWN', resumePrice: 149, bidQty: 5750, offerQty: 10000, budgetKd: 700 }, T);
    chk('your_pct 80 → halved to ~40 → still over → BOOK TOO DEEP',
      halvedFail.verdict === 'BOOK TOO DEEP' && halvedFail.halved === true && halvedFail.yourPctBid > 30,
      { v: halvedFail.verdict, pct: halvedFail.yourPctBid });

    console.log('\n=== G-4 · a halt with no budget still alerts (NO BUDGET SET) ===');
    // The same book that is TRADEABLE at 700 KD (bid 10,222, offer 10,000).
    const nb = halts.verdict({ direction: 'DOWN', resumePrice: 149, bidQty: 10222, offerQty: 10000, budgetKd: null }, T);
    chk('no budget → verdict NO BUDGET SET (not TRADEABLE, not a skip)', nb.verdict === 'NO BUDGET SET', nb);
    chk('  shares / yourPct / exitMultiple are null, never a fallback number',
      nb.yourShares === null && nb.yourPctBid === null && nb.exitMultiple === null, nb);
    chk('  and it is not marked tradeable', nb.tradeable === false, nb.tradeable);
    const nbPayload = halts.payload({ id: 1, symbol: 'X', at: new Date(), vd: nb, bidQty: 10222, offerQty: 10000, bandRefFils: 140, history: { halts: 0, gave5: 0, avgGain: null } });
    chk('  the alert payload carries the nulls and the verdict', nbPayload.verdict === 'NO BUDGET SET' && nbPayload.yourShares === null, nbPayload);
    // gates 1–7 still take precedence: an UP halt with no budget is still SKIP.
    chk('gates 1–7 still fire first (UP halt is SKIP even with no budget)',
      halts.verdict({ direction: 'UP', resumePrice: 149, bidQty: 10000, offerQty: 12000, budgetKd: null }, T).verdict === 'UP HALT — SKIP');

    console.log('\n=== the band reference · ceil(prev_close × 0.95) ===');
    chk('ceil(156 × 0.95) = 149 — a reference, never a floor', halts.haltBandFloor(156) === 149, halts.haltBandFloor(156));

    console.log('\n=== the 7 Sept FUTUREKID row · resume 142 → EXIT BLOCKED ===');
    // budget 2,000 at 142 = 14,000 shares; bid 48,000 (you 29%, not deep, no
    // halve), offer 100,000 (2.1× the bid, passes SELLERS) is 7.1× your shares.
    const fk = halts.verdict({ direction: 'DOWN', resumePrice: 142, bidQty: 48000, offerQty: 100000, budgetKd: 2000 }, T);
    chk('verdict EXIT BLOCKED', fk.verdict === 'EXIT BLOCKED', fk);
    chk('  target 147, stop 137 (resume ±5)', fk.targetFils === 147 && fk.stopFils === 137, [fk.targetFils, fk.stopFils]);
    const fkPayload = halts.payload({ id: 1, symbol: 'FUTUREKID', at: new Date(), vd: fk, bidQty: 48000, offerQty: 100000, bandRefFils: 149, history: { halts: 1, gave5: 0, avgGain: 2.0 } });
    chk('  the §5 payload carries every field',
      fkPayload.resumePriceFils === 142 && fkPayload.touchBidQty === 48000 && fkPayload.touchOfferQty === 100000
      && fkPayload.direction === 'DOWN' && fkPayload.verdict === 'EXIT BLOCKED' && fkPayload.targetFils === 147
      && fkPayload.bandRefFils === 149 && fkPayload.symbolHistory && fkPayload.symbolHistory.halts === 1,
      fkPayload);

    console.log('\n=== poll() end-to-end: Trading → CB Auction → Trading ===');
    const SYM = 'SZTESTHALT';
    await fx.clearQuotesRaw(SYM); await fx.instrument(SYM);
    const now = Date.now();
    const at = (mAgo) => new Date(now - mAgo * 60000);
    // A prior print at 155 (the >5-minutes-before price), then the halt at 149,
    // then the resume at 149 with FUTUREKID's book.
    await fx.marketQuote(SYM, at(10), { session: 'Trading', lastPrice: 155, bid: 154, bidQty: 8000, offer: 156, offerQty: 9000, trades: 40, day: DAY });
    const sessions = new Map();
    const seed = await halts.poll(DAY, { budgetKd: 700, seed: true }, sessions);
    chk('the first poll seeds without firing', seed.seeded && seed.halts.length === 0, seed);

    await fx.marketQuote(SYM, at(1), { session: 'CB Auction', lastPrice: 149, bid: 148, bidQty: 16000, offer: 150, offerQty: 60000, trades: 44, day: DAY });
    const haltPoll = await halts.poll(DAY, { budgetKd: 700 }, sessions);
    chk('the halt is detected, direction DOWN (149 < 155 five minutes prior)',
      haltPoll.halts.length === 1 && haltPoll.halts[0].direction === 'DOWN' && haltPoll.halts[0].px5minPrior === 155, haltPoll.halts);

    await fx.marketQuote(SYM, at(0), { session: 'Trading', lastPrice: 149, bid: 148, bidQty: 16000, offer: 150, offerQty: 60000, trades: 44, day: DAY });
    const resumePoll = await halts.poll(DAY, { budgetKd: 700 }, sessions);
    // The book here overhangs (offer 60,000 is 3.75× the bid 16,000): a REJECT.
    // It must still be returned with its reason — a screen ranks, never removes.
    chk('the resume is detected and carries a computed verdict', resumePoll.resumes.length === 1 && resumePoll.resumes[0].verdict === 'SELLERS STILL QUEUED', resumePoll.resumes);
    const res = resumePoll.resumes[0];
    chk('  a rejected resume is still emitted, with its reason (never removed)',
      res.tradeable === false && typeof res.verdictDetail === 'string' && res.verdictDetail.length > 0, res);
    chk('  the alert carries the §5 fields — target, stop, band, history',
      res.targetFils === 154 && res.stopFils === 144 && 'bandRefFils' in res && res.symbolHistory && res.symbolHistory.halts >= 0, res);

    // Every firing is in the transition log, resume paired to its halt.
    const { rows: log } = await pool.query(
      "SELECT kind, direction, verdict, halt_ref FROM spread.halt_event WHERE symbol = $1 AND trading_day = $2 ORDER BY id", [SYM, DAY]);
    chk('both firings recorded in spread.halt_event', log.length === 2 && log[0].kind === 'HALT' && log[1].kind === 'RESUME', log);
    chk('  the resume is paired to its halt', log[1].halt_ref != null, log);
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [SYM]);
    await fx.clearQuotesRaw(SYM); await fx.clearInstruments(SYM);

    console.log('\n=== G-2 · backfill halt_event from the captured history ===');
    const G2 = 'SZTESTG2';
    const g2day = '2001-01-06';
    await pool.query("DELETE FROM spread.halt_event WHERE symbol = $1", [G2]);
    await fx.clearQuotesRaw(G2); await fx.instrument(G2);
    const g2base = new Date(`${g2day}T09:00:00+03:00`).getTime();
    const g2q = (m, session, px) => fx.marketQuote(G2, new Date(g2base + m * 60000), { session, lastPrice: px, bid: px - 1, bidQty: 8000, offer: px + 1, offerQty: 9000, day: g2day });
    // A trading run, a halt, then a resume.
    await g2q(0, 'Trading', 160); await g2q(5, 'Trading', 158); await g2q(10, 'Trading', 155);
    await g2q(12, 'CB Auction', 150); await g2q(13, 'CB Auction', 150);
    await g2q(15, 'Trading', 151); await g2q(16, 'Trading', 152);
    const bf1 = await halts.backfill(g2day, g2day);
    chk('the backfill writes one HALT and one RESUME', bf1.HALT === 1 && bf1.RESUME === 1, bf1);
    const { rows: g2rows } = await pool.query(
      "SELECT kind, source, direction FROM spread.halt_event WHERE symbol = $1 ORDER BY detected_at", [G2]);
    chk('  both are marked source = BACKFILL', g2rows.length === 2 && g2rows.every((r) => r.source === 'BACKFILL'), g2rows);
    chk('  the halt direction is DOWN (150 < 155 five minutes prior)', g2rows[0].direction === 'DOWN', g2rows[0]);
    const bf2 = await halts.backfill(g2day, g2day);
    chk('a second run is idempotent — zero rows added', bf2.HALT === 0 && bf2.RESUME === 0 && bf2.NO_RESUME === 0, bf2);
    await pool.query("DELETE FROM spread.halt_event WHERE symbol = $1", [G2]);
    await fx.clearQuotesRaw(G2); await fx.clearInstruments(G2);

    console.log('\n=== G-3 · one scoring home (symbolHistory from signal_log) ===');
    const G3 = 'SZTESTG3';
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G3]);
    await fx.clearSignals(G3).catch(() => {});
    const g3day = '2001-01-05', g3prev = '2001-01-04';
    const g3fired1 = `${g3prev}T10:00:00+03:00`, g3fired2 = `${g3prev}T11:00:00+03:00`;
    // Two prior RESUMEs: one scored (reached +6 at 15 min), one not yet scored.
    await pool.query(
      `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, resume_price_fils, direction)
       VALUES ($1,$2,'RESUME',$3,150,'DOWN'), ($1,$2,'RESUME',$4,150,'DOWN')`, [g3prev, G3, g3fired1, g3fired2]);
    // The scored signal_log row for the FIRST resume only (px_15min 156 = +6 ≥ 5).
    await fx.haltResumeSignal(G3, g3prev, g3fired1, 150, 156);
    const g3hist = await halts.history(G3, g3day, pool);
    chk('both prior resumes are counted in halts', g3hist.halts === 2, g3hist);
    chk('only the SCORED one that reached +5 is in reached5Fils', g3hist.reached5Fils === 1, g3hist);
    chk('  avgFils reflects the scored move (+6)', g3hist.avgFils === 6, g3hist.avgFils);
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G3]);
    await fx.clearSignals(G3).catch(() => {});

    console.log('\n=== G-6 · session values beyond the two the spec names ===');
    chk('Trading at Last is TRADING', halts.sessionClass('Trading at Last') === 'TRADING');
    chk('a NULL session is ordinary TRADING (spec §2)', halts.sessionClass(null) === 'TRADING');
    chk('Close-Of-Day / Closing / Close Auction Acceptance are CLOSE',
      ['Close-Of-Day', 'Closing', 'Close Auction Acceptance'].every((s) => halts.sessionClass(s) === 'CLOSE'));
    // CB Auction → Trading at Last is a RESUME; → NULL is a RESUME; → Close-Of-Day is NO_RESUME.
    const trFromHalt = (to) => halts.transitions(new Map([['Z', 'CB Auction']]), new Map([['Z', to]]));
    chk('CB Auction → Trading at Last fires a RESUME', trFromHalt('Trading at Last')[0]?.kind === 'RESUME');
    chk('CB Auction → NULL fires a RESUME', trFromHalt(null)[0]?.kind === 'RESUME');
    chk('CB Auction → Close-Of-Day is a NO_RESUME, not a resume', trFromHalt('Close-Of-Day')[0]?.kind === 'NO_RESUME');

    // End-to-end: a halt at 12:52 resuming into "Trading at Last" fires; a halt
    // followed by Close-Of-Day logs NO_RESUME and carries nothing forward.
    const G6 = 'SZTESTG6';
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G6]);
    await fx.clearQuotesRaw(G6); await fx.instrument(G6);
    const g6now = Date.now(); const g6at = (m) => new Date(g6now - m * 60000);
    await fx.marketQuote(G6, g6at(10), { session: 'Trading', lastPrice: 150, bid: 149, bidQty: 8000, offer: 151, offerQty: 9000, day: DAY });
    const g6s = new Map();
    await halts.poll(DAY, { seed: true }, g6s);
    await fx.marketQuote(G6, g6at(2), { session: 'CB Auction', lastPrice: 148, bid: 147, bidQty: 8000, offer: 149, offerQty: 9000, day: DAY });
    await halts.poll(DAY, {}, g6s);
    await fx.marketQuote(G6, g6at(1), { session: 'Trading at Last', lastPrice: 148, bid: 147, bidQty: 8000, offer: 149, offerQty: 9000, day: DAY });
    const g6resume = await halts.poll(DAY, {}, g6s);
    chk('a resume into "Trading at Last" fires a RESUME', g6resume.resumes.some((r) => r.symbol === G6), g6resume.resumes.map((r) => r.symbol));
    // Clear G6's quotes so it does not shadow G6B (latestCapture is global).
    await fx.clearQuotesRaw(G6);

    // A second symbol halts, then the session closes → NO_RESUME. Its own
    // monotonic timeline, each step the global latest.
    const G6B = 'SZTESTG6B';
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G6B]);
    await fx.clearQuotesRaw(G6B); await fx.instrument(G6B);
    const g6bat = (m) => new Date(g6now + m * 60000); // strictly increasing, newest wins
    await fx.marketQuote(G6B, g6bat(1), { session: 'Trading', lastPrice: 150, bid: 149, bidQty: 8000, offer: 151, offerQty: 9000, day: DAY });
    const g6bs = new Map();
    await halts.poll(DAY, { seed: true }, g6bs);
    await fx.marketQuote(G6B, g6bat(2), { session: 'CB Auction', lastPrice: 148, bid: 147, bidQty: 8000, offer: 149, offerQty: 9000, day: DAY });
    await halts.poll(DAY, {}, g6bs);
    await fx.marketQuote(G6B, g6bat(3), { session: 'Close-Of-Day', lastPrice: 148, bid: 147, bidQty: 8000, offer: 149, offerQty: 9000, day: DAY });
    const g6close = await halts.poll(DAY, {}, g6bs);
    chk('a halt then Close-Of-Day logs NO_RESUME, not a resume', g6close.noResumes.some((r) => r.symbol === G6B) && !g6close.resumes.some((r) => r.symbol === G6B), g6close);
    const { rows: g6rows } = await pool.query("SELECT kind FROM spread.halt_event WHERE symbol = $1 ORDER BY id", [G6B]);
    chk('  the halt is closed by a NO_RESUME row', g6rows.map((r) => r.kind).join(',') === 'HALT,NO_RESUME', g6rows);
    for (const s of [G6, G6B]) { await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [s]); await fx.clearQuotesRaw(s); await fx.clearInstruments(s); }

    console.log('\n=== G-1 · the swap is APPLIED (POST to the scraper), and every outcome recorded ===');
    const G1 = 'SZTESTG1';
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G1]);
    await fx.instrument(G1);
    const mkHalt = async () => {
      const { rows: [h] } = await pool.query(
        `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, direction)
         VALUES ($1,$2,'HALT',now(),'DOWN') RETURNING id`, [DAY, G1]);
      return h.id;
    };
    const g1Decision = { swapIn: G1, displace: 2, displaceSymbol: 'DROPA',
      candidates: [{ slot: 2, symbol: 'DROPA' }, { slot: 3, symbol: 'DROPB' }] };
    const rowOf = async (id) => (await pool.query(
      'SELECT slot_applied, replaced_symbol, slot_refused_reason FROM spread.halt_event WHERE id = $1', [id])).rows[0];

    // 200 → slot_applied set
    let id = await mkHalt();
    let out = await halts.applyHaltSlot({ applySlot: async () => ({ ok: true, status: 200, row: { replaced_symbol: 'DROPA' } }) }, g1Decision, G1, id, pool);
    let row = await rowOf(id);
    chk('200 → slot_applied recorded, outcome applied', out.applied === true && out.slot === 2 && Number(row.slot_applied) === 2 && row.replaced_symbol === 'DROPA', { out, row });

    // 409 then 200 → the SECOND slot is applied
    id = await mkHalt();
    let calls = 0;
    out = await halts.applyHaltSlot({ applySlot: async (n) => { calls += 1; return calls === 1 ? ({ ok: false, status: 409, body: { error: 'slot holds a position' } }) : ({ ok: true, status: 200, row: { replaced_symbol: 'DROPB' } }); } }, g1Decision, G1, id, pool);
    row = await rowOf(id);
    chk('409 then 200 → the next slot (3) is applied', out.applied === true && out.slot === 3 && Number(row.slot_applied) === 3, { out, row });

    // two 409s → slot_refused_reason set
    id = await mkHalt();
    out = await halts.applyHaltSlot({ applySlot: async () => ({ ok: false, status: 409, body: { error: 'held' } }) }, g1Decision, G1, id, pool);
    row = await rowOf(id);
    chk('two 409s → refused, reason recorded, nothing applied', out.applied === false && row.slot_applied === null && /SLOT_REFUSED/.test(row.slot_refused_reason), { out, row });

    // unreachable → SCRAPER_UNREACHABLE, and the halt still fires (poll returns it)
    id = await mkHalt();
    out = await halts.applyHaltSlot({ applySlot: async () => ({ ok: false, networkError: true, reason: 'SCRAPER_UNREACHABLE' }) }, g1Decision, G1, id, pool);
    row = await rowOf(id);
    chk('unreachable → SCRAPER_UNREACHABLE recorded', out.reason === 'SCRAPER_UNREACHABLE' && row.slot_refused_reason === 'SCRAPER_UNREACHABLE', { out, row });

    // No path ends with nothing recorded: every id has an applied slot OR a reason.
    const { rows: unrec } = await pool.query(
      'SELECT id FROM spread.halt_event WHERE symbol = $1 AND slot_applied IS NULL AND slot_refused_reason IS NULL', [G1]);
    chk('no HALT row ends with neither a slot nor a reason', unrec.length === 0, unrec);
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G1]);
    await fx.clearInstruments(G1);

    console.log('\n=== G-7 · detector state survives a restart ===');
    const G7 = 'SZTESTG7';
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G7]);
    await fx.clearQuotesRaw(G7); await fx.instrument(G7);
    const t7 = Date.now(); const t7at = (m) => new Date(t7 + m * 60000);
    // A HALT already logged before the "restart" (direction DOWN).
    await pool.query(
      `INSERT INTO spread.halt_event (trading_day, symbol, kind, detected_at, direction, halt_price_fils, px_5min_prior_fils)
       VALUES ($1,$2,'HALT',$3,'DOWN',148,155)`, [DAY, G7, t7at(0)]);
    // Boot: rebuild the session map from the table.
    const s7 = new Map();
    await halts.recoverState(DAY, s7);
    chk('recoverState seeds the open halt as halted', s7.get(G7) === 'CB Auction', [...s7]);
    // Prior print for direction, then the SAME CB Auction capture → no re-fire.
    await fx.marketQuote(G7, t7at(1), { session: 'Trading', lastPrice: 155, bid: 154, bidQty: 8000, offer: 156, offerQty: 9000, day: DAY });
    await fx.marketQuote(G7, t7at(2), { session: 'CB Auction', lastPrice: 148, bid: 147, bidQty: 8000, offer: 149, offerQty: 9000, day: DAY });
    const re1 = await halts.poll(DAY, { budgetKd: 700 }, s7);
    chk('the same CB Auction capture does NOT re-fire the logged halt', !re1.halts.some((h) => h.symbol === G7), re1.halts);
    // It resumes (recovered), then a SECOND halt today → gate 5 CASCADE on resume.
    await fx.marketQuote(G7, t7at(3), { session: 'Trading', lastPrice: 149, bid: 148, bidQty: 16000, offer: 150, offerQty: 20000, day: DAY });
    await halts.poll(DAY, { budgetKd: 700 }, s7); // the first resume
    await fx.marketQuote(G7, t7at(4), { session: 'Trading', lastPrice: 152, bid: 151, bidQty: 16000, offer: 153, offerQty: 20000, day: DAY });
    await halts.poll(DAY, { budgetKd: 700 }, s7); // prior print for the 2nd halt direction
    await fx.marketQuote(G7, t7at(6), { session: 'CB Auction', lastPrice: 149, bid: 148, bidQty: 16000, offer: 150, offerQty: 20000, day: DAY });
    const halt2 = await halts.poll(DAY, { budgetKd: 700 }, s7);
    chk('a second halt DOES fire', halt2.halts.some((h) => h.symbol === G7), halt2.halts);
    await fx.marketQuote(G7, t7at(7), { session: 'Trading', lastPrice: 149, bid: 148, bidQty: 16000, offer: 150, offerQty: 20000, day: DAY });
    const resume2 = await halts.poll(DAY, { budgetKd: 700 }, s7);
    chk('gate 5 fires CASCADE on the second halt\'s resume', resume2.resumes.find((r) => r.symbol === G7)?.verdict === 'SECOND HALT — CASCADE', resume2.resumes);
    await pool.query('DELETE FROM spread.halt_event WHERE symbol = $1', [G7]);
    await fx.clearQuotesRaw(G7); await fx.clearInstruments(G7);

    console.log('\n=== the slot swap is a decision, and protects a held slot ===');
    const HELD = 'SZTESTHSLOTA', DEAD = 'SZTESTHSLOTB', HALTED = 'SZTESTHSLOTC';
    await fx.clearDepthSlots(DAY);
    for (const s of [HELD, DEAD, HALTED]) { await fx.clearQuotesRaw(s); await fx.instrument(s); }
    await fx.depthSlot(HELD, { slotNo: 1, day: DAY });
    await fx.depthSlot(DEAD, { slotNo: 2, day: DAY });
    // HELD holds an open position; DEAD does not and has fewer trades.
    await fx.clearLegs(HELD);
    await pool.query(
      `INSERT INTO spread.order_leg (trading_day, symbol, contract_seq, side, status, price_fils, shares, filled_shares, posted_at)
       VALUES ($1,$2,1,'BUY','FILLED',150,1000,1000,now())`, [DAY, HELD]);
    await fx.marketQuote(HELD, new Date(now), { session: 'Trading', trades: 80, day: DAY });
    await fx.marketQuote(DEAD, new Date(now), { session: 'Trading', trades: 3, day: DAY });
    const decision = await halts.slotSwapDecision(HALTED, DAY, pool);
    chk('the swap displaces DEAD, never the slot holding a position', decision.displace === 2 && decision.displaceSymbol === DEAD, decision);
    await fx.clearLegs(HELD); await pool.query('DELETE FROM spread.claim WHERE symbol = ANY($1)', [[HELD, DEAD, HALTED]]);
    await fx.clearDepthSlots(DAY);
    for (const s of [HELD, DEAD, HALTED]) { await fx.clearQuotesRaw(s); await fx.clearInstruments(s); }
  } catch (e) {
    chk('the suite ran without throwing', false, e.stack?.split('\n').slice(0, 4).join(' | '));
  }
  await pool.end();
  console.log(p === n ? `\nALL PASS  (${n} checks)` : `\nFAILURES: ${n - p}  (${n} checks)`);
  process.exit(p === n ? 0 : 1);
})();
