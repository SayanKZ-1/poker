import test from 'node:test';
import assert from 'node:assert/strict';
import {Table, buildPots, bestHand, compareRanks} from '../lib/poker.mjs';
const cards=s=>s.split(' ');
const make=(n=3,opts={})=>{const t=new Table(opts);for(let i=0;i<n;i++)t.addPlayer(`p${i}`,`P${i}`);return t;};
const total=t=>t.players.reduce((s,p)=>s+p.stack+p.total,0);
function showdown(t,amounts,folded=[],holes=null,board='As Ks Qs Js Ts') {
  t.phase='river';t.dealer=t.maxPlayers-1;t.board=cards(board);
  const defaults=['2c 3c','4c 5c','6c 7c','8c 9c','Tc Jc','Qc Kc'];
  t.players.forEach((p,i)=>Object.assign(p,{total:amounts[i],stack:2000-amounts[i],inHand:true,folded:folded.includes(i),cards:cards((holes||defaults)[i])}));
}

test('regression: folded contributions must not manufacture four pots and two odd chips',()=>{
  const t=make(5);showdown(t,[200,200,51,102,153],[2,3,4]);t.finish(true);
  assert.deepEqual(t.pots.map(p=>p.amount),[706]);
  assert.deepEqual(t.payouts.map(p=>p.amount),[353,353]);
  assert.equal(t.accounting.reduce((s,p)=>s+p.net,0),0);
});

test('the folded-layer regression is reachable by legal actions, not only injected states',()=>{
  const t=make(5);
  const prefix=cards('4c 6c 8c Tc 2c 5c 7c 9c Jc 3c 2d As Ks Qs 3d Js 4d Ts');
  const deck=[...'cdhs'].flatMap(s=>[...'23456789TJQKA'].map(r=>r+s));
  t.startHand([...prefix,...deck.filter(c=>!prefix.includes(c))]);
  // Everyone puts in 51 preflop. SB then bets 51 on flop and turn, 47 on river.
  t.act('p3','raise',51); t.act('p4','call');t.act('p0','call');t.act('p1','call');t.act('p2','call');
  t.act('p1','raise',51);t.act('p2','fold');t.act('p3','call');t.act('p4','call');t.act('p0','call');
  t.act('p1','raise',51);t.act('p3','fold');t.act('p4','call');t.act('p0','call');
  t.act('p1','raise',47);t.act('p4','fold');
  t.act('p0','call');
  assert.equal(t.phase,'showdown');assert.equal(t.pots.length,1);
  assert.deepEqual(t.payouts.map(p=>p.amount),[353,353]);
});

test('three different all-ins: 300 main, 400 side, 200 returned, with net results',()=>{
  const t=make();showdown(t,[100,300,500],[],['As Ad','Ks Kd','Qs Qd'],'2c 3h 7s 8c 9h');t.finish(true);
  assert.deepEqual(t.pots.map(p=>p.amount),[300,400]);
  assert.deepEqual(t.pots.map(p=>p.eligible),[['p0','p1','p2'],['p1','p2']]);
  assert.deepEqual(t.pots.map(p=>p.winners),[['p0'],['p1']]);
  assert.deepEqual(t.refunds.map(r=>[r.id,r.amount]),[['p2',200]]);
  assert.equal(t.lastPot,700);assert.equal(t.committedPot,900);
  assert.deepEqual(t.accounting.map(p=>p.net),[200,100,-300]);
  assert.deepEqual(t.accounting.map(p=>p.finalStack),[2200,2100,1700]);
  assert.equal(t.payouts.some(p=>p.id==='p2'),false);
});

test('multiple real side pots are independently split; folded player cannot win',()=>{
  const t=make(6);showdown(t,[51,102,153,153,153,153],[5]);t.finish(true);
  assert.deepEqual(t.pots.map(p=>p.amount),[306,255,204]);
  assert.deepEqual(t.pots.map(p=>p.eligible.length),[5,4,3]);
  assert.ok(t.pots.every(p=>p.awards.reduce((s,a)=>s+a.amount,0)===p.amount));
  assert.ok(t.pots.every(p=>!p.winners.includes('p5')));
  t.assertChips();
});

test('a sole winner gets uncontested pot, but returned chips are not labelled as winnings',()=>{
  const t=make();t.startHand();t.act('p0','raise',200);t.act('p1','fold');t.act('p2','fold');
  assert.equal(t.lastPot,50);assert.equal(t.committedPot,230);
  assert.equal(t.refunds[0].amount,180);assert.equal(t.payouts[0].amount,50);assert.equal(t.payouts[0].net,30);
  assert.throws(()=>t.finish(false));assert.equal(t.player('p0').stack,2030);
});

