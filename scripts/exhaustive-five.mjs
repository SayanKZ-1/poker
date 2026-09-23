import {evaluateFive,RANKS,SUITS,HAND_NAMES} from '../lib/poker.mjs';
import assert from 'node:assert/strict';
const C=(n,k)=>{let v=1;for(let i=1;i<=k;i++)v=v*(n-i+1)/i;return Math.round(v);};
const deck=[...SUITS].flatMap(s=>[...RANKS].map(r=>r+s)),counts=Array(9).fill(0);
const started=Date.now();let checked=0;
for(let a=0;a<48;a++)for(let b=a+1;b<49;b++)for(let c=b+1;c<50;c++)for(let d=c+1;d<51;d++)for(let e=d+1;e<52;e++){
 counts[evaluateFive([deck[a],deck[b],deck[c],deck[d],deck[e]])[0]]++;checked++;
}
// Expected category counts derived combinatorially, not from the evaluator.
const expected=[(C(13,5)-10)*(4**5-4),13*C(4,2)*C(12,3)*4**3,C(13,2)*C(4,2)**2*11*4,
 13*C(4,3)*C(12,2)*4**2,10*(4**5-4),4*(C(13,5)-10),13*C(4,3)*12*C(4,2),13*12*4,10*4];
assert.equal(checked,C(52,5));assert.deepEqual(counts,expected);
console.log(JSON.stringify({status:'pass',checked,elapsedMs:Date.now()-started,categories:HAND_NAMES.map((name,i)=>({name,actual:counts[i],expected:expected[i]})),note:'Exhaustive category counts, not a proof of every tie-break or RNG fairness.'},null,2));
