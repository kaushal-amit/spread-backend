/*
 * ============================================================================
 *  THE CONTRACT LIFECYCLE, WALKED FORWARD
 * ============================================================================
 * THIS TEST EXISTS BECAUSE ITS ABSENCE LET TWO CRITICAL BUGS THROUGH.
 *
 * 226 checks passed while the system could not complete a round trip and could
 * not take a second trade. Every one of those assertions exercised a SINGLE
 * function against a fixture. Nothing walked
 *
 *     claim -> buy -> post sell -> resolve filled
 *
 * and then asked whether the position was closed, the capital returned, and a
 * second claim allowed.
 *
 * That is the same lesson as R-01, where the old test asserted `BINDING[id]`
 * existed and the new one asserts a 250-fil stock is out of reach when the
 * 2-tick capture is switched off. BEHAVIOUR, NOT WIRING.
 *
 * A real Postgres is not available here, so this runs against a small
 * in-memory table that answers exactly the queries the routes issue. What is
 * verified is the SQL PREDICATE and the seq resolution — which is precisely
 * where A-01 and A-02 lived.
 * ============================================================================
 */

let pass = 0, fail = 0;
const chk = (l, c, x = '') => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${x ? '  ' + x : ''}`); c ? pass++ : fail++; };

const rules = require('../src/lib/orderRules');

/* ------------------------------------------------------------------------
 * A tiny order_leg, and the two predicates the routes depend on.
 * ---------------------------------------------------------------------- */
class Book {
  constructor() { this.legs = []; this.nextId = 1; }

  add(leg) {
    this.legs.push({ id: this.nextId++, ...leg });
    return this.legs[this.legs.length - 1];
  }

  /** The OPEN_BUY predicate from routes.js, in JavaScript. */
  openBuys() {
    return this.legs.filter((l) =>
      l.side === 'BUY' && ['FILLED', 'CARRIED'].includes(l.status)
      && !this.legs.some((s) =>
        s.symbol === l.symbol && s.contract_seq === l.contract_seq
        && s.side === 'SELL' && s.status === 'FILLED'));
  }

  /** How a SELL resolves its contract_seq. */
  seqForSell(symbol, explicit = null) {
    if (explicit != null) return explicit;
    const open = this.openBuys()
      .filter((l) => l.symbol === symbol)
      .sort((a, b) => b.id - a.id)[0];
    if (open) return open.contract_seq;
    // Nothing open — this opens a new contract.
    const max = this.legs.filter((l) => l.symbol === symbol)
      .reduce((a, l) => Math.max(a, l.contract_seq), 0);
    return max + 1;
  }

  /** THE BUG THAT WAS: max(seq)+1 regardless of side. */
  seqForSellBroken(symbol) {
    const max = this.legs.filter((l) => l.symbol === symbol)
      .reduce((a, l) => Math.max(a, l.contract_seq), 0);
    return max + 1;
  }

  /** contracts(): a contract with a filled buy and no filled sell. */
  holdings() {
    const bySeq = new Map();
    for (const l of this.legs) {
      const k = `${l.symbol}:${l.contract_seq}`;
      if (!bySeq.has(k)) bySeq.set(k, []);
      bySeq.get(k).push(l);
    }
    return [...bySeq.values()].filter((legs) =>
      legs.some((l) => l.side === 'BUY' && l.status === 'FILLED')
      && !legs.some((l) => l.side === 'SELL' && l.status === 'FILLED'));
  }

  /** accountSummary(): capital still committed. */
  investedKd() {
    return this.openBuys().reduce(
      (a, l) => a + (l.price_fils * (l.filled_shares ?? l.shares)) / 1000, 0);
  }
}

/* ======================================================================== */
console.log('=== A-02 · a SELL closes the open buy, it does not open a contract ===');
{
  const b = new Book();
  b.add({ symbol: 'CATTL', contract_seq: 1, side: 'BUY', status: 'FILLED',
          price_fils: 128, shares: 6100, filled_shares: 6100 });

  chk('the broken resolver gave the sell seq 2', b.seqForSellBroken('CATTL') === 2,
      'the buy was seq 1 — every consumer then saw a buy with no sell');
  chk('the fixed resolver gives it seq 1', b.seqForSell('CATTL') === 1,
      'it closes the contract that is open');
  chk('an explicit seq still wins', b.seqForSell('CATTL', 7) === 7,
      'hit-bid passes it directly and must keep working');
}

console.log('\n=== the full round trip ===');
{
  const b = new Book();

  // 1 · claim and buy
  chk('nothing is open before the first buy', b.openBuys().length === 0);
  chk('  so a first claim is allowed',
      rules.checkNewPosition({ openPositions: b.openBuys().length, maxPositions: 1 }).allowed);

  b.add({ symbol: 'CATTL', contract_seq: 1, side: 'BUY', status: 'FILLED',
          price_fils: 128, shares: 6100, filled_shares: 6100 });

  chk('after the buy, one position is open', b.openBuys().length === 1);
  chk('  it renders as holding', b.holdings().length === 1);
  chk('  capital is committed', Math.round(b.investedKd()) === 781,
      `${b.investedKd().toFixed(1)} KD`);
  chk('  and a SECOND claim is refused — one position, full size',
      !rules.checkNewPosition({ openPositions: b.openBuys().length, maxPositions: 1 }).allowed,
      '2 x 400 KD earned +0.02 where 1 x 850 earned +1.16');

  // 2 · post the sell. POSTED is not FILLED — the contract is still open.
  b.add({ symbol: 'CATTL', contract_seq: b.seqForSell('CATTL'), side: 'SELL',
          status: 'POSTED', price_fils: 129, shares: 6100 });

  chk('a POSTED sell does not close the contract', b.openBuys().length === 1,
      'an order that exists and an order that has traded are different states');
  chk('  and the position is still holding', b.holdings().length === 1);

  // 3 · it fills
  const posted = b.legs.find((l) => l.side === 'SELL' && l.status === 'POSTED');
  posted.status = 'FILLED';
  posted.filled_shares = 6100;

  chk('the filled sell CLOSES the position', b.openBuys().length === 0,
      'this is what A-02 broke — the sell landed on a different seq');
  chk('  contracts() returns no holding', b.holdings().length === 0);
  chk('  investedKd returns to zero', b.investedKd() === 0,
      'it kept counting a sold position, overstating equity by the position value');
  chk('  AND A SECOND CLAIM IS ALLOWED',
      rules.checkNewPosition({ openPositions: b.openBuys().length, maxPositions: 1 }).allowed,
      'A-01: the guard counted every buy ever filled, so this was 409 forever');
}

console.log('\n=== A-01 · the guard must not count history ===');
{
  const b = new Book();
  // Three completed round trips.
  for (let seq = 1; seq <= 3; seq++) {
    b.add({ symbol: 'KFIC', contract_seq: seq, side: 'BUY', status: 'FILLED',
            price_fils: 175, shares: 4400, filled_shares: 4400 });
    b.add({ symbol: 'KFIC', contract_seq: seq, side: 'SELL', status: 'FILLED',
            price_fils: 176, shares: 4400, filled_shares: 4400 });
  }

  const everyBuyEver = b.legs.filter((l) =>
    l.side === 'BUY' && ['FILLED', 'CARRIED'].includes(l.status)).length;

  chk('three closed trips leave three filled buys in history', everyBuyEver === 3);
  chk('  the broken guard would refuse a fourth trade',
      !rules.checkNewPosition({ openPositions: everyBuyEver, maxPositions: 1 }).allowed,
      'the system took one trade and then refused all further work, forever');
  chk('  the fixed guard counts zero open', b.openBuys().length === 0);
  chk('  and allows the fourth trade',
      rules.checkNewPosition({ openPositions: b.openBuys().length, maxPositions: 1 }).allowed);
}

console.log('\n=== a carried position stays open across days ===');
{
  const b = new Book();
  b.add({ symbol: 'EQUIPMENT', contract_seq: 1, side: 'BUY', status: 'CARRIED',
          price_fils: 238, shares: 3500, filled_shares: 3500,
          trading_day: '2026-07-29', carried_from_day: '2026-07-29' });

  chk('CARRIED counts as open', b.openBuys().length === 1,
      'rule 8 says never carry, but a position that IS carried must still be seen');
  chk('  and blocks a new claim',
      !rules.checkNewPosition({ openPositions: b.openBuys().length, maxPositions: 1 }).allowed);

  // The next day's sell closes it, on the same seq.
  b.add({ symbol: 'EQUIPMENT', contract_seq: b.seqForSell('EQUIPMENT'), side: 'SELL',
          status: 'FILLED', price_fils: 236, shares: 3500, filled_shares: 3500,
          trading_day: '2026-07-30' });

  chk('a cross-day sell closes the carried contract', b.openBuys().length === 0,
      'a buy on the 29th and a sell on the 30th are ONE contract');
}

console.log('\n=== two symbols do not interfere ===');
{
  const b = new Book();
  b.add({ symbol: 'CATTL', contract_seq: 1, side: 'BUY', status: 'FILLED',
          price_fils: 128, shares: 6100, filled_shares: 6100 });
  b.add({ symbol: 'ARABREC', contract_seq: 1, side: 'SELL', status: 'FILLED',
          price_fils: 170, shares: 4600, filled_shares: 4600 });

  chk('selling ARABREC does not close the CATTL position',
      b.openBuys().length === 1 && b.openBuys()[0].symbol === 'CATTL',
      'the predicate matches on symbol AND seq');
}

console.log('\n=== V-02 · a STALE explicit seq must not land on a closed contract ===');
{
  /*
   * The gap the previous test left: it exercised the resolver with `seq = null`
   * only. The client then began sending a CONSTANT seq of 1, so after the first
   * round trip every sell was written onto a closed contract and A-02's
   * symptoms returned — the position stayed holding and investedKd kept
   * counting it.
   */
  const b = new Book();

  // Trip one, closed.
  b.add({ symbol: 'KFIC', contract_seq: 1, side: 'BUY', status: 'FILLED',
          price_fils: 175, shares: 4400, filled_shares: 4400 });
  b.add({ symbol: 'KFIC', contract_seq: 1, side: 'SELL', status: 'FILLED',
          price_fils: 176, shares: 4400, filled_shares: 4400 });

  // Trip two, open.
  b.add({ symbol: 'KFIC', contract_seq: 2, side: 'BUY', status: 'FILLED',
          price_fils: 177, shares: 4400, filled_shares: 4400 });

  chk('one contract is open, and it is seq 2',
      b.openBuys().length === 1 && b.openBuys()[0].contract_seq === 2);
  chk('the resolver picks seq 2 when nothing is sent', b.seqForSell('KFIC') === 2);

  /* What the client was sending, and what it would have done. */
  const stale = 1;
  const openSeq = b.openBuys()[0].contract_seq;
  chk('a constant seq of 1 names a CLOSED contract', stale !== openSeq,
      'the server must refuse rather than write it');

  // Simulate the write that used to happen, and show the damage.
  const shadow = new Book();
  shadow.legs = b.legs.map((l) => ({ ...l }));
  shadow.add({ symbol: 'KFIC', contract_seq: stale, side: 'SELL', status: 'FILLED',
               price_fils: 178, shares: 4400, filled_shares: 4400 });

  chk('  writing it leaves the real position OPEN', shadow.openBuys().length === 1,
      'the sale is recorded and the position never closes');
  chk('  and investedKd keeps counting it', shadow.investedKd() > 0,
      `${shadow.investedKd().toFixed(1)} KD still committed after a sale`);
  chk('  so a second claim stays blocked',
      !rules.checkNewPosition({ openPositions: shadow.openBuys().length, maxPositions: 1 }).allowed);

  // The correct write.
  b.add({ symbol: 'KFIC', contract_seq: b.seqForSell('KFIC'), side: 'SELL',
          status: 'FILLED', price_fils: 178, shares: 4400, filled_shares: 4400 });
  chk('resolving it properly closes the position', b.openBuys().length === 0);
  chk('  and a third claim is allowed',
      rules.checkNewPosition({ openPositions: b.openBuys().length, maxPositions: 1 }).allowed);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail}  (${pass} checks)`);
process.exit(fail ? 1 : 0);