test('invalid later pot never partially credits an earlier pot',()=>{
  const t=make();showdown(t,[20,100,100],[1,2]);const before=t.players.map(p=>p.stack);
  assert.throws(()=>t.finish(true),/Банк без/);assert.deepEqual(t.players.map(p=>p.stack),before);
  assert.deepEqual(t.pots,[]);
});

test('rollback restores a rejected state transition, including cards, chips and event log',()=>{
  const t=make();t.startHand();
  const prior=Table.prototype.finish;Table.prototype.finish=()=>{throw new Error('injected settlement fault');};
  try {t.act('p0','fold');const state=t.viewFor('p1');assert.throws(()=>t.act('p1','fold'),/injected/);assert.deepEqual(t.viewFor('p1').players,state.players);assert.equal(t.actor,'p1');}
  finally {Table.prototype.finish=prior;}
  t.assertChips();assert.equal(total(t),6000);
});

test('odd-chip rule wraps around a dead button and ignores card suits',()=>{
  const t=make(4);showdown(t,[21,21,21,21],[0]);t.dealer=1;t.finish(true);
  assert.deepEqual(t.pots[0].winners,['p2','p3','p1']);assert.deepEqual(t.pots[0].awards.map(a=>a.amount),[28,28,28]);
  const u=make(3);showdown(u,[21,21,21],[2]);u.dealer=5;u.finish(true);
  assert.deepEqual(u.pots[0].awards,[{id:'p0',amount:32},{id:'p1',amount:31}]);
});

test('cash UTG straddle posts 2 BB, acts last if unraised, resets sizing after flop',()=>{
  const t=make(4,{straddleAllowed:true});t.setStraddle('p3',true);t.startHand();
  assert.deepEqual(t.straddle,{id:'p3',amount:40});assert.equal(t.player('p3').bet,40);
  assert.equal(t.actor,'p0');assert.equal(t.legal('p0').toCall,40);assert.equal(t.legal('p0').minTo,80);
  t.act('p0','call');t.act('p1','call');t.act('p2','call');
  assert.equal(t.actor,'p3');assert.ok(t.legal('p3').canCheck);assert.ok(t.legal('p3').canRaise);
  t.act('p3','check');assert.equal(t.phase,'flop');assert.equal(t.actor,'p1');assert.equal(t.legal('p1').minTo,20);
});

test('straddle cannot be declared after cards, by a non-UTG preference, short stack or heads-up',()=>{
  const t=make(4,{straddleAllowed:true});t.setStraddle('p1',true);t.startHand();assert.equal(t.straddle,null);
  assert.throws(()=>t.setStraddle('p3',true),/до раздачи/);
  const u=make(4,{straddleAllowed:true});u.setStraddle('p3',true);u.player('p3').stack=30;u.chipsIssued-=1970;u.startHand();assert.equal(u.straddle,null);
  const v=make(2,{straddleAllowed:true});v.setStraddle('p0',true);v.setStraddle('p1',true);v.startHand();assert.equal(v.straddle,null);
  assert.throws(()=>make(2).setStraddle('p0',true));
});

test('tournament forbids straddle and removal but supports approved late entry and rebuy',()=>{
  assert.throws(()=>make(3,{mode:'tournament',straddleAllowed:true}),/страдл/);
  const t=make(3,{mode:'tournament'});assert.throws(()=>t.setStraddle('p0',true));
  t.startHand();t.act('p0','fold');t.act('p1','fold');
  t.addPlayer('late','Late',{unfunded:true});assert.equal(t.player('late').stack,0);assert.throws(()=>t.removePlayer('p1'));t.topUp('late',2000,'buyIn');t.assertChips();
});

test('tournament levels change only between hands, not during an existing hand',()=>{
  let now=1000;const t=make(3,{mode:'tournament',levelMinutes:1,turnMs:120000,now:()=>now});t.startHand();
  now+=60001;assert.equal(t.bigBlind,20);t.act('p0','fold');t.act('p1','fold');t.startHand();
  assert.equal(t.bigBlind,40);assert.equal(t.smallBlind,20);assert.equal(t.level,1);
});

test('tournament determines a champion and resumes only after new funding',()=>{
  const t=make(2,{mode:'tournament'});showdown(t,[2000,2000],[],['As Ad','Ks Kd'],'2c 3h 7s 8c 9h');t.finish(true);
  assert.equal(t.tournamentOver,true);assert.equal(t.championId,'p0');assert.throws(()=>t.startHand());t.requestRebuy('p1',2000,'request-reentry-champion','reentry');t.beginRebuyReview('review-champion');t.decideRebuy('request-reentry-champion',true);assert.equal(t.tournamentOver,false);t.endRebuyReview('review-champion');t.assertChips();
});

