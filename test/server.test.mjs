import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const port=3197,base=`http://localhost:${port}`;
let child; const connections=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function request(path,token,data) {
  const res=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {status:res.status,...await res.json()};
}
async function login(name) {return request('/api/session',null,{name});}
async function cmd(roomId,token,action,extra={}) {if(action==='approve'||action==='deny'){const review=await cmd(roomId,token,'beginRebuyReview');if(review.status!==200)return review;const snap=await peek(roomId,token);const initial=snap.table.rebuyRequests.find(q=>q.playerId===snap.me&&q.fundingType==='buyIn');if(initial)await cmd(roomId,token,'approveRebuy',{rebuyRequestId:initial.id});const result=await request('/api/command',token,{roomId,action,requestId:randomUUID(),...extra});await cmd(roomId,token,'endRebuyReview',{reviewId:review.reviewId});return result;}const v=['start','topUp','straddle','sitOut','returnToPlay','pause'].includes(action)?(await peek(roomId,token)).table:null;return request('/api/command',token,{roomId,action,requestId:randomUUID(),...(v?{handId:v.handId,version:v.version}:{}),...extra});}
async function peek(roomId,token) {return request(`/api/room?room=${roomId}`,token);}
async function stream(roomId,token) {
  const controller=new AbortController();connections.push(controller);
  const response=await fetch(`${base}/api/events?room=${roomId}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
  assert.equal(response.status,200);
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  return {close:()=>controller.abort(),async next(predicate=()=>true) {
    const timeout=setTimeout(()=>controller.abort(),4000);
    try {while(true) {
      let boundary;
      while((boundary=buffer.indexOf('\n\n'))>=0) {
        const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
        if(block.startsWith('data: ')) {const data=JSON.parse(block.slice(6));if(predicate(data)) return data;}
      }
      const {done,value}=await reader.read();if(done) throw new Error('Stream ended');buffer+=decoder.decode(value,{stream:true});
    }} finally {clearTimeout(timeout);}
  }};
}
before(async()=>{
  child=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,DATA_DIR:'memory://',PORT:String(port),PUBLIC_ORIGIN:base,HOST:'127.0.0.1',NODE_ENV:'development',AUTH_MODE:'dev',ALLOWED_TELEGRAM_IDS:''},stdio:['ignore','pipe','pipe']});
  let diagnostics='';child.stderr.on('data',b=>diagnostics+=b);
  for(let i=0;i<1500;i++){try{const r=await fetch(base+'/health');if(r.ok)return;}catch{}await pause(40);}throw new Error('Test server did not start: '+diagnostics);
});
after(async()=>{for(const c of connections)c.abort();if(child&&!child.killed){child.kill('SIGTERM');await pause(100);}});

test('private multiplayer lifecycle: approval, privacy, moves, reconnect, revocation',async()=>{
  const alice=await login('Алиса'),bob=await login('Боб'),eve=await login('Посторонний');
  const created=await request('/api/rooms',alice.token,{name:'Тестовый стол'});assert.equal(created.status,200);const id=created.roomId;
  const initial=await peek(id,alice.token),code=new URL(initial.room.invite).searchParams.get('room');
  assert.equal((await peek(id,eve.token)).status,403);
  assert.equal((await request(`/api/room?room=${id}`)).status,401);
  assert.equal((await request('/api/join',bob.token,{code})).status,200);
  const pending=await peek(id,bob.token);assert.equal(pending.type,'pending');assert.equal(pending.table,undefined);
  assert.equal((await cmd(id,bob.token,'start')).status,403);
  const as=await stream(id,alice.token),bs=await stream(id,bob.token);
  assert.equal((await bs.next()).type,'pending');
  assert.equal((await cmd(id,alice.token,'approve',{userId:bob.user.id})).status,200);
  assert.equal((await bs.next(p=>p.type==='state')).table.players.length,2);
  assert.equal((await cmd(id,bob.token,'start')).status,403);
  assert.equal((await cmd(id,alice.token,'start')).status,200);
  const a=await peek(id,alice.token),b=await peek(id,bob.token);
  assert.equal(a.table.actor,alice.user.id);
  assert.deepEqual(a.table.players.find(p=>p.id===bob.user.id).cards,['??','??']);
  assert.deepEqual(b.table.players.find(p=>p.id===alice.user.id).cards,['??','??']);
  assert.ok(a.table.players.find(p=>p.id===alice.user.id).cards.every(c=>c!=='??'));assert.equal(a.table.deck,undefined);
  assert.equal((await cmd(id,bob.token,'act',{move:'fold',handId:a.table.handId,version:a.table.version})).status,400);
  const payload={roomId:id,action:'act',move:'call',handId:a.table.handId,version:a.table.version,requestId:randomUUID()};
  assert.equal((await request('/api/command',alice.token,payload)).status,200);
  assert.equal((await request('/api/command',alice.token,payload)).duplicate,true);
  assert.equal((await cmd(id,bob.token,'act',{move:'check',handId:a.table.handId,version:a.table.version})).status,409);
  let current=await peek(id,bob.token);
  assert.equal((await cmd(id,bob.token,'act',{move:'check',handId:current.table.handId,version:current.table.version})).status,200);
  current=await peek(id,alice.token);assert.equal(current.table.phase,'flop');assert.equal(current.table.board.length,3);
  // Same authenticated identity reconnects, gets its own cards and current hand.
  as.close();const reconnect=await stream(id,alice.token),restored=await reconnect.next(p=>p.type==='state');
  assert.equal(restored.table.handId,current.table.handId);assert.equal(restored.table.phase,'flop');
  assert.deepEqual(restored.table.players.find(p=>p.id===alice.user.id).cards,a.table.players.find(p=>p.id===alice.user.id).cards);
  assert.deepEqual(restored.table.players.find(p=>p.id===bob.user.id).cards,['??','??']);
  for(let i=0;i<12;i++) {
    current=await peek(id,alice.token);if(current.table.phase==='showdown')break;
    const actorToken=current.table.actor===alice.user.id?alice.token:bob.token;
    const view=await peek(id,actorToken);
    assert.equal((await cmd(id,actorToken,'act',{move:view.table.legal.canCheck?'check':'call',handId:view.table.handId,version:view.table.version})).status,200);
  }
  current=await peek(id,alice.token);assert.equal(current.table.phase,'showdown');assert.equal(current.table.players.reduce((s,p)=>s+p.stack,0),4000);
  assert.ok(current.table.players.every(p=>p.cards.every(c=>c!=='??')));
  assert.equal((await cmd(id,alice.token,'lock')).status,200);
  assert.equal((await request('/api/join',eve.token,{code})).status,403);
  assert.equal((await cmd(id,alice.token,'rotateInvite')).status,200);
  assert.equal((await request('/api/join',eve.token,{code})).status,404);
  assert.equal((await cmd(id,alice.token,'kick',{userId:bob.user.id})).status,200);
  assert.equal((await peek(id,bob.token)).status,403);
  assert.equal((await cmd(id,alice.token,'close')).status,200);
  assert.equal((await peek(id,alice.token)).status,404);
});
test('new player IDs cannot be selected by a client',async()=>{
  const a=await request('/api/session',null,{name:'A',id:'tg:1'}),b=await request('/api/session',null,{name:'B',id:'tg:1'});
  assert.notEqual(a.user.id,'tg:1');assert.notEqual(a.user.id,b.user.id);
});
test('HTTP origin and content-type validation',async()=>{
  const r=await fetch(base+'/api/session',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
  const s=await fetch(base+'/api/session',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'});assert.equal(s.status,415);
});

test('server rejects forged deck/stack fields, stale starts and requestId reuse with changed payload',async()=>{
  const a=await login('Security A'),b=await login('Security B');
  const c=await request('/api/rooms',a.token,{}),id=c.roomId;
  const first=await peek(id,a.token),code=new URL(first.room.invite).searchParams.get('room');
  await request('/api/join',b.token,{code});await stream(id,a.token);await stream(id,b.token);await cmd(id,a.token,'approve',{userId:b.user.id});
  let view=await peek(id,a.token);
  const start={roomId:id,action:'start',requestId:randomUUID(),handId:view.table.handId,version:view.table.version};
  assert.equal((await request('/api/command',a.token,{...start,deck:['As','Ah']})).status,400);
  assert.equal((await request('/api/command',a.token,start)).status,200);
  assert.equal((await request('/api/command',a.token,start)).duplicate,true);
  assert.equal((await request('/api/command',a.token,{...start,action:'topUp'})).status,409);
  view=await peek(id,a.token);
  assert.equal((await cmd(id,a.token,'act',{handId:view.table.handId,version:view.table.version,move:'fold',stack:9999999})).status,400);
  assert.equal((await cmd(id,a.token,'act',{handId:view.table.handId,version:view.table.version,move:'fold'})).status,200);
  assert.equal((await request('/api/command',a.token,{...start,requestId:randomUUID()})).status,409);
  assert.equal((await peek(id,a.token)).table.handId,1);
  await cmd(id,a.token,'close');
});

test('HTTP enforces tournament rules and exposes safe per-pot accounting',async()=>{
  const a=await login('Tournament A'),b=await login('Tournament B');
  assert.equal((await request('/api/rooms',a.token,{mode:'tournament',straddleAllowed:true})).status,400);
  const c=await request('/api/rooms',a.token,{mode:'tournament'}),id=c.roomId;
  const first=await peek(id,a.token),code=new URL(first.room.invite).searchParams.get('room');
  await request('/api/join',b.token,{code});await stream(id,a.token);await stream(id,b.token);await cmd(id,a.token,'approve',{userId:b.user.id});
  assert.equal((await cmd(id,a.token,'straddle',{enabled:true})).status,400);
  assert.equal((await cmd(id,a.token,'start')).status,200);
  let v=await peek(id,a.token);
  assert.equal((await cmd(id,a.token,'act',{handId:v.table.handId,version:v.table.version,move:'raise',amount:2000})).status,200);
  v=await peek(id,b.token);
  assert.equal((await cmd(id,b.token,'act',{handId:v.table.handId,version:v.table.version,move:'call'})).status,200);
  v=await peek(id,a.token);
  assert.equal(v.table.phase,'showdown');assert.equal(v.table.mode,'tournament');
  assert.equal(v.table.accounting.reduce((s,p)=>s+p.net,0),0);
  assert.equal(v.table.pots[0].awards.reduce((s,p)=>s+p.amount,0),4000);
  assert.equal(v.table.deck,undefined);assert.equal(v.table.rngState,undefined);
  assert.ok(!JSON.stringify(v.table.handHistory).includes('BOT_TOKEN'));
  assert.equal((await cmd(id,a.token,'topUp')).status,200);
});

async function waitState(id,token,predicate,maxMs=8500) {
  const until=Date.now()+maxMs;
  while(Date.now()<until){const s=await peek(id,token);if(predicate(s))return s;await pause(180);}
  throw new Error('Timed out waiting for table state');
}
test('HTTP auto-deals without owner clicks; timeout/sit-out/return/pause are server-enforced',async()=>{
  const a=await login('Auto Owner'),b=await login('Auto B'),c=await login('Auto C');
  const players=[a,b,c],tokens=new Map(players.map(p=>[p.user.id,p.token]));
  const created=await request('/api/rooms',a.token,{turnSeconds:1}),id=created.roomId;
  const initial=await peek(id,a.token),code=new URL(initial.room.invite).searchParams.get('room');
  const ownerStream=await stream(id,a.token);
  for(const p of [b,c]) {
    await request('/api/join',p.token,{code});await stream(id,p.token);
    assert.equal((await cmd(id,a.token,'approve',{userId:p.user.id})).status,200);
  }
  assert.equal((await cmd(id,a.token,'start')).status,200);
  let s=await waitState(id,a.token,s=>s.table.players.find(p=>p.id===a.user.id).sittingOut,3000);
  assert.equal(s.table.players.find(p=>p.id===a.user.id).folded,true);
  assert.equal((await cmd(id,b.token,'act',{handId:s.table.handId,version:s.table.version,move:'fold'})).status,200);
  s=await peek(id,a.token);assert.equal(s.table.phase,'showdown');assert.notEqual(s.table.nextHandAt,null);
  // Owner closes their screen; no start command or owner browser timer is involved.
  ownerStream.close();
  s=await waitState(id,b.token,s=>s.table.handId===2);
  assert.equal(s.table.players.find(p=>p.id===a.user.id).inHand,false);
  assert.equal(s.table.players.find(p=>p.id===a.user.id).cards.length,0);
  assert.equal(s.table.lastHand.handId,1);
  assert.ok(s.table.lastHand.players.filter(p=>p.id!==b.user.id).every(p=>p.cards.every(c=>c==='??')));
  assert.equal((await cmd(id,b.token,'pause',{paused:true})).status,403);
  assert.equal((await cmd(id,b.token,'sitOut',{userId:c.user.id})).status,400);
  const restored=await stream(id,a.token);await restored.next(p=>p.type==='state');
  assert.equal((await cmd(id,a.token,'pause',{paused:true})).status,200);
  assert.equal((await cmd(id,a.token,'returnToPlay')).status,200);
  s=await peek(id,a.token);assert.equal(s.table.legal,null);
  assert.equal(s.table.players.find(p=>p.id===a.user.id).returnPending,true);
  const actorToken=tokens.get(s.table.actor);
  assert.equal((await cmd(id,actorToken,'act',{handId:s.table.handId,version:s.table.version,move:'fold'})).status,200);
  s=await peek(id,a.token);assert.equal(s.table.phase,'showdown');assert.equal(s.table.nextHandAt,null);
  assert.equal((await cmd(id,a.token,'start')).status,400);
  assert.equal((await cmd(id,a.token,'pause',{paused:false})).status,200);
  s=await peek(id,a.token);assert.ok(s.table.nextHandAt-s.table.serverNow>5000);
  // End test before the next deal; this also validates closing an auto-running idle cash table.
  assert.equal((await cmd(id,a.token,'close')).status,200);
});

test('HTTP return is idempotent, has no target-player override and rejects stale hand state',async()=>{
  const a=await login('Return A'),b=await login('Return B');
  const created=await request('/api/rooms',a.token,{}),id=created.roomId;
  const initial=await peek(id,a.token),code=new URL(initial.room.invite).searchParams.get('room');
  await stream(id,a.token);await request('/api/join',b.token,{code});await stream(id,b.token);
  await cmd(id,a.token,'approve',{userId:b.user.id});await cmd(id,a.token,'start');
  assert.equal((await cmd(id,a.token,'sitOut')).status,200);
  const state=await peek(id,a.token);
  const payload={roomId:id,action:'returnToPlay',handId:state.table.handId,version:state.table.version,requestId:randomUUID()};
  assert.equal((await request('/api/command',a.token,{...payload,userId:b.user.id})).status,400);
  assert.equal((await request('/api/command',a.token,payload)).status,200);
  assert.equal((await request('/api/command',a.token,payload)).duplicate,true);
  assert.equal((await request('/api/command',a.token,{...payload,action:'sitOut'})).status,409);
  assert.equal((await request('/api/command',a.token,{...payload,requestId:randomUUID()})).status,409);
  assert.equal((await peek(id,a.token)).table.players.find(p=>p.id===b.user.id).sittingOut,false);
  await cmd(id,a.token,'close');
});
