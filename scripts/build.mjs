import {build} from 'esbuild';
import {cp,mkdir,writeFile,readFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});await cp('public','dist',{recursive:true});
await cp('lib/poker.mjs','dist/poker.mjs');
await build({entryPoints:['public/cloud.mjs'],bundle:true,format:'esm',outfile:'dist/cloud.mjs',minify:true});
// The same engine/service source is shipped to Edge, never a second implementation.
for(const name of ['poker','service','store'])await cp(`lib/${name}.mjs`,`supabase/functions/_shared/${name}.mjs`);
const config={supabaseUrl:process.env.PUBLIC_SUPABASE_URL||'',publishableKey:process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY||''};
if(config.publishableKey.startsWith('sb_secret_')||config.publishableKey.includes('service_role'))throw new Error('Only publishable keys allowed');
await writeFile('dist/config.json',JSON.stringify(config));
const connect=config.supabaseUrl?`${config.supabaseUrl} ${config.supabaseUrl.replace('https:','wss:')}`:'';
await writeFile('dist/_headers',`/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'\n/sw.js\n  Cache-Control: no-cache\n/config.json\n  Cache-Control: no-store\n`);
await writeFile('dist/_redirects','/* /index.html 200\n');
console.log('Built PWA in dist and shared Supabase sources.');
