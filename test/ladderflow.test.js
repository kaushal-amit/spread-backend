/**
 * F8 · services/ladderFlow.js — pure, no database.
 *
 *   the volume BRACKET  {min, max} between two captures: "nothing traded" needs
 *                       max 0, "it traded" needs min ≥ the fall, between = unknown
 *   PLACED     +n whatever traded; the "nothing traded" label only when max 0
 *   PULLED     −n with max 0     TRADED   the falls together ≤ min
 *   RELOCATED  same size moved A→B, max 0 — and the vanished A is not also "pulled"
 *   the window the tenth level slides past is not flow
 *   PARKED     ≥ 30 min of captures, presence, ≤ 2 changes, an absence is a change
 *   WALKDOWN   3+ steps, each step's own window untraded, the last step recent
 *   CLOSING BID  an observation: the close's bid gone by the first capture, nothing traded
 */
const F = require('../src/services/ladderFlow');

let p = 0, n = 0;
const chk = (t, c, x) => { n++; if (c) p++; else console.log('  FAIL', t, x === undefined ? '' : JSON.stringify(x)); };
const T0 = Date.UTC(2026, 8, 10, 6, 0, 0);
const at = (m) => new Date(T0 + m * 60000);
const cap = (m, bid, offer) => ({ at: at(m), bid: new Map(bid), offer: new Map(offer) });
const vol = (pairs) => pairs.map(([m, v]) => ({ at: at(m), volume: v }));
const ev = (map, price) => (map.get(price) || []).map((m) => m.event);
const mk = (map, price, e) => (map.get(price) || []).find((m) => m.event === e);

console.log('\n=== volumeBracket ===');
{
  // captures at 0 and 0.5 straddling ONE reading at 0.25: max = reading(1) − reading(−1), min = 0
  const s = vol([[-1, 1000], [0.25, 1000], [1, 1000]]);
  chk('readings equal on both sides → {min 0, max 0}: nothing traded', JSON.stringify(F.volumeBracket(s, at(0), at(0.5))) === '{"min":0,"max":0}');
  const s2 = vol([[-1, 1000], [0.25, 1300], [1, 1300]]);
  chk('a rise on the straddled reading → max 300, min 0: could have traded, not certain when', JSON.stringify(F.volumeBracket(s2, at(0), at(0.5))) === '{"min":0,"max":300}');
  const s3 = vol([[0, 1000], [0.2, 1000], [0.8, 1600], [1, 1600]]);
  chk('readings strictly inside the pair → min 600 certain, max 600', JSON.stringify(F.volumeBracket(s3, at(0), at(1))) === '{"min":600,"max":600}');
  chk('no reading before the pair → unknown', F.volumeBracket(vol([[2, 5]]), at(0), at(1)) === null);
  chk('no reading after the pair → unknown', F.volumeBracket(vol([[-1, 5]]), at(0), at(1)) === null);
  chk('a counter that went down (reset) → unknown', F.volumeBracket(vol([[-1, 500], [2, 100]]), at(0), at(1)) === null);
}

