import {Table} from './poker.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const ensure=(condition,message,status)=>{if(!condition)fail(message,status);};
const id=()=>crypto.randomUUID();
const secret=()=>Array.from(crypto.getRandomValues(new Uint8Array(18)),x=>x.toString(16).padStart(2,'0')).join('');
const code=()=>Array.from(crypto.getRandomValues(new Uint8Array(8)),x=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x%31]).join('');
// Pass structured values to database drivers. Serializing here makes postgres.js
// encode the string again, producing a JSON string instead of a JSON object.
const json=x=>x;
export async function hash(value) {return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
const fields={start:[],act:['move','amount'],approve:['userId'],deny:['userId'],lock:[],rotateInvite:[],topUp:['amount'],requestRebuy:['amount','fundingType'],approveRebuy:['rebuyRequestId'],denyRebuy:['rebuyRequestId'],cancelRebuy:['rebuyRequestId'],beginRebuyReview:[],endRebuyReview:['reviewId'],renewRebuyReview:['reviewId'],sitOut:[],returnToPlay:[],pause:['paused'],straddle:['enabled'],kick:['userId'],leave:[],close:[],blinds:['smallBlind','bigBlind']};
export class GameService {
 constructor(db,{origin='http://localhost:3000',now=()=>Date.now()}={}){this.db=db;this.origin=origin;this.now=now;}
 async limit(key,max,ms=60000) {
  const n=this.now();const {rows}=await this.db.query(`insert into private.rate_limits(key,count,until_at) values($1,1,$2) on conflict(key) do update set count=case when private.rate_limits.until_at <= $3 then 1 else private.rate_limits.count+1 end, until_at=case when private.rate_limits.until_at <= $3 then $2 else private.rate_limits.until_at end returning count`,[key,n+ms,n]);
  ensure(rows[0].count<=max,'Слишком много запросов. Попробуйте позже',429);
 }
 async session(token) {
  if(!token)fail('Войдите в приложение заново',401);
  const {rows}=await this.db.query('select user_data,expires from private.sessions where token_hash=$1 and expires>$2',[await hash(token),this.now()]);
  ensure(rows.length,'Войдите в приложение заново',401);return {user:rows[0].user_data,expires:Number(rows[0].expires)};
 }
 async login(name,oldToken) {
  let user;try{user=(await this.session(oldToken)).user;}catch{}
  user ||= {id:id(),name:String(name||'Игрок').trim().slice(0,32)||'Игрок'};
  const token=secret()+secret(),expires=this.now()+30*86400000;
  await this.db.query('insert into private.sessions values($1,$2::text::jsonb,$3)',[await hash(token),json(user),expires]);
  return {token,user,expires};
 }
 restore(row){const r=structuredClone(row.state);r.table=Table.restore(r.table,this.now);return r;}
 snapshot(r,userId){
  if(r.closed)return {type:'closed',message:'Хозяин закрыл стол'};
  if(!r.table.player(userId))return r.pending[userId]?{type:'pending',roomId:r.id,roomName:r.name,message:'Хозяин стола должен подтвердить вход'}:{type:'denied',message:'Нет доступа к комнате'};
  return {type:'state',me:userId,room:{id:r.id,name:r.name,ownerId:r.ownerId,locked:r.locked,invite:userId===r.ownerId?`${this.origin}/?room=r${r.id}_${r.inviteToken}`:null,code:userId===r.ownerId?r.code:null,inviteExpires:userId===r.ownerId?r.inviteExpires:null,pending:userId===r.ownerId?Object.values(r.pending).map(p=>({id:p.id,name:p.name,buyIn:p.buyIn})):[]},table:r.table.viewFor(userId)};
 }
 async save(tx,r) {
  const t=r.table; t.assertChips();
  const due=r.closed?null:(t.rebuyReview?.expiresAt??t.deadline??t.nextHandAt);
  await tx.query('update private.rooms set state=$2::text::jsonb,invite_token=$3,short_code=$4,due_at=$5,revision=revision+1,updated_at=now() where id=$1',[r.id,json({...r,table:t.serialize()}),r.inviteToken,r.code,due]);
  for(const e of t.history)await tx.query('insert into private.events values($1,$2,$3,$4::text::jsonb) on conflict do nothing',[r.id,e.id,e.handId,json(e)]);
  const {rows}=await tx.query('select revision from private.rooms where id=$1',[r.id]);
  const members=new Set([...t.players.map(p=>p.id),...Object.keys(r.pending)]);
  const old=await tx.query('select user_id from public.svoi_views where room_id=$1',[r.id]);
  for(const row of old.rows)members.add(row.user_id); // deliver revocation without ever exposing a table
  for(const u of members)await tx.query('insert into public.svoi_views values($1,$2,$3,$4::text::jsonb) on conflict(room_id,user_id) do update set revision=excluded.revision,payload=excluded.payload',[r.id,u,rows[0].revision,json(this.snapshot(r,u))]);
 }
 async create(user,data) {
  await this.limit(`create:${user.id}`,8);
  const opts={smallBlind:data.smallBlind??10,bigBlind:data.bigBlind??20,startingStack:data.startingStack??2000,mode:data.mode??'cash',straddleAllowed:data.straddleAllowed??false,levelMinutes:data.levelMinutes??10,maxPlayers:data.maxPlayers??6,turnMs:(data.turnSeconds??30)*1000,buyInMode:data.buyInMode??'fixed',minBuyIn:data.minBuyIn??data.startingStack??2000,maxBuyIn:data.maxBuyIn??data.startingStack??2000,rebuyAllowed:data.rebuyAllowed??true,levels:data.levels??null,now:this.now};
  const t=new Table(opts);t.addPlayer(user.id,user.name,{unfunded:true});t.requestRebuy(user.id,t.startingStack,id(),'buyIn');
  const r={id:id().replaceAll('-','').slice(0,12),name:String(data.name||'Свои за столом').trim().slice(0,50),ownerId:user.id,inviteToken:secret(),code:code(),inviteExpires:this.now()+8*3600000,pending:{},locked:false,closed:false,table:t};
  await this.db.transaction(async tx=>{
   // Serialize creation per user as well as room commands, enforcing room caps under races.
   await tx.query('insert into private.rate_limits values($1,0,0) on conflict do nothing',[`owner:${user.id}`]);
   await tx.query('select key from private.rate_limits where key=$1 for update',[`owner:${user.id}`]);
   const count=await tx.query("select count(*)::int as n from private.rooms where owner_id=$1 and not (state->>'closed')::boolean",[user.id]);ensure(count.rows[0].n<3,'Лимит комнат достигнут');
   await tx.query('insert into private.rooms(id,owner_id,state,invite_token,short_code) values($1,$2,$3::text::jsonb,$4,$5)',[r.id,user.id,json({...r,table:t.serialize()}),r.inviteToken,r.code]);await this.save(tx,r);
  });return {roomId:r.id};
 }
 async locked(roomId,fn,{allowClosed=false}={}){
  return this.db.transaction(async tx=>{
   const {rows}=await tx.query('select * from private.rooms where id=$1 for update',[roomId]);ensure(rows.length,'Комната не найдена или уже закрыта',404);
   const r=this.restore(rows[0]);ensure(allowClosed||!r.closed,'Комната не найдена или уже закрыта',404);
   return fn(tx,r);
  });
 }
 async join(user,data){
  await this.limit(`join:${user.id}`,20);
  const raw=String(data.code||'').trim();const m=/^r([0-9a-f]{12})_([A-Za-z0-9_-]{24,36})$/.exec(raw);
  const {rows}=await this.db.query(m?'select id from private.rooms where id=$1 and invite_token=$2':'select id from private.rooms where short_code=$1',m?[m[1],m[2]]:[raw.toUpperCase()]);
  ensure(rows.length,'Приглашение недействительно или устарело',404);
  return this.locked(rows[0].id,async(tx,r)=>{
   ensure((m?r.inviteToken===m[2]:r.code===raw.toUpperCase())&&r.inviteExpires>this.now(),'Приглашение недействительно или устарело',404);
   if(r.table.player(user.id))return {roomId:r.id};
   ensure(!r.locked,'Хозяин закрыл вход для новых игроков',403);
   if(r.pending[user.id])return {roomId:r.id,pending:true};
   ensure(Object.keys(r.pending).length<20||r.pending[user.id],'Очередь заявок заполнена');
   const buyIn=data.buyIn??r.table.startingStack;
   ensure(Number.isSafeInteger(buyIn)&&(r.table.mode==='tournament'?buyIn===r.table.startingStack:buyIn>=r.table.minBuyIn&&buyIn<=r.table.maxBuyIn),'Стек вне диапазона buy-in');
   r.pending[user.id]={id:user.id,name:user.name,buyIn};await this.save(tx,r);return {roomId:r.id,pending:true};
  });
 }
 async peek(roomId,userId){return this.locked(roomId,async(tx,r)=>{
  const snap=this.snapshot(r,userId);ensure(snap.type!=='denied','Нет доступа к комнате',403);return snap;
 });}
 async command(user,d){
  ensure(typeof d.requestId==='string'&&/^[\w-]{10,100}$/.test(d.requestId),'Некорректный идентификатор запроса');
  ensure(Object.hasOwn(fields,d.action),'Неизвестная команда');
  const allowed=new Set(['roomId','action','requestId','handId','version',...fields[d.action]]);ensure(Object.keys(d).every(k=>allowed.has(k)),'Недопустимое поле команды');
  const fingerprint=JSON.stringify(Object.fromEntries(Object.keys(d).sort().map(k=>[k,d[k]])));
  return this.locked(d.roomId,async(tx,r)=>{
   const seen=await tx.query('select fingerprint,result from private.commands where room_id=$1 and actor_id=$2 and request_id=$3',[r.id,user.id,d.requestId]);
   if(seen.rows.length){ensure(seen.rows[0].fingerprint===fingerprint,'Идентификатор запроса уже использован с другим содержимым',409);return {...seen.rows[0].result,duplicate:true};}
   ensure(!r.closed,'Комната закрыта',404);const t=r.table;
   ensure(t.player(user.id),'Нет доступа к столу',403);
   const owner=()=>ensure(r.ownerId===user.id,'Это действие доступно хозяину стола',403);
   const current=()=>ensure(d.handId===t.handId&&d.version===t.version,'Стол уже обновился. Повторите действие',409);
   // A deadline is authoritative even when the independent worker is delayed.
   if(t.tick())await this.save(tx,r);
   let error;
   try{
    if(t.rebuyReview && ['start','act','pause','sitOut','returnToPlay','straddle','kick','leave','close'].includes(d.action))fail('Игра приостановлена: закуп в игре',409);
    switch(d.action){
     case 'start':owner();current();t.startPlay();break;
     case 'act':current();t.act(user.id,d.move,d.amount);break;
     case 'blinds':owner();current();t.scheduleBlinds(d.smallBlind,d.bigBlind);break;
     case 'sitOut':current();t.sitOut(user.id);break;
     case 'returnToPlay':current();t.setConnected(user.id,true);t.returnToPlay(user.id);break;
     case 'pause':owner();current();t.setPaused(d.paused);break;
     case 'topUp':
     case 'requestRebuy':t.requestRebuy(user.id,d.amount??t.startingStack,`${user.id}:${d.requestId}`,d.fundingType??'rebuy');break;
     case 'beginRebuyReview':owner();t.beginRebuyReview(d.requestId,Object.values(r.pending).map(p=>p.name));break;
     case 'endRebuyReview':owner();t.endRebuyReview(d.reviewId);break;
     case 'renewRebuyReview':owner();t.renewRebuyReview(d.reviewId);break;
     case 'approveRebuy':owner();t.decideRebuy(d.rebuyRequestId,true);break;
     case 'denyRebuy':owner();t.decideRebuy(d.rebuyRequestId,false);break;
     case 'cancelRebuy':t.cancelRebuy(user.id,d.rebuyRequestId);break;
     case 'straddle':current();t.setStraddle(user.id,d.enabled);break;
     case 'approve':{owner();const p=r.pending[d.userId];ensure(p,'Заявка не найдена');ensure(t.rebuyReview && this.now()<t.rebuyReview.expiresAt,'Сначала откройте окно запросов');t.ensureChipCapacity(p.buyIn);t.addPlayer(p.id,p.name,{unfunded:true});t.topUp(p.id,p.buyIn,'buyIn');delete r.pending[p.id];break;}
     case 'deny':{owner();ensure(t.rebuyReview,'Сначала откройте окно запросов');const p=r.pending[d.userId];ensure(p,'Заявка не найдена');t.record(`Бай-ин ${p.name} отклонён`,{kind:'rebuyDenied',playerId:p.id});delete r.pending[d.userId];break;}
     case 'lock':owner();r.locked=!r.locked;break;
     case 'rotateInvite':owner();r.inviteToken=secret();r.code=code();r.inviteExpires=this.now()+8*3600000;break;
     case 'kick':owner();ensure(d.userId!==r.ownerId,'Хозяин не может удалить себя');t.removePlayer(d.userId);break;
     case 'leave':ensure(user.id!==r.ownerId,'Хозяин может закрыть стол в настройках');t.removePlayer(user.id);break;
     case 'close':owner();ensure(t.idle,'Сначала завершите раздачу');ensure(t.mode!=='tournament'||!t.handId||t.tournamentOver,'Сначала завершите турнир');r.closed=true;break;
    }
   }catch(e){error={message:e.message,status:e.status||400};}
   if(error)return {error}; // commit a preceding timeout, but never a failed command
   const result={ok:true,...(d.action==='beginRebuyReview'?{reviewId:t.rebuyReview.id}:{})};await this.save(tx,r);
   await tx.query('insert into private.commands(room_id,actor_id,request_id,fingerprint,result) values($1,$2,$3,$4,$5::text::jsonb)',[r.id,user.id,d.requestId,fingerprint,json(result)]);return result;
  },{allowClosed:true}).then(result=>{if(result.error)fail(result.error.message,result.error.status);return result;});
 }
 async tick(){
  return this.db.transaction(async tx=>{
   const {rows}=await tx.query('select * from private.rooms where due_at <= $1 order by due_at limit 50 for update skip locked',[this.now()]);
   for(const row of rows){const r=this.restore(row);try{if(r.table.tick())await this.save(tx,r);}catch{r.table.halt();await this.save(tx,r);}}
   return rows.length;
  });
 }
}
