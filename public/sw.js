const CACHE='svoi-shell-v042';
const SHELL=['/','/style.css','/app.mjs','/demo.mjs','/poker.mjs','/favicon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 // Never cache API, tokens, config, cards or authenticated responses.
 if(event.request.method!=='GET'||url.origin!==self.location.origin||!SHELL.includes(url.pathname)||event.request.headers.has('authorization'))return;
 event.respondWith(fetch(event.request).then(response=>{if(response.ok){const clone=response.clone();caches.open(CACHE).then(c=>c.put(url.pathname,clone));}return response;}).catch(()=>caches.match(url.pathname)));
});
