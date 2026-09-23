import test from 'node:test';
import assert from 'node:assert/strict';
import {Table} from '../lib/poker.mjs';
function fixture(count=3,options={}) {
  let now=100000;
  const t=new Table({now:()=>now,...options});
  for(let i=0;i<count;i++) t.addPlayer(`p${i}`,`P${i}`);
  return {t,at(value){now=value;},jump(ms){now+=ms;},get now(){return now;}};
}
function finish(t) {
  let guard=0;
  while(!t.idle) {
    assert.ok(++guard<40);
    if(t.player(t.actor).sittingOut) t.transaction(()=>t.foldAbsent(t.actor,'manual'));
    else t.act(t.actor,'fold');
  }
  t.assertChips();
}
function next(f) {assert.notEqual(f.t.nextHandAt,null);f.at(f.t.nextHandAt);assert.equal(f.t.tick(),true);}

test('autoplay starts only once and advances exactly once after six seconds',()=>{
  const f=fixture(),{t}=f;t.startPlay();assert.equal(t.running,true);finish(t);
  const due=t.nextHandAt;assert.equal(due,f.now+6000);
  for(let i=0;i<10;i++){assert.equal(t.tick(),false);assert.equal(t.nextHandAt,due);}
  f.at(due-1);assert.equal(t.tick(),false);assert.equal(t.handId,1);
  f.at(due);assert.equal(t.tick(),true);assert.equal(t.handId,2);assert.equal(t.nextHandAt,null);
  assert.equal(t.tick(),false);assert.throws(()=>t.startPlay(),/уже запущена/);
});
test('timeout folds even a free check and requires explicit return',()=>{
  const f=fixture(),{t}=f;t.startPlay();t.act('p0','call');t.act('p1','call');
  assert.equal(t.actor,'p2');assert.equal(t.legal('p2').canCheck,true);
  f.at(t.deadline);t.tick();assert.equal(t.player('p2').folded,true);
  assert.equal(t.player('p2').sittingOut,true);assert.equal(t.player('p2').returnPending,false);
  assert.equal(t.handHistory.find(e=>e.automatic)?.reason,'timeout');
  t.setConnected('p2',false);t.setConnected('p2',true);
  assert.equal(t.player('p2').sittingOut,true);finish(t);next(f);
  assert.equal(t.player('p2').inHand,false);assert.equal(t.player('p2').cards.length,0);
});
test('cash pauses with fewer than two ready players and resumes after explicit return',()=>{
  const f=fixture(2),{t}=f;t.startPlay();f.at(t.deadline);t.tick();
  assert.equal(t.phase,'showdown');assert.equal(t.nextHandAt,null);
  f.jump(60000);assert.equal(t.tick(),false);assert.equal(t.handId,1);
  t.returnToPlay('p0');assert.equal(t.player('p0').sittingOut,true);
  assert.equal(t.player('p0').returnPending,true);next(f);
  assert.equal(t.handId,2);assert.equal(t.player('p0').sittingOut,false);
});
test('manual sit-out never folds out of turn, and returning cannot resurrect that hand',()=>{
  const f=fixture(),{t}=f;t.startPlay();t.sitOut('p1');t.returnToPlay('p1');
  assert.equal(t.actor,'p0');assert.equal(t.player('p1').folded,false);
  t.act('p0','call');assert.equal(t.actor,'p1');assert.equal(t.viewFor('p1').legal,null);
  assert.throws(()=>t.act('p1','call'),/не играете/);
  f.at(t.deadline);t.tick();assert.equal(t.player('p1').folded,true);
  assert.equal(t.player('p1').returnPending,true);finish(t);next(f);
  assert.equal(t.player('p1').sittingOut,false);assert.equal(t.player('p1').inHand,true);
});
test('manual sit-out on own turn immediately folds once; cancellation of return works',()=>{
  const f=fixture(),{t}=f;t.startPlay();t.sitOut('p0');
  assert.equal(t.player('p0').folded,true);assert.equal(t.actor,'p1');
  t.returnToPlay('p0');assert.equal(t.player('p0').returnPending,true);
  t.sitOut('p0');assert.equal(t.player('p0').returnPending,false);
  assert.equal(t.handHistory.filter(e=>e.kind==='fold'&&e.playerId==='p0').length,1);
});
test('already committed all-in is not folded by absence or sit-out and remains eligible for its pots',()=>{
  const f=fixture(),{t}=f;t.player('p0').stack=100;t.chipsIssued-=1900;
  t.startPlay();t.act('p0','raise',100);t.sitOut('p0');t.setConnected('p0',false);
  assert.equal(t.player('p0').folded,false);assert.equal(t.player('p0').stack,0);
  t.act('p1','call');t.act('p2','call');
  while(!t.idle){const id=t.actor,l=t.legal(id);t.act(id,l.canCheck?'check':'call');}
  assert.equal(t.player('p0').folded,false);assert.ok(t.pots[0].eligible.includes('p0'));
  assert.ok(t.viewFor('p1').players.find(p=>p.id==='p0').cards.every(c=>c!=='??'));
  assert.equal(t.accounting.reduce((n,p)=>n+p.net,0),0);
});
test('cash sitting out does not receive cards or post a voluntary straddle',()=>{
  const f=fixture(4,{straddleAllowed:true}),{t}=f;t.setStraddle('p3',true);t.sitOut('p3');t.startPlay();
  const p=t.player('p3');assert.equal(p.inHand,false);assert.equal(p.cards.length,0);assert.equal(p.bet,0);
  assert.equal(p.stack,2000);assert.equal(t.straddle,null);
});
test('after missing cash hands return waits for natural BB and cannot see earlier cards',()=>{
  const f=fixture(4),{t}=f;t.startPlay();t.sitOut('p1');finish(t);next(f);
  assert.equal(t.lastBigBlind,3);assert.equal(t.player('p1').inHand,false);
  t.returnToPlay('p1');finish(t);next(f);
  assert.equal(t.lastBigBlind,0);assert.equal(t.player('p1').inHand,false);assert.deepEqual(t.player('p1').cards,[]);
  finish(t);next(f);assert.equal(t.lastBigBlind,1);assert.equal(t.player('p1').inHand,true);
  assert.equal(t.player('p1').sittingOut,false);assert.equal(t.player('p1').bet,t.bigBlind);
});
test('short-handed restart gives returning cash seat BB rather than deadlocking the table',()=>{
  const f=fixture(),{t}=f;t.startPlay();t.sitOut('p0');finish(t);next(f);finish(t);
  t.sitOut('p1');assert.equal(t.nextHandAt,null);t.returnToPlay('p0');next(f);
  assert.equal(t.lastBigBlind,0);assert.equal(t.player('p0').bet,20);assert.equal(t.contenders().length,2);
});
test('two returning players can restart an otherwise empty ready lineup',()=>{
  const f=fixture(4),{t}=f;t.startPlay();t.sitOut('p0');t.sitOut('p1');finish(t);next(f);finish(t);
  t.sitOut('p2');t.sitOut('p3');assert.equal(t.nextHandAt,null);
  t.returnToPlay('p0');assert.equal(t.nextHandAt,null);t.returnToPlay('p1');next(f);
  assert.equal(t.contenders().length,2);assert.ok(['p0','p1'].includes(t.actor));t.assertChips();
});
test('tournament absence continues to post blinds and acts automatically without repeating a full timer',()=>{
  const f=fixture(3,{mode:'tournament'}),{t}=f;t.sitOut('p2');t.startPlay();
  assert.equal(t.player('p2').inHand,true);assert.equal(t.player('p2').bet,20);
  t.act('p0','call');t.act('p1','call');assert.equal(t.actor,'p2');assert.equal(t.deadline,f.now+350);
  f.at(t.deadline);t.tick();assert.equal(t.player('p2').folded,true);finish(t);next(f);
  assert.equal(t.player('p2').inHand,true);assert.equal(t.player('p2').bet,10);t.assertChips();
});
test('disconnect during a live hand does not reset or shorten the allotted turn clock',()=>{
  const f=fixture(),{t}=f;t.startPlay();const deadline=t.deadline;
  f.jump(4000);t.setConnected('p0',false);assert.equal(t.deadline,deadline);assert.equal(t.player('p0').sittingOut,false);
  f.jump(4000);t.setConnected('p0',true);assert.equal(t.deadline,deadline);
  t.act('p0','call');assert.equal(t.player('p0').sittingOut,false);
});
test('brief disconnect at showdown preserves participation and scheduled deal',()=>{
 const f=fixture(2),{t}=f;t.startPlay();finish(t);const due=t.nextHandAt;t.setConnected('p0',false);
 assert.equal(t.nextHandAt,due);assert.equal(t.player('p0').sittingOut,false);
 t.setConnected('p0',true);next(f);assert.equal(t.handId,2);
});
test('absent player stays eligible until their action deadline then requires explicit return',()=>{
 const f=fixture(4),{t}=f;t.startPlay();const absent=t.actor;t.setConnected(absent,false);const due=t.deadline;
 f.at(due);t.tick();assert.equal(t.player(absent).sittingOut,true);finish(t);next(f);
 assert.equal(t.handId,2);assert.equal(t.player(absent).inHand,false);
});
test('pause takes effect only after settlement, and resume gives a fresh full countdown',()=>{
  const f=fixture(),{t}=f;t.startPlay();const deadline=t.deadline;t.setPaused(true);
  assert.equal(t.deadline,deadline);assert.equal(t.phase,'preflop');finish(t);
  assert.equal(t.nextHandAt,null);f.jump(50000);assert.equal(t.tick(),false);assert.equal(t.handId,1);
  t.setPaused(false);assert.equal(t.nextHandAt,f.now+6000);next(f);assert.equal(t.handId,2);
});
test('tournament pause freezes level time only after the live hand finishes',()=>{
  const f=fixture(3,{mode:'tournament',levelMinutes:1,turnMs:120000}),{t}=f;t.startPlay();
  f.jump(20000);t.setPaused(true);f.jump(10000);finish(t);f.jump(180000);
  t.setPaused(false);next(f);assert.equal(t.level,0);assert.equal(t.bigBlind,20);
});
test('last completed hand remains readable after auto-deal with per-viewer card privacy',()=>{
  const f=fixture(),{t}=f;t.startPlay();const own=[...t.player('p0').cards];finish(t);next(f);
  const a=t.viewFor('p0'),b=t.viewFor('p1');assert.equal(a.lastHand.handId,1);assert.equal(a.handId,2);
  assert.deepEqual(a.lastHand.players.find(p=>p.id==='p0').cards,own);
  assert.deepEqual(b.lastHand.players.find(p=>p.id==='p0').cards,['??','??']);
  assert.equal(a.lastHand.deck,undefined);assert.equal(a.lastHand.rngState,undefined);
  a.lastHand.players[0].cards[0]='XX';assert.notEqual(t.lastHand.players[0].cards[0],'XX');
  assert.equal(a.lastHand.accounting.reduce((sum,p)=>sum+p.net,0),0);
});
test('late action at the exact deadline is rejected, then timeout is applied once',()=>{
  const f=fixture(),{t}=f;t.startPlay();f.at(t.deadline);
  assert.throws(()=>t.act('p0','call'),/истекло/);t.tick();const version=t.version;
  assert.equal(t.player('p0').sittingOut,true);assert.equal(t.tick(),false);assert.equal(t.version,version);
});
test('an error halt disables action and auto-deal instead of looping retries',()=>{
  const f=fixture(),{t}=f;t.startPlay();finish(t);t.halt();f.jump(999999);
  assert.equal(t.tick(),false);assert.equal(t.handId,1);assert.equal(t.nextHandAt,null);
  assert.throws(()=>t.startHand(),/остановлен/);assert.throws(()=>t.setPaused(false),/недоступна/);
});
test('autoplay stops when a tournament has a winner',()=>{
  const f=fixture(2,{mode:'tournament'}),{t}=f;t.startPlay();
  t.act(t.actor,'raise',2000);t.act(t.actor,'call');
  if(!t.tournamentOver) { // deterministic settlement of a rare tied first board for this lifecycle check
    t.player('p0').stack+=t.player('p1').stack;t.player('p1').stack=0;t.tournamentOver=true;t.championId='p0';t.syncNextHand();
  }
  assert.equal(t.nextHandAt,null);f.jump(100000);assert.equal(t.tick(),false);t.assertChips();
});