console.log('\n=== flowMarkers ===');
const quiet = vol([[-1, 1000], [0.25, 1000], [1.5, 1000]]);   // one straddled reading, flat
{
  const caps = [cap(0, [[210, 30000], [205, 50000]], [[212, 40000]]), cap(1, [[210, 100000], [205, 50000]], [[212, 40000]])];
  const f = F.flowMarkers(caps, quiet, {});
  chk('PLACED: 210 grew 70,000 with nothing traded → the plain PLACED phrase', ev(f.bids, 210).includes('PLACED') && mk(f.bids, 210, 'PLACED').n === '70,000' && !mk(f.bids, 210, 'PLACED').key, f.bids.get(210));
  chk('  traded {0,0} reported', f.traded && f.traded.max === 0, f.traded);
  chk('  an unchanged level carries nothing', ev(f.bids, 205).length === 0);
  const g = F.flowMarkers(caps, vol([[-1, 1000], [0.25, 3000], [1.5, 3000]]), {});
  chk('PLACED while up to 2,000 may have traded → still PLACED, the PLACED_TRADING phrase with the max', ev(g.bids, 210).includes('PLACED') && mk(g.bids, 210, 'PLACED').key === 'PLACED_TRADING' && mk(g.bids, 210, 'PLACED').p === '2,000', g.bids.get(210));
}
{
  const caps = [cap(0, [[210, 132151]], [[212, 40000]]), cap(1, [[210, 30000]], [[212, 40000]])];
  chk('PULLED: −102,151 withdrawn with nothing traded', mk(F.flowMarkers(caps, quiet, {}).bids, 210, 'PULLED')?.n === '102,151');
  const some = F.flowMarkers(caps, vol([[-1, 5000], [0.25, 5000 + 33094], [1.5, 5000 + 33094]]), {});
  chk('  33,094 may have traded (straddled): UNKNOWN — no marker, not PULLED, not TRADED', ev(some.bids, 210).length === 0, some.bids.get(210));
  const certain = F.flowMarkers(caps, vol([[0, 5000], [0.2, 5000], [0.8, 5000 + 110000], [1, 5000 + 110000]]), {});
  chk('  110,000 CERTAINLY traded inside the pair: TRADED 102,151', mk(certain.bids, 210, 'TRADED')?.n === '102,151', certain.bids.get(210));
}
{
  // three bids each fall 60,000 with 60,000 certainly traded: together they exceed it → unknown, nothing claimed
  const caps = [cap(0, [[210, 100000], [209, 100000], [208, 100000]], []), cap(1, [[210, 40000], [209, 40000], [208, 40000]], [])];
  const f = F.flowMarkers(caps, vol([[0, 0], [0.2, 0], [0.8, 60000], [1, 60000]]), {});
  chk('the falls are judged TOGETHER: 180,000 fell, 60,000 traded → no TRADED on any of them', [210, 209, 208].every((px) => ev(f.bids, px).length === 0), [...f.bids]);
  const g = F.flowMarkers(caps, vol([[0, 0], [0.2, 0], [0.8, 200000], [1, 200000]]), {});
  chk('  200,000 traded covers all three → TRADED on each', [210, 209, 208].every((px) => ev(g.bids, px).includes('TRADED')));
}
{
  const caps = [cap(0, [[207, 50000], [203, 50000], [200, 10000]], []), cap(1, [[205, 50000], [200, 10000]], [])];
  const f = F.flowMarkers(caps, quiet, {});
  chk('RELOCATED: 50,000 moved 207→205 in one capture, nothing traded', mk(f.bids, 205, 'RELOCATED')?.p === 207, f.bids.get(205));
  chk('  not also PLACED', !ev(f.bids, 205).includes('PLACED'));
  chk('  207 (relocated) has no note; 203 (gone, same size, NOT the one that moved) is noted as pulled', f.notes.length === 1 && /203 × 50,000 gone, nothing traded — pulled/.test(f.notes[0]), f.notes);
}
{
  // the window: ten bids; a new one on top pushes the tenth out — the tenth is not "pulled"
  const ten = (top) => Array.from({ length: 10 }, (_, i) => [top - i, 30000]);
  const caps = [cap(0, ten(200), []), cap(1, ten(201), [])];
  const f = F.flowMarkers(caps, quiet, {});
  chk('a level that slid past the tenth is not pulled (no note); the new top is PLACED', f.notes.length === 0 && ev(f.bids, 201).includes('PLACED') && !ev(f.bids, 191).length, { notes: f.notes, top: f.bids.get(201) });
  const caps2 = [cap(0, ten(201), []), cap(1, ten(200), [])];
  const g = F.flowMarkers(caps2, quiet, {});
  chk('the touch pulled: the tenth sliding IN is not PLACED; the vanished touch is noted', !ev(g.bids, 191).length && g.notes.length === 1 && /201 × 30,000 gone/.test(g.notes[0]), { notes: g.notes, low: g.bids.get(191) });
}
{
  const caps = [cap(0, [[210, 30000]], []), cap(1, [[210, 100000]], [])];
  const f = F.flowMarkers(caps, [], {});
  chk('no volume series → traded null and PLACED still said (growth is growth), no PULLED/TRADED possible', f.traded === null && ev(f.bids, 210).includes('PLACED') && mk(f.bids, 210, 'PLACED').key === 'PLACED_TRADING' && mk(f.bids, 210, 'PLACED').p === null, f);
  const falls = [cap(0, [[210, 100000]], []), cap(1, [[210, 30000]], [])];
  chk('  a fall with no series → nothing claimed', F.flowMarkers(falls, [], {}).bids.size === 0);
}
{
  const caps = [cap(0, [[210, 30000]], []), cap(1, [[210, 45000]], [])];
  chk('a change under flow_change_min_qty is nothing', F.flowMarkers(caps, quiet, { flow_change_min_qty: 20000 }).bids.size === 0);
  chk('  the threshold is the kb row', ev(F.flowMarkers(caps, quiet, { flow_change_min_qty: 10000 }).bids, 210).includes('PLACED'));
}

