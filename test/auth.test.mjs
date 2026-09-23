import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {validateTelegramInitData} from '../lib/auth.mjs';
const BOT='123456:test-token-not-real',NOW=1800000000000;
function sign(extra={}) {
  const p=new URLSearchParams({auth_date:String(NOW/1000),query_id:'test-query',user:JSON.stringify({id:123456789,first_name:'Саян'}),...extra});
  const data=[...p].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  const key=createHmac('sha256','WebAppData').update(BOT).digest();
  p.set('hash',createHmac('sha256',key).update(data).digest('hex'));return p.toString();
}
test('valid Telegram HMAC and signed user ID',()=>{assert.deepEqual(validateTelegramInitData(sign(),BOT,{now:NOW}),{id:'tg:123456789',name:'Саян',telegramId:'123456789'});});
test('new optional signature field participates in bot-token HMAC check',()=>{assert.equal(validateTelegramInitData(sign({signature:'sample-ed25519-field'}),BOT,{now:NOW}).id,'tg:123456789');});
test('forged identity, wrong bot and malformed signature rejected',()=>{const p=new URLSearchParams(sign());p.set('user',JSON.stringify({id:999,first_name:'Attacker'}));assert.throws(()=>validateTelegramInitData(p.toString(),BOT,{now:NOW}));assert.throws(()=>validateTelegramInitData(sign(),'wrong-bot',{now:NOW}));assert.throws(()=>validateTelegramInitData('hash=a',BOT,{now:NOW}));});
test('expired, future-dated and duplicate auth parameters rejected',()=>{assert.throws(()=>validateTelegramInitData(sign({auth_date:String(NOW/1000-301)}),BOT,{now:NOW}));assert.throws(()=>validateTelegramInitData(sign({auth_date:String(NOW/1000+31)}),BOT,{now:NOW}));assert.throws(()=>validateTelegramInitData(sign()+'&auth_date=123',BOT,{now:NOW}));});
