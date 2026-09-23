import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localStore} from '../lib/local-store.mjs';
import {GameService} from '../lib/service.mjs';
import {Table} from '../lib/poker.mjs';
const schema=await readFile(new URL('../db/schema.sql',import.meta.url),'utf8');
const uid=()=>crypto.randomUUID();
async function fixture(options={}){
 const db=await localStore('memory://');await db.exec(schema);let now=100000;
 const s=new GameService(db,{now:()=>now});const a={id:uid(),name:'A'},b={id:uid(),name:'B'};
 const {roomId}=await s.create(a,options);const view=await s.peek(roomId,a.id);
 await s.join(b,{code:view.room.code});
 const cmd=async(u,action,extra={})=>{const v=await s.peek(roomId,u.id);return s.command(u,{roomId,requestId:uid(),action,handId:v.table.handId,version:v.table.version,...extra});};
 const review=await cmd(a,'beginRebuyReview');
 await cmd(a,'approveRebuy',{rebuyRequestId:view.table.rebuyRequests[0].id});
 await cmd(a,'approve',{userId:b.id});
 await cmd(a,'endRebuyReview',{reviewId:review.reviewId});
 return {db,s,a,b,roomId,cmd,at:n=>now=n,get now(){return now;}};
}
async function finish(f){for(let i=0;i<30;i++){const p=await f.s.peek(f.roomId,f.a.id);if(p.table.phase==='showdown')return p;const u=p.table.actor===f.a.id?f.a:f.b;const v=await f.s.peek(f.roomId,u.id);await f.cmd(u,'act',{move:v.table.legal.canCheck?'check':'call'});}throw Error('hand did not settle');}
test('durable commands: duplicate, conflicting reuse, race, cash pending, auto-deal and private projections',async()=>{
 const f=await fixture();try{
 await f.cmd(f.a,'start');const before=await f.s.peek(f.roomId,f.a.id);
 const payload={roomId:f.roomId,requestId:uid(),action:'act',move:'call',handId:before.table.handId,version:before.table.version};
 const race=await Promise.allSettled([f.s.command(f.a,payload),f.s.command(f.a,{...payload,requestId:uid()})]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.find(x=>x.status==='rejected').reason.status,409);
 assert.equal((await f.s.command(f.a,payload)).duplicate,true);
 await assert.rejects(f.s.command(f.a,{...payload,move:'fold'}),/другим содержимым/);
 await assert.rejects(f.cmd(f.b,'blinds',{smallBlind:20,bigBlind:40}),/хозяину/);
 await f.cmd(f.a,'blinds',{smallBlind:20,bigBlind:40});let v=await f.s.peek(f.roomId,f.a.id);
 assert.equal(v.table.bigBlind,20);assert.equal(v.table.pendingBlinds.bigBlind,40);
 const end=await finish(f);f.at(end.table.nextHandAt);await Promise.all([f.s.tick(),f.s.tick()]);
 v=await f.s.peek(f.roomId,f.a.id);assert.equal(v.table.handId,2);assert.equal(v.table.bigBlind,40);assert.equal(v.table.pendingBlinds,null);
 const events=await f.db.query("select event from private.events where event->>'kind' in ('blindsPending','blindsApplied','deal')");assert.equal(events.rows.length,4);
 const views=await f.db.query('select user_id,payload from public.svoi_views');
 for(const r of views.rows){assert.equal(r.payload.table.deck,undefined);assert.deepEqual(r.payload.table.players.find(p=>p.id!==r.user_id).cards,['??','??']);}
 }finally{await f.db.close();}
});
test('disk recovery restores cards, deck, sessions, deadlines and dedup receipts',async()=>{
 const path=await mkdtemp(join(tmpdir(),'svoi-recovery-'));let db=await localStore(path);await db.exec(schema);let now=100000;
 try{
 let s=new GameService(db,{now:()=>now});const login=await s.login('A');const a=login.user,b={id:uid(),name:'B'};
 const {roomId}=await s.create(a,{turnSeconds:10});const v=await s.peek(roomId,a.id);await s.join(b,{code:v.room.code});
 const review=await s.command(a,{roomId,action:'beginRebuyReview',requestId:uid()});
 await s.command(a,{roomId,action:'approveRebuy',rebuyRequestId:v.table.rebuyRequests[0].id,requestId:uid()});
 await s.command(a,{roomId,action:'approve',userId:b.id,requestId:uid()});
 await s.command(a,{roomId,action:'endRebuyReview',reviewId:review.reviewId,requestId:uid()});
 const ready=await s.peek(roomId,a.id);const d={roomId,action:'start',requestId:uid(),handId:0,version:ready.table.version};await s.command(a,d);
 const before=await s.peek(roomId,a.id);const rawBefore=(await db.query('select state from private.rooms')).rows[0].state;
 await db.close();db=await localStore(path);s=new GameService(db,{now:()=>now});
 const after=await s.peek(roomId,a.id);assert.deepEqual(after.table,before.table);assert.deepEqual((await db.query('select state from private.rooms')).rows[0].state.table.deck,rawBefore.table.deck);
 assert.equal((await s.session(login.token)).user.id,a.id);assert.equal((await s.command(a,d)).duplicate,true);
 now=before.table.deadline;await s.tick();const timed=await s.peek(roomId,a.id);assert.equal(timed.table.players.find(p=>p.id===a.id).sittingOut,true);assert.equal(timed.table.phase,'showdown');
 await s.tick();assert.equal((await s.peek(roomId,a.id)).table.handId,1);
 }finally{await db.close();await rm(path,{recursive:true,force:true});}
});
test('tournament clock advances across custom levels only at a hand boundary and survives serialization',()=>{
 let now=0;const t=new Table({mode:'tournament',startingStack:10000,turnMs:120000,levels:[{smallBlind:25,bigBlind:50,durationMinutes:1},{smallBlind:50,bigBlind:100,durationMinutes:2},{smallBlind:100,bigBlind:200,durationMinutes:3}],now:()=>now});
 t.addPlayer('a','A');t.addPlayer('b','B');t.startPlay();now=61000;
 assert.equal(t.smallBlind,25);assert.equal(t.viewFor('a').pendingLevel,1);assert.equal(t.viewFor('a').levelEndsAt,60000);
 t.act(t.actor,'fold');const restored=Table.restore(t.serialize(),()=>now);now=restored.nextHandAt;restored.tick();assert.equal(restored.level,1);assert.equal(restored.bigBlind,100);
 now=180000;assert.equal(restored.bigBlind,100);restored.act(restored.actor,'fold');now=restored.nextHandAt;restored.tick();assert.equal(restored.level,2);assert.equal(restored.bigBlind,200);
 restored.act(restored.actor,'fold');assert.throws(()=>restored.setStraddle('a',true),/запрещён/);
 assert.throws(()=>new Table({mode:'tournament',levels:[{smallBlind:10,bigBlind:20,durationMinutes:1,bbAnte:20}]}),/Анте/);
});
test('initial range buy-in remains bounded; approved rebuys can exceed it',()=>{
 const t=new Table({startingStack:2000,buyInMode:'range',minBuyIn:1000,maxBuyIn:6000});t.addPlayer('a','A',{buyIn:3500});
 assert.throws(()=>t.addPlayer('x','X',{buyIn:999999}),/диапазона/);t.topUp('a',2500);assert.equal(t.player('a').stack,6000);assert.equal(t.chipsIssued,6000);
 t.topUp('a',1);assert.equal(t.player('a').stack,6001);t.rebuyAllowed=false;t.topUp('a',1);assert.equal(t.player('a').stack,6002);t.assertChips();
});
test('RLS denies anonymous, other identities, writes and direct private-state reads',async()=>{
 const f=await fixture();try{
 await f.db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;grant usage on schema public to authenticated;`);
 await f.db.exec('grant all on public.svoi_views to anon,authenticated');
 const sql=await readFile(new URL('../db/supabase.sql',import.meta.url),'utf8');await f.db.exec(sql.slice(0,sql.indexOf('do $$')));
 await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",[f.a.id]);await f.db.exec('set role authenticated');
 let rows=(await f.db.query('select * from public.svoi_views')).rows;assert.equal(rows.length,1);assert.equal(rows[0].user_id,f.a.id);
 await assert.rejects(f.db.query('select state from private.rooms'),/permission denied/);
 await assert.rejects(f.db.query("update public.svoi_views set payload='{}'"),/permission denied/);
 await f.db.exec('reset role');await f.db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid()]);await f.db.exec('set role authenticated');assert.equal((await f.db.query('select * from public.svoi_views')).rows.length,0);
 await f.db.exec('reset role;set role anon');await assert.rejects(f.db.query('select * from public.svoi_views'),/permission denied/);
 }finally{await f.db.exec('reset role');await f.db.close();}
});

test('only owner can approve a request; legacy topUp and duplicate approval cannot mint chips',async()=>{
 const f=await fixture();try{
 await f.cmd(f.a,'start');const first=await f.s.peek(f.roomId,f.a.id),issued=first.table.players.reduce((n,p)=>n+p.stack+p.total,0);
 const requestId=uid(),rebuyRequestId=`${f.b.id}:${requestId}`;await f.cmd(f.b,'topUp',{amount:5000,requestId});
 let view=await f.s.peek(f.roomId,f.b.id);assert.equal(view.table.players.reduce((n,p)=>n+p.stack+p.total,0),issued);
 await assert.rejects(f.cmd(f.b,'beginRebuyReview'),/хозяину/);
 await f.cmd(f.a,'beginRebuyReview');
 await assert.rejects(f.cmd(f.b,'approveRebuy',{rebuyRequestId}),/хозяину/);
 const approval={roomId:f.roomId,action:'approveRebuy',rebuyRequestId,requestId:uid()};
 const results=await Promise.all([f.s.command(f.a,approval),f.s.command(f.a,approval)]);
 assert.equal(results.filter(r=>r.duplicate).length,1);
 view=await f.s.peek(f.roomId,f.b.id);assert.equal(view.table.players.find(p=>p.id===f.b.id).pendingBuyIn,5000);
 const other={...approval,requestId:uid()};await assert.rejects(f.s.command(f.a,other),/обработан/);
 const raw=(await f.db.query('select state from private.rooms where id=$1',[f.roomId])).rows[0].state;
 assert.equal(raw.table.chipsIssued,issued+5000);assert.equal(raw.table.rebuyRequests.length,0);
 }finally{await f.db.close();}
});

test('every initial buy-in, including owner, requires explicit admin approval',async()=>{
 const db=await localStore('memory://');await db.exec(schema);
 try{
  const s=new GameService(db),a={id:uid(),name:'Админ'},b={id:uid(),name:'Друг'};
  const {roomId}=await s.create(a,{mode:'tournament'});
  let v=await s.peek(roomId,a.id);assert.equal(v.table.players[0].stack,0);
  const initial=v.table.rebuyRequests[0];assert.equal(initial.fundingType,'buyIn');
  const command=(user,action,extra={})=>s.command(user,{roomId,requestId:uid(),action,...extra});
  await s.join(b,{code:v.room.code});
  await assert.rejects(command(a,'approve',{userId:b.id}),/окно/);
  await assert.rejects(command(a,'approveRebuy',{rebuyRequestId:initial.id}),/окно/);
  const review=await command(a,'beginRebuyReview');
  await command(a,'approve',{userId:b.id});
  await assert.rejects(command(b,'approveRebuy',{rebuyRequestId:initial.id}),/хозяину/);
  await command(a,'approveRebuy',{rebuyRequestId:initial.id});
  await assert.rejects(command(a,'approveRebuy',{rebuyRequestId:initial.id}),/обработан/);
  await command(a,'endRebuyReview',{reviewId:review.reviewId});
  v=await s.peek(roomId,a.id);assert.equal(v.table.players.reduce((n,p)=>n+p.stack,0),4000);
 }finally{await db.close();}
});
