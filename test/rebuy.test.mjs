import test from 'node:test';
import assert from 'node:assert/strict';
import {Table, MAX_TABLE_CHIPS} from '../lib/poker.mjs';
function setup(options={}) {
 let now=1000;const t=new Table({turnMs:30000,...options,now:()=>now});
 t.addPlayer('a','Арман');t.addPlayer('b','Бек');t.addPlayer('c','Саян');
 return {t,at:value=>now=value,get now(){return now;}};
}
function finish(t){for(let i=0;i<40&&!t.idle;i++){const l=t.legal(t.actor);t.act(t.actor,l.canCheck?'check':'call');}assert.equal(t.phase,'showdown');}
test('review freezes the remaining turn time and resumes without extending it to a full turn',()=>{
 const f=setup(),t=f.t;t.startPlay();f.at(6000);const remaining=t.deadline-f.now;
 t.requestRebuy('a',5000,'request-arm-01');t.beginRebuyReview('review-admin-01');
 assert.equal(t.deadline,null);assert.equal(t.viewFor(t.actor).legal,null);
 const frozen=t.serialize();f.at(90000);assert.equal(t.tick(),false);assert.deepEqual(t.serialize(),frozen);
 assert.throws(()=>t.act(t.actor,'fold'),/приостановлена/);
 assert.throws(()=>t.sitOut(t.actor),/приостановлена/);
 t.endRebuyReview('review-admin-01');assert.equal(t.deadline,f.now+remaining);
});
test('approved cash rebuy during an all-in cannot change eligibility or the current pots',()=>{
 const f=setup(),t=f.t;t.startPlay();const allIn=t.actor;
 t.act(allIn,'raise',t.legal(allIn).maxTo);assert.equal(t.player(allIn).stack,0);
 const pot=t.pot,contribution=t.player(allIn).total,issued=t.chipsIssued;
 t.requestRebuy(allIn,5000,'request-allin-01');t.beginRebuyReview('review-admin-01');t.decideRebuy('request-allin-01',true);
 assert.equal(t.player(allIn).stack,0);assert.equal(t.player(allIn).pendingBuyIn,5000);
 assert.equal(t.player(allIn).total,contribution);assert.equal(t.pot,pot);assert.equal(t.chipsIssued,issued+5000);
 assert.equal(t.player(allIn).folded,false);t.assertChips();
 t.endRebuyReview('review-admin-01');finish(t);
 assert.equal(t.player(allIn).stack,t.lastHand.players.find(p=>p.id===allIn).stack+5000);
 assert.equal(t.player(allIn).pendingBuyIn,0);assert.equal(t.players.reduce((n,p)=>n+p.stack,0),issued+5000);
 assert.throws(()=>t.decideRebuy('request-allin-01',true));
});
test('request and review recover with the original remaining clock; abandoned review cannot deadlock the table',()=>{
 const f=setup(),t=f.t;t.startPlay();f.at(3000);
 t.requestRebuy('b',123456789012,'request-large-01');t.beginRebuyReview('review-admin-01');
 const saved=t.serialize(),restored=Table.restore(saved,()=>f.now);
 assert.deepEqual(restored.rebuyRequests,t.rebuyRequests);
 const expiry=restored.rebuyReview.expiresAt,remaining=restored.rebuyReview.deadlineRemaining;
 f.at(expiry);restored.tick();assert.equal(restored.rebuyReview,null);assert.equal(restored.deadline,expiry+remaining);
 assert.equal(restored.rebuyRequests.length,1);assert.equal(restored.player('b').stack,2000);
 restored.beginRebuyReview('review-admin-02');restored.endRebuyReview('review-admin-01');assert.equal(restored.rebuyReview.id,'review-admin-02');
});
test('large unequal all-ins preserve integer chips, side pots, awards and refunds',()=>{
 const f=setup({startingStack:1_000_000_000_001,buyInMode:'range',minBuyIn:400,maxBuyIn:3_000_000_000_000}),t=f.t;
 t.player('a').stack=500_000_000_001;t.player('b').stack=1_000_000_000_007;t.player('c').stack=2_000_000_000_013;
 t.chipsIssued=t.players.reduce((n,p)=>n+p.stack,0);const total=t.chipsIssued;t.startPlay();
 while(!t.idle){const l=t.legal(t.actor);t.act(t.actor,l.canRaise?'raise':l.canCheck?'check':'call',l.canRaise?l.maxTo:null);}
 assert.ok(t.pots.length>=2);assert.equal(t.players.reduce((n,p)=>n+BigInt(p.stack),0n),BigInt(total));
 assert.equal(t.pots.reduce((n,p)=>n+p.amount,0)+t.refunds.reduce((n,r)=>n+r.amount,0),t.committedPot);
 assert.equal(t.accounting.reduce((n,p)=>n+p.net,0),0);t.assertChips();
});
test('technical precision boundary and invalid quantities fail without changing chips',()=>{
 const t=new Table({startingStack:MAX_TABLE_CHIPS/2});t.addPlayer('a','A');t.addPlayer('b','B');const before=t.serialize();
 for(const amount of [1,-1,0,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>t.requestRebuy('a',amount,'invalid-request-01'));
 assert.deepEqual(t.serialize(),before);assert.throws(()=>t.topUp('a',1));assert.deepEqual(t.serialize(),before);
});
test('rebuy is not restricted by fixed buy-in, remaining stack or old rebuy setting, including tournaments',()=>{
 const f=setup({rebuyAllowed:false}),t=f.t;t.requestRebuy('a',10_000_000_000,'request-arm-01');t.beginRebuyReview('review-admin-01');t.decideRebuy('request-arm-01',true);
 assert.equal(t.player('a').stack,10_000_002_000);assert.equal(t.chipsIssued,10_000_006_000);
 const tournament=setup({mode:'tournament'}).t;tournament.requestRebuy('a',5000,'request-arm-02');tournament.beginRebuyReview('review-tourney-02');tournament.decideRebuy('request-arm-02',true);assert.equal(tournament.player('a').stack,7000);
});

test('tournament review freezes level clock, and new seats cannot affect current pots',()=>{
 const f=setup({mode:'tournament',levelMinutes:1}),t=f.t;t.startPlay();
 f.at(10000);t.beginRebuyReview('review-admission-01',['Новый']);
 const before=t.levelAt();f.at(100000);assert.equal(t.levelAt(),before);
 t.addPlayer('new','Новый',{unfunded:true});t.topUp('new',5000,'buyIn');
 assert.equal(t.player('new').inHand,false);assert.equal(t.player('new').stack,0);
 t.endRebuyReview('review-admission-01');assert.equal(t.levelAt(),before);
 finish(t);assert.equal(t.player('new').stack,5000);assert.ok(!t.accounting.some(p=>p.id==='new'));t.assertChips();
});
test('approved reentry can resume a finished tournament without replaying old cards',()=>{
 let now=1000;const t=new Table({mode:'tournament',now:()=>now});
 t.addPlayer('a','А');t.addPlayer('b','Б');t.startedAt=0;t.running=true;
 t.player('a').stack=4000;t.player('b').stack=0;t.tournamentOver=true;t.tournamentEndedAt=1000;t.championId='a';
 now=61000;t.requestRebuy('b',2000,'request-reentry-01','reentry');t.beginRebuyReview('review-reentry-01');
 now=71000;t.decideRebuy('request-reentry-01',true);t.endRebuyReview('review-reentry-01');
 assert.equal(t.tournamentOver,false);assert.equal(t.championId,null);assert.equal(t.startedAt,70000);assert.equal(t.player('b').stack,2000);t.assertChips();
});