console.log('\n=== parkedBids ===');
{
  const caps = [];
  for (let m = 0; m <= 40; m += 2) caps.push(cap(m, [[200, 155000 + (m === 30 ? 1000 : 0)], [195, 1000 * m + 1]], []));
  const parked = F.parkedBids(caps, {});
  chk('200: present every capture over 40 min, one blip (up and back = 2 changes) → PARKED with 2', parked.get(200) === 2, [...parked]);
  chk('195: changes every capture → not parked', !parked.has(195));
  chk('four captures over 6 minutes → too early, nothing parked', F.parkedBids(caps.slice(0, 4), {}).size === 0);
  const gap = caps.map((c, i) => (i === 5 || i === 9 ? cap(i * 2, [[195, 1]], []) : c));
  chk('an absence gap counts as a change (cancel/replace is not parked): 2 gaps + the blip = 4 → not parked', !F.parkedBids(gap, {}).has(200), [...F.parkedBids(gap, {})]);
  const oneGap = caps.map((c, i) => (i === 5 ? cap(i * 2, [[195, 1]], []) : c));
  chk('  one gap + the blip = 3 → not parked either', !F.parkedBids(oneGap, {}).has(200), [...F.parkedBids(oneGap, {})]);
  const steady = caps.map((c) => cap(c.at.getTime() / 60000 - T0 / 60000, [[200, 155000], [195, 1]]));
  const steadyGap = steady.map((c, i) => (i === 5 ? cap(i * 2, [[195, 1]]) : c));
  chk('  a steady size with one gap = 1 change → parked with 1', F.parkedBids(steadyGap, {}).get(200) === 1, [...F.parkedBids(steadyGap, {})]);
  const capsSparse = caps.map((c, i) => (i < 12 ? cap(i * 2, [[195, 1]], []) : c));
  chk('present in only half the captures → not parked', !F.parkedBids(capsSparse, {}).has(200));
}

console.log('\n=== walkdownSteps ===');
{
  const caps = [cap(0, [], [[239, 1000]]), cap(1, [], [[239, 1000]]), cap(2, [], [[228, 1000]]), cap(3, [], [[226, 1000]]), cap(4, [], [[225, 1000]])];
  const flat = vol([[-1, 10], [0.5, 10], [1.5, 10], [2.5, 10], [3.5, 10], [5, 10]]);
  chk('239→228→226→225 untraded = 3 steps', F.walkdownSteps(caps, flat, {}) === 3);
  chk('  two steps is under the minimum → 0', F.walkdownSteps(caps.slice(2), flat, {}) === 0);
  // a trade during the dwell at 239 (before the first step) does not break the walk
  const dwell = vol([[-1, 10], [0.5, 500], [1.5, 500], [2.5, 500], [3.5, 500], [5, 500]]);
  chk('  a trade during the dwell at the higher price, before the step, does not break it', F.walkdownSteps(caps, dwell, {}) === 3);
  // a trade inside a step (between the last 239 capture at 1 and the first 228 at 2)
  const inStep = vol([[-1, 10], [0.5, 10], [1.5, 500], [2.5, 500], [3.5, 500], [5, 500]]);
  chk('  a trade inside a step breaks the walk → 0', F.walkdownSteps(caps, inStep, {}) === 0);
  chk('  no volume series → unknown → 0', F.walkdownSteps(caps, [], {}) === 0);
  const old = [...caps, cap(30, [], [[225, 1000]])];
  chk('  the last step 26 minutes old → no longer shown (walkdown_max_age_mins 20)', F.walkdownSteps(old, vol([[-1, 10], [31, 10]]), {}) === 0);
  chk('    …unless the kb row allows it', F.walkdownSteps(old, vol([[-1, 10], [31, 10]]), { walkdown_max_age_mins: 40 }) === 3);
  const up = [cap(0, [], [[225, 1]]), cap(1, [], [[226, 1]]), cap(2, [], [[228, 1]]), cap(3, [], [[239, 1]])];
  chk('  a walk UP is not a walk-down', F.walkdownSteps(up, flat, {}) === 0);
}

console.log('\n=== closingBid (an observation) ===');
{
  const prev = { price: 224, qty: 1827769, at: at(-600), day: '2026-09-09' };
  const first = { bid: new Map([[224, 20000]]), at: at(0) };
  const cb = F.closingBid(prev, first, 0, {});
  chk('1,827,769 at the close → 20,000 this morning, nothing traded → CLOSING BID, worded as an observation', cb && cb.type === 'CLOSING BID' && /1,827,769 bid at 224 at 2026-09-09's close/.test(cb.text) && /observation/.test(cb.text), cb);
  chk('  gone entirely → the line too', !!F.closingBid(prev, { bid: new Map(), at: at(0) }, 0, {}));
  chk('  still there → nothing', F.closingBid(prev, { bid: new Map([[224, 1500000]]), at: at(0) }, 0, {}) === null);
  chk('  something traded → nothing claimed', F.closingBid(prev, first, 5000, {}) === null);
  chk('  volume unknown → nothing claimed', F.closingBid(prev, first, null, {}) === null);
  chk('  a small closing bid → nothing', F.closingBid({ ...prev, qty: 5000 }, first, 0, {}) === null);
}

console.log(`\n${p === n ? 'ALL PASS' : 'FAILURES: ' + (n - p)}  (${n} checks)`);
process.exit(p === n ? 0 : 1);
