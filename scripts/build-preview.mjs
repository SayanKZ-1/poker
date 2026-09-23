import {readFile,writeFile} from 'node:fs/promises';
const base = new URL('../',import.meta.url);
const read = name => readFile(new URL(name,base),'utf8');
const [html,css,engine,demo,app] = await Promise.all(['public/index.html','public/style.css','lib/poker.mjs','public/demo.mjs','public/app.mjs'].map(read));
const code = [engine.replace(/^export /gm,''),demo.replace(/^import .*;\n/gm,'').replace(/^export /gm,''),app.replace(/^import .*;\n/gm,'')].join('\n');
const result = html.replace(/<link rel="(?:manifest|apple-touch-icon)"[^>]+>/g,'').replace(/<link rel="icon"[^>]+>/,'').replace('<link rel="stylesheet" href="/style.css">',`<style>${css}</style>`).replace(/<script src="https:\/\/telegram\.org[^>]+><\/script>/,'').replace('<script type="module" src="/app.mjs"></script>',`<script type="module">window.__STANDALONE__=true;\n${code.replace(/<\/script/gi,'<\\/script')}</script>`);
await writeFile(new URL('svoi-preview.html',base),result);
console.log('Built svoi-preview.html — offline demo, no network requests, no friends mode.');
