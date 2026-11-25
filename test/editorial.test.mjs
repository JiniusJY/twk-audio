import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptProblems, continuityContext } from '../podcast/editorial.mjs';
const hosts={A:{name:'Jade Chen'},B:{name:'Alok Nair'}};
test('invalid speakers cannot silently become host A',()=>assert.ok(scriptProblems({hosts,turns:[{speaker:'guest',text:'Hello'}]}).length));
test('host cannot address their own name',()=>assert.ok(scriptProblems({hosts,turns:[{speaker:'A',text:'Jade, what do you think?'}]}).length));
test('cross-scene duplicate is blocked',()=>{const text='The calendar and mail stay available through the existing open protocols on compatible clients.';assert.ok(scriptProblems({hosts,turns:[{speaker:'A',text},{speaker:'B',text}]}).length)});
test('all previous turns survive continuity handoff',()=>assert.equal(continuityContext(Array.from({length:20},(_,i)=>({speaker:'A',text:`line${i}`}))).split('\n').length,20));
test('stock prose is rejected',()=>assert.ok(scriptProblems({hosts,turns:[{speaker:'A',text:'That distinction matters.'}]}).length));
test('plain dialogue passes',()=>assert.deepEqual(scriptProblems({hosts,turns:[{speaker:'A',text:'Would you move your inbox?'},{speaker:'B',text:'I would try a spare address first.'}]}),[]));


const {assertFreeFish,FREE_FISH_UNTIL}=await import('../podcast/fish-cost-guard.mjs');
test('free-model guard rejects paid choices and exact/post expiry, accepts just before',()=>{
 assert.doesNotThrow(()=>assertFreeFish('s2.1-pro-free',FREE_FISH_UNTIL-1));
 for(const t of [FREE_FISH_UNTIL,FREE_FISH_UNTIL+1,NaN])assert.throws(()=>assertFreeFish('s2.1-pro-free',t),/expired/);
 assert.throws(()=>assertFreeFish('s2.1-pro',FREE_FISH_UNTIL-1),/Paid Fish/);
});