test('dead-button rotation does not make a player skip the big blind after another player busts',()=>{
  const t=make(4,{mode:'tournament'});t.startHand();t.act('p3','fold');t.act('p0','fold');t.act('p1','fold');
  // Simulate BB elimination between hands while preserving total chips.
  t.player('p0').stack+=t.player('p2').stack;t.player('p2').stack=0;
  t.startHand();assert.equal(t.dealer,1);assert.equal(t.lastBigBlind,3);
  assert.equal(t.player('p1').bet,0);assert.equal(t.player('p3').bet,20);
  assert.equal(t.pot,20); // Dead SB, not a second blind charged to another player.
});

test('cash excludes explicit sit-out seats; tournament keeps them in mandatory blind rotation',()=>{
  const cash=make(3);cash.sitOut('p2');cash.startHand();
  assert.equal(cash.player('p2').inHand,false);assert.equal(cash.player('p2').bet,0);
  assert.equal(cash.player('p2').sittingOut,true);
  const t=make(3,{mode:'tournament'});t.sitOut('p2');t.startHand();
  assert.equal(t.player('p2').bet,20);assert.equal(t.player('p2').inHand,true);
  assert.equal(t.player('p2').sittingOut,true);
});

test('a call after the first short all-in is not reopened by a later insufficient increment',()=>{
  const t=make(5);t.player('p4').stack=125;t.player('p1').stack=200;t.chipsIssued-=3675;
  // SB/BB = 50/100 for the published TDA-style example.
  t.smallBlind=50;t.bigBlind=100;t.startHand();
  t.act('p3','call');t.act('p4','raise',125);t.act('p0','call');t.act('p1','raise',200);t.act('p2','call');
  assert.equal(t.actor,'p3');assert.ok(t.legal('p3').canRaise);t.act('p3','call');
  assert.equal(t.actor,'p0');assert.equal(t.legal('p0').canRaise,false);assert.equal(t.legal('p0').toCall,75);
});

// Separate oracle: form pots directly at LIVE-player caps, not at every
// contribution level; first remove uniquely unmatched overage.
function oracle(players,board,dealer,maxPlayers) {
  const ps=players.map(p=>({...p})),credit=Object.fromEntries(ps.map(p=>[p.id,0]));
  const sorted=[...ps].sort((a,b)=>b.total-a.total);
  if(sorted[0].total>sorted[1].total){const r=sorted[0].total-sorted[1].total;credit[sorted[0].id]+=r;sorted[0].total-=r;}
  const live=ps.filter(p=>!p.folded&&p.inHand), caps=[...new Set(live.map(p=>p.total))].filter(Boolean).sort((a,b)=>a-b);
  let lower=0;
  for(const upper of caps) {
    const amount=ps.reduce((s,p)=>s+Math.min(p.total,upper)-Math.min(p.total,lower),0);lower=upper;
    const eligible=live.filter(p=>p.total>=upper);let best=null,winners=[];
    for(const p of eligible){const rank=bestHand([...p.cards,...board]).rank,cmp=best===null?1:compareRanks(rank,best);if(cmp>0){best=rank;winners=[p];}else if(cmp===0)winners.push(p);}
    winners.sort((a,b)=>(a.seat-dealer-1+maxPlayers)%maxPlayers-(b.seat-dealer-1+maxPlayers)%maxPlayers);
    winners.forEach((p,i)=>credit[p.id]+=Math.floor(amount/winners.length)+(i<amount%winners.length?1:0));
  }
  return credit;
}

test('5,000 generated settlements agree player-by-player with an independent cap-based oracle',()=>{
  let seed=9137;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let h=0;h<5000;h++) {
    const n=2+rand(5),t=make(n),amounts=Array.from({length:n},()=>1+rand(300));
    const top=amounts.indexOf(Math.max(...amounts));
    const folded=Array.from({length:n},(_,i)=>i).filter(i=>i!==top&&i!==(top+1)%n&&rand(2));
    showdown(t,amounts,folded,null,h%2?'2d 5h 9s Jd Kh':'As Ks Qs Js Ts');t.dealer=rand(6);
    const expected=oracle(t.players,t.board,t.dealer,t.maxPlayers),before=t.players.map(p=>p.stack);
    t.finish(true);t.assertChips();
    t.players.forEach((p,i)=>assert.equal(p.stack-before[i],expected[p.id],`case ${h}, player ${i}`));
    assert.equal(t.accounting.reduce((s,p)=>s+p.net,0),0);
  }
});
