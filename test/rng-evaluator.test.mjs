import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBelow,shuffledDeck,bestHand,Table,RANKS,SUITS} from '../lib/poker.mjs';

test('rejection sampling rejects biased uint32 tail instead of taking it modulo n',()=>{
  const original=crypto.getRandomValues;let calls=0;
  crypto.getRandomValues=out=>{out[0]=calls++===0?0xffffffff:5;return out;};
  try {assert.equal(randomBelow(3),2);assert.equal(calls,2);}
  finally {crypto.getRandomValues=original;}
});
test('shuffle never depends on Math.random, and cryptographic failure does not fall back',()=>{
  const oldRandom=Math.random,original=crypto.getRandomValues;
  const t=new Table();t.addPlayer('a','A');t.addPlayer('b','B');
  try {
    Math.random=()=>{throw new Error('Math.random forbidden');};
    assert.equal(new Set(shuffledDeck()).size,52);
    crypto.getRandomValues=undefined;
    assert.throws(()=>t.startHand(),/ГСЧ/);assert.equal(t.phase,'waiting');assert.equal(t.handId,0);
    assert.deepEqual(t.players.map(p=>p.stack),[2000,2000]);
  } finally {Math.random=oldRandom;crypto.getRandomValues=original;}
});
test('random bounds are validated',()=>{
  for(const bound of [0,-1,1.5,NaN,Infinity,2**32])assert.throws(()=>randomBelow(bound));
  assert.equal(randomBelow(1),0);
});

// Independent evaluator of 7 cards: count ranks/suits directly, without
// enumerating 5-card subsets or calling the production evaluator.
function directSeven(cards) {
  const rank=cards.map(c=>RANKS.indexOf(c[0])+2),counts=new Map();rank.forEach(r=>counts.set(r,(counts.get(r)||0)+1));
  const descending=[...counts.keys()].sort((a,b)=>b-a);
  const straight=rs=>{const set=new Set(rs);if(set.has(14))set.add(1);for(let hi=14;hi>=5;hi--)if([0,1,2,3,4].every(d=>set.has(hi-d)))return hi;return 0;};
  let flush=null;
  for(const suit of SUITS){const rs=cards.filter(c=>c[1]===suit).map(c=>RANKS.indexOf(c[0])+2).sort((a,b)=>b-a);if(rs.length>=5){const high=straight(rs);if(high)return[8,high];flush=rs.slice(0,5);}}
  const quads=descending.filter(r=>counts.get(r)===4),trips=descending.filter(r=>counts.get(r)>=3);
  if(quads.length)return[7,quads[0],descending.find(r=>r!==quads[0])];
  if(trips.length){const pair=descending.find(r=>r!==trips[0]&&counts.get(r)>=2);if(pair)return[6,trips[0],pair];}
  if(flush)return[5,...flush];const high=straight(rank);if(high)return[4,high];
  if(trips.length)return[3,trips[0],...descending.filter(r=>r!==trips[0]).slice(0,2)];
  const pairs=descending.filter(r=>counts.get(r)>=2);
  if(pairs.length>=2)return[2,pairs[0],pairs[1],descending.find(r=>r!==pairs[0]&&r!==pairs[1])];
  if(pairs.length)return[1,pairs[0],...descending.filter(r=>r!==pairs[0]).slice(0,3)];
  return[0,...descending.slice(0,5)];
}
test('10,000 seven-card hands match a separate direct evaluator, including kickers',()=>{
  let seed=91917;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  const deck=[...SUITS].flatMap(s=>[...RANKS].map(r=>r+s));
  for(let h=0;h<10000;h++){
    const d=[...deck];for(let i=0;i<7;i++){const j=i+rand(52-i);[d[i],d[j]]=[d[j],d[i]];}
    const cards=d.slice(0,7);assert.deepEqual(bestHand(cards).rank,directSeven(cards),cards.join(' '));
  }
});
