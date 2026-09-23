import postgres from 'npm:postgres@3.4.9';
import {GameService} from '../_shared/service.mjs';
import {postgresStore} from '../_shared/store.mjs';
const origin=Deno.env.get('PUBLIC_ORIGIN')!;
// Hosted Edge Functions receive SUPABASE_DB_URL automatically. DATABASE_URL is
// kept as an override for local development and custom pooler deployments.
const databaseUrl=Deno.env.get('DATABASE_URL')||Deno.env.get('SUPABASE_DB_URL');
if(!databaseUrl)throw new Error('Database connection is not configured');
const db=postgresStore(postgres(databaseUrl,{prepare:false,max:1,connect_timeout:10,idle_timeout:20}));
const service=new GameService(db,{origin});
const headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Cache-Control':'no-store','Content-Type':'application/json','Vary':'Origin'};
Deno.serve(async req=>{
 const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
 try{
  if(req.headers.get('origin')&&req.headers.get('origin')!==origin)return response({error:'Недопустимый источник'},403);
  const url=new URL(req.url);const path=url.pathname.split('/game')[1]||'/';
  const authorization=req.headers.get('Authorization')||'';
  if(path==='/tick'){
   // The platform verifies the JWT before invocation. The second secret keeps
   // possession of the public anon JWT from granting timer-worker access.
   if(req.method!=='POST'||req.headers.get('x-worker-secret')!==Deno.env.get('WORKER_SECRET'))return response({error:'Forbidden'},403);
   return response({processed:await service.tick()});
  }
  if(!authorization.startsWith('Bearer '))return response({error:'Войдите заново'},401);
  // Verify with Auth, never trust client-supplied user IDs or unsigned JWT claims.
  const auth=await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`,{headers:{Authorization:authorization,apikey:Deno.env.get('SUPABASE_ANON_KEY')!}});
  if(!auth.ok)return response({error:'Войдите заново'},401);
  const verified=await auth.json();const user={id:verified.id,name:String(verified.user_metadata?.name||'Игрок').slice(0,32)};
  await service.limit(`user:${user.id}`,180);
  if(req.method==='GET'&&path==='/me')return response({user});
  if(req.method==='GET'&&path==='/room')return response(await service.peek(url.searchParams.get('room'),user.id));
  if(req.method!=='POST')return response({error:'Not found'},404);
  const raw=await req.text();if(raw.length>20000)return response({error:'Слишком большой запрос'},413);
  const d=JSON.parse(raw);if(!d||Array.isArray(d)||typeof d!=='object')return response({error:'Требуется объект'},400);
  if(path==='/rooms')return response(await service.create(user,d));
  if(path==='/join')return response(await service.join(user,d));
  if(path==='/command')return response(await service.command(user,d));
  return response({error:'Not found'},404);
 }catch(e){return response({error:e.status?e.message:'Не удалось выполнить команду'},e.status||400);}
});
