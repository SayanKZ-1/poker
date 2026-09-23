import test from 'node:test';
import assert from 'node:assert/strict';
import {Table, evaluateFive, bestHand, compareRanks, shuffledDeck} from '../lib/poker.mjs';
const cards = s => s.split(' ');
const make = (n = 3, opts = {}) => { const t = new Table(opts); for (let i=0;i<n;i++) t.addPlayer(`p${i}`,`Player ${i}`); return t; };

test('all nine hand categories, wheel and kicker ordering', () => {
  const cases = [['As Kd Jh 9c 3s',0],['As Ad Kh 8c 3s',1],['As Ad Kh Kc 3s',2],['As Ad Ah Kc 3s',3],['As 2d 3h 4c 5s',4],['As Js 8s 5s 2s',5],['As Ad Ah Kc Ks',6],['As Ad Ah Ac Ks',7],['As Ks Qs Js Ts',8]];
  for (const [hand,category] of cases) assert.equal(evaluateFive(cards(hand))[0],category,hand);
  assert.deepEqual(evaluateFive(cards('As 2d 3h 4c 5s')),[4,5]);
  assert.ok(compareRanks(evaluateFive(cards('As Ad Kh 8c 3s')),evaluateFive(cards('As Ad Qh Jc 9s')))>0);
  assert.throws(()=>evaluateFive(cards('As As Kh 8c 3s')));
});
test('best five out of seven, two triples, and board-only tie', () => {
  assert.deepEqual(bestHand(cards('As Ad Ah Kc Ks Kh 2s')).rank,[6,14,13]);
  const board=cards('As Ks Qs Js Ts');
  assert.equal(compareRanks(bestHand([...board,'2c','3d']).rank,bestHand([...board,'8h','9h']).rank),0);
});
test('deck contains 52 unique, valid cards', () => {
  for(let i=0;i<20;i++) {const d=shuffledDeck();assert.equal(d.length,52);assert.equal(new Set(d).size,52);assert.ok(d.every(c=>/^[2-9TJQKA][cdhs]$/.test(c)));}
});
test('three-handed blinds, action order and big-blind option', () => {
  const t=make();t.startHand();assert.equal(t.dealer,0);assert.equal(t.actor,'p0');assert.equal(t.player('p1').bet,10);assert.equal(t.player('p2').bet,20);
  t.act('p0','call');t.act('p1','call');assert.equal(t.phase,'preflop');assert.equal(t.actor,'p2');assert.ok(t.legal('p2').canCheck);
  t.act('p2','check');assert.equal(t.phase,'flop');assert.equal(t.actor,'p1');assert.equal(t.board.length,3);assert.equal(t.pot,60);
});
test('heads-up button is SB, first preflop, last postflop', () => {
  const t=make(2);t.startHand();assert.equal(t.dealer,0);assert.equal(t.actor,'p0');assert.equal(t.player('p0').bet,10);
  t.act('p0','call');t.act('p1','check');assert.equal(t.phase,'flop');assert.equal(t.actor,'p1');
});
test('reject wrong turn, invalid check, fractional and undersized raises', () => {
  const t=make();t.startHand();const version=t.version;
  assert.throws(()=>t.act('p1','fold'));assert.throws(()=>t.act('p0','check'));assert.throws(()=>t.act('p0','raise',30));assert.throws(()=>t.act('p0','raise',40.5));assert.throws(()=>t.act('p0','raise',2001));
  assert.equal(t.version,version);assert.equal(t.pot,30);t.assertChips();
});
test('minimum raise tracks the last full raise, not total bet', () => {
  const t=make();t.startHand();t.act('p0','raise',70);assert.equal(t.legal('p1').minTo,120);
});
test('fold victory does not expose winner cards and returns uncalled chips', () => {
  const t=make();t.startHand();t.act('p0','raise',200);t.act('p1','fold');t.act('p2','fold');
  assert.equal(t.phase,'showdown');assert.equal(t.player('p0').stack,2030);assert.equal(t.player('p1').stack,1990);assert.equal(t.player('p2').stack,1980);
  assert.deepEqual(t.viewFor('p1').players[0].cards,['??','??']);assert.equal(t.payouts[0].amount,50);t.assertChips();
});
test('public snapshots contain no deck, RNG state, or opponent hole cards', () => {
  const t=make();t.startHand();const v=t.viewFor('p0');assert.equal(v.deck,undefined);assert.equal(v.players[0].cards.length,2);assert.notEqual(v.players[0].cards[0],'??');
  assert.deepEqual(v.players[1].cards,['??','??']);assert.deepEqual(v.players[2].cards,['??','??']);
  v.players[0].cards[0]='XX';assert.notEqual(t.player('p0').cards[0],'XX');
});
test('different stack all-ins create side pots and return unmatched amount', () => {
  const t=make();const amounts=[50,100,150],holes=[cards('As Ad'),cards('Ks Kd'),cards('Qs Qd')];
  t.phase='river';t.board=cards('2c 3h 7s 8c 9h');t.dealer=0;
  t.players.forEach((p,i)=>Object.assign(p,{total:amounts[i],stack:2000-amounts[i],cards:holes[i],inHand:true}));
  t.finish(true);t.assertChips();assert.deepEqual(t.players.map(p=>p.stack),[2100,2000,1900]);assert.deepEqual(t.pots.map(p=>p.amount),[150,100]);
});
test('split pot, folded contribution and odd chip clockwise after button', () => {
  const t=make();t.phase='river';t.board=cards('As Ks Qs Js Ts');t.dealer=0;
  const holes=[cards('2c 3d'),cards('4c 5d'),cards('6c 7d')];
  t.players.forEach((p,i)=>Object.assign(p,{total:21,stack:1979,cards:holes[i],inHand:true,folded:i===2}));
  t.finish(true);t.assertChips();assert.equal(t.player('p1').stack,2011);assert.equal(t.player('p0').stack,2010);assert.equal(t.player('p2').stack,1979);
});
test('short all-in does not reopen a player who already acted', () => {
  const t=make(4);t.player('p0').stack=150;t.chipsIssued-=1850;t.startHand();
  assert.equal(t.actor,'p3');t.act('p3','raise',100);t.act('p0','raise',150);t.act('p1','call');t.act('p2','call');
  assert.equal(t.actor,'p3');assert.equal(t.legal('p3').canRaise,false);assert.equal(t.legal('p3').toCall,50);assert.throws(()=>t.act('p3','raise',250));
});
test('cumulative short all-ins reopen action when full raise is reached', () => {
  const t=make(5);t.player('p4').stack=140;t.player('p0').stack=180;t.chipsIssued-=3680;t.startHand();
  assert.equal(t.actor,'p3');t.act('p3','raise',100);t.act('p4','raise',140);t.act('p0','raise',180);t.act('p1','call');t.act('p2','call');
  assert.equal(t.actor,'p3');assert.equal(t.legal('p3').canRaise,true);assert.equal(t.legal('p3').minTo,260);
});
test('all-in runout terminates and accounts for every chip', () => {
  const t=make(3);t.startHand();t.act('p0','raise',2000);t.act('p1','call');t.act('p2','call');
  assert.equal(t.phase,'showdown');assert.equal(t.board.length,5);assert.equal(t.pot,0);assert.equal(t.players.reduce((s,p)=>s+p.stack,0),6000);t.assertChips();
});
test('short all-in BB in heads-up does not force uncontested extra call', () => {
  const t=make(2);t.player('p1').stack=5;t.chipsIssued-=1995;t.startHand();assert.equal(t.phase,'showdown');assert.equal(t.board.length,5);t.assertChips();
});
test('timeout now folds even for free and marks the seat sitting out', () => {
  let now=100000;const t=make(3,{now:()=>now});t.startHand();now+=30001;assert.ok(t.tick());assert.ok(t.player('p0').folded);
  t.act('p1','call');now+=30001;t.tick();assert.equal(t.phase,'showdown');assert.equal(t.player('p2').folded,true);assert.equal(t.player('p2').sittingOut,true);
});
test('cannot join, leave or top up during a hand', () => {
  const t=make();t.startHand();assert.throws(()=>t.addPlayer('x','X'));assert.throws(()=>t.removePlayer('p0'));const stack=t.player('p0').stack;t.topUp('p0');assert.equal(t.player('p0').stack,stack);assert.equal(t.player('p0').pendingBuyIn,t.startingStack);
});
test('1,000 randomized hands preserve chips, privacy and terminate', () => {
  let seed=7531;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let h=0;h<1000;h++) {
    const t=make(2+rand(5));t.players.forEach(p=>{const value=5+rand(1996);t.chipsIssued-=p.stack-value;p.stack=value;});t.startHand();
    let steps=0;
    while(!t.idle) {
      assert.ok(++steps<300,`hand ${h} did not finish`);
      const id=t.actor,l=t.legal(id),r=rand(100);
      if(l.canRaise && r<20) t.act(id,'raise',r<6||l.allInOnly?l.maxTo:Math.min(l.maxTo,l.minTo+rand(4)*t.bigBlind));
      else if(r<35) t.act(id,'fold');
      else t.act(id,l.canCheck?'check':'call');
      t.assertChips();
    }
    assert.equal(t.pot,0);assert.ok(t.players.every(p=>p.stack>=0));
  }
});

test('transition from three-handed to heads-up avoids consecutive BB', () => {
  const t=make(3);t.startHand();assert.equal(t.lastBigBlind,2);
  t.act('p0','fold');t.act('p1','fold');
  t.removePlayer('p0');t.startHand();
  assert.equal(t.dealer,2);assert.equal(t.lastBigBlind,1);
});
