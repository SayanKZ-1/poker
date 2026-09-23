import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {postgresStore} from './lib/store.mjs';
import {localStore} from './lib/local-store.mjs';
import {GameService} from './lib/service.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000),origin=process.env.PUBLIC_ORIGIN||`http://localhost:${port}`;
if(process.env.NODE_ENV==='production'&&!process.env.DATABASE_URL)throw new Error('Production uses Supabase Edge Functions and Postgres. Local guest server is development-only.');
if(!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Local guest server must bind to loopback');
let db;
if(process.env.DATABASE_URL){const {default:postgres}=await import('postgres');db=postgresStore(postgres(process.env.DATABASE_URL,{prepare:false,max:4}));}
else {const path=process.env.DATA_DIR||join(root,'data');if(path!=='memory://')await mkdir(path,{recursive:true});db=await localStore(path);await db.exec(await readFile(join(root,'db/schema.sql'),'utf8'));}
const service=new GameService(db,{origin});
const streams=new Map();
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
async function body(req){if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail('Требуется JSON',415);let raw='';for await(const b of req){raw+=b;if(Buffer.byteLength(raw)>20000)fail('Слишком большой запрос',413);}try{const d=JSON.parse(raw);if(!d||typeof d!=='object'||Array.isArray(d))throw 0;return d;}catch{fail('Некорректный JSON');}}
async function publish(){
 for(const [res,x]of streams){try{
  const s=await service.session(x.token);const p=await service.peek(x.roomId,s.user.id);const value=JSON.stringify(p);
  // serverNow changes each peek; use durable revision to avoid redundant packets.
  const {rows}=await db.query('select revision from private.rooms where id=$1',[x.roomId]);const rev=rows[0]?.revision;
  if(rev!==x.rev){x.rev=rev;if(res.writableLength>262144){res.end();continue;}res.write(`data: ${value}\n\n`);}
 }catch(e){res.write(`data: ${JSON.stringify({type:e.status===401?'expired':'denied',message:e.message})}\n\n`);res.end();}}
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.mjs':'text/javascript','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json'};
export const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 try{
  const url=new URL(req.url,origin);
  if(req.headers.origin&&![new URL(origin).origin,`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(req.headers.origin))fail('Недопустимый источник запроса',403);
  if(url.pathname==='/health')return json(res,{ok:true});
  if(url.pathname==='/api/config')return json(res,{authMode:'guest'});
  const token=(req.headers.authorization||'').replace(/^Bearer /,'');
  if(req.method==='POST'&&url.pathname==='/api/session'){await service.limit(`login:${req.socket.remoteAddress}`,60);const d=await body(req);return json(res,await service.login(d.name,token));}
  if(url.pathname.startsWith('/api/')){
   const s=await service.session(token);await service.limit(`user:${s.user.id}`,180);
   if(req.method==='GET'&&url.pathname==='/api/me')return json(res,s);
   if(req.method==='POST'){
    const d=await body(req);let result;
    if(url.pathname==='/api/rooms')result=await service.create(s.user,d);
    else if(url.pathname==='/api/join')result=await service.join(s.user,d);
    else if(url.pathname==='/api/command')result=await service.command(s.user,d);
    else fail('Неизвестный API-маршрут',404);
    await publish();return json(res,result);
   }
   if(req.method==='GET'&&url.pathname==='/api/room')return json(res,await service.peek(url.searchParams.get('room'),s.user.id));
   if(req.method==='GET'&&url.pathname==='/api/events'){
    const roomId=url.searchParams.get('room');const p=await service.peek(roomId,s.user.id);
    if([...streams.values()].filter(x=>x.token===token).length>=4)fail('Слишком много вкладок',429);
    res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    streams.set(res,{token,roomId,rev:-1});res.write(`data: ${JSON.stringify(p)}\n\n`);res.on('close',()=>streams.delete(res));return;
   }fail('Неизвестный API-маршрут',404);
  }
  const paths={'/':'index.html','/poker.mjs':'../lib/poker.mjs'};
  const file=paths[url.pathname]||url.pathname.slice(1);
  if(req.method!=='GET'||(!Object.hasOwn(paths,url.pathname)&&(!/^[a-zA-Z0-9_./-]+$/.test(file)||file.includes('..'))))fail('Страница не найдена',404);
  const ext='.'+file.split('.').at(-1);if(!types[ext])fail('Страница не найдена',404);
  try{const data=await readFile(join(root,'public',file));res.writeHead(200,{'Content-Type':types[ext]});res.end(data);}catch{fail('Страница не найдена',404);}
 }catch(e){if(res.headersSent)return res.end();json(res,{error:e.status||!e.code?e.message:'Ошибка сервера'},e.status|| (e.code?500:400));}
});
let ticking=false;const timer=setInterval(async()=>{if(ticking)return;ticking=true;try{await service.tick();await publish();}catch(e){console.error('Worker:',e.message);}finally{ticking=false;}},250);timer.unref();
server.listen(port,host,()=>console.log(`СВОИ PWA ${origin}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(timer);for(const r of streams.keys())r.end();server.close(async()=>{await db.close();process.exit(0);});});