test('a new or rejoining cash seat after game start waits for BB rather than entering for free',()=>{
  const f=fixture(),{t}=f;t.startPlay();finish(t);t.addPlayer('p3','New');
  assert.equal(t.player('p3').missedHands,true);next(f);
  assert.equal(t.lastBigBlind,3);assert.equal(t.player('p3').bet,20);t.assertChips();
});

test('up to 500 mixed sit-out, return and timeout hands preserve chips and make bounded progress',()=>{
  let seed=8315;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(const mode of ['cash','tournament']) {
    const f=fixture(6,{mode,turnMs:1000}),{t}=f;t.startPlay();let finished=0;
    for(let step=0;step<30000 && finished<250 && !t.tournamentOver;step++) {
      if(t.idle) {
        finished++;
        for(const p of t.players) {
          if(mode==='cash' && p.stack===0)t.topUp(p.id);
          if(p.sittingOut && p.stack>0 && rand(3)>0)t.returnToPlay(p.id);
        }
        t.syncNextHand();
        if(t.nextHandAt===null) {
          for(const p of t.players)if(p.sittingOut && p.stack>0)t.returnToPlay(p.id);
          t.syncNextHand();
        }
        if(t.nextHandAt!==null)next(f);else break;
      } else {
        const id=t.actor,p=t.player(id),l=t.legal(id),r=rand(100);
        if(p.sittingOut || r<9){f.at(t.deadline);t.tick();}
        else if(r<20)t.sitOut(id);
        else if(r<35)t.act(id,'fold');
        else t.act(id,l.canCheck?'check':'call');
      }
      t.assertChips();
      if(!t.idle)assert.ok(t.actor && !t.player(t.actor).folded && t.player(t.actor).stack>0);
    }
    assert.ok(finished>=10 || t.tournamentOver,`${mode} failed to progress`);
    if(mode==='cash')assert.equal(finished,250);
  }
});
