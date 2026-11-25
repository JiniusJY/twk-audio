import test from 'node:test';import assert from 'node:assert/strict';
import {modelConfig,directJson} from '../podcast/direct-model.mjs';
import {publicIPv4,collectEvidence} from '../podcast/source-evidence.mjs';
import {validateAudit,directPlan,directChapter,directReview} from '../podcast/direct-editor.mjs';
const config={base:'https://integrate.api.nvidia.com/v1',models:['writer','reviewer'],key:'fixture'};
const text='Primary source confirms optional AI features and a user off switch. '.repeat(8);
const sources=[{id:'src-1',title:'Primary source',url:'https://site/story',evidence:'Article summary',originalUrls:['https://vendor.test/launch'],upstream:[{url:'https://vendor.test/launch',text}]}];
const turns=Array.from({length:4},(_,i)=>({speaker:i%2?'B':'A',text:'What can we check for point '+i+'?',citations:['src-1']}));
const claims=[{claim:'Optional AI',sourceId:'src-1',url:'https://vendor.test/launch',quote:'Primary source confirms optional AI features',kind:'primary',verified:true}];
const audit=()=>({issues:[],centralClaims:claims,turns:turns.map((_,index)=>({index,supported:true,sourceIds:['src-1'],reason:'Grounded question'}))});
const snapshot={slug:'ep-test',episodeNumber:1,title:'Test',hosts:{A:{name:'Jade'},B:{name:'Alok'}},sources,subscribeTurns:[{speaker:'A',text:'Subscribe to this show.',segment:'subscribe',citations:[]}]};
test('chosen NIM path has no gateway or implicit provider fallback',()=>{
 assert.deepEqual(modelConfig({NVIDIA_API_KEY:'fixture'}).models,['nvidia/nemotron-3-ultra-550b-a55b','nvidia/nemotron-3.5-super-vl-120b-a12b']);
 assert.throws(()=>modelConfig({NVIDIA_API_KEY:'fixture',PODCAST_MODEL_BASE_URL:'https://ai-gateway.vercel.sh/v1'}));
 assert.throws(()=>modelConfig({}));
});
test('direct model transient errors try eligible same-provider model, auth errors stop',async()=>{
 let calls=0;const r=await directJson(config,[],{fetchImpl:async()=>++calls===1?new Response('',{status:429}):Response.json({choices:[{message:{content:'{"ok":true}'}}]})});
 assert.equal(r.model,'reviewer');assert.equal(calls,2);
 let tCalls=0;const tRes=await directJson(config,[],{fetchImpl:async()=>{if(++tCalls===1){const e=new Error('timeout');e.name='TimeoutError';throw e;}return Response.json({choices:[{message:{content:'<think>reasoning</think>\n{"ok":true}'}}]});}});
 assert.equal(tRes.model,'reviewer');assert.equal(tRes.data.ok,true);
 await assert.rejects(()=>directJson(config,[],{fetchImpl:async()=>new Response('',{status:402})}),/no alternate provider/);
 await assert.rejects(()=>directJson(config,[],{exclude:config.models}),/independent/);
});
test('evidence fetch refuses private networks and requires usable upstream',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.2','169.254.169.254','172.16.0.1','192.168.1.2','100.64.0.1','192.0.2.1','198.51.100.1','203.0.113.1','::1'])assert.equal(publicIPv4(ip),false,ip);
 assert.equal(publicIPv4('8.8.8.8'),true);
 const result=await collectEvidence(sources,async()=>'<main>'+text+'</main><script>attack</script>');assert.equal(result[0].upstream.length,1);assert.doesNotMatch(result[0].upstream[0].text,/attack/);
 await assert.rejects(()=>collectEvidence(sources,async()=>{throw Error('blocked');}),/verification blocked/);
});
test('full upstream plan, conversational scene and independent review use direct calls',async()=>{
 const outline={title:'A launch',description:'Grounded update',targetMinutes:8,chapters:[{title:'AI features',brief:'Explain controls',sourceIds:['src-1']},{title:'Limits',brief:'Check availability',sourceIds:['src-1']}]};
 const plan=await directPlan(snapshot,10,{config,collect:async()=>sources,call:async()=>({model:'writer',data:outline})});
 let content;const scene=await directChapter({plan:plan.plan,index:0,part:1,previous:'A: A pending question?'},{config,call:async(_c,m)=>{content=m[1].content;return {model:'writer',data:{turns}};}});
 assert.match(content,/A pending question/);assert.equal(scene.turns.at(-1).segment,'subscribe');
 let excluded;const review=await directReview({sources,turns,writerModels:['writer']},{config,call:async(_c,_m,opts)=>{excluded=opts.exclude;return {model:'reviewer',data:audit()};}});
 assert.deepEqual(excluded,['writer']);assert.equal(review.reviewedTurns,4);
});
test('review rejects fabricated quotes, missed turns and repeated ideas',()=>{
 validateAudit(audit(),turns,sources);
 for(const bad of [{...audit(),turns:audit().turns.slice(1)},{...audit(),issues:['Repeated idea']},{...audit(),centralClaims:[{...claims[0],quote:'Unsupported fabricated quote in no source'}]}])assert.throws(()=>validateAudit(bad,turns,sources));
});

test('reviewer cannot return the writer identity even if adapter misbehaves',async()=>{await assert.rejects(()=>directReview({sources,turns,writerModels:['writer']},{config,call:async()=>({model:'writer',data:audit()})}),/also wrote/);});

test('GitHub-first episode rerender cannot silently use the Vercel relay',async()=>{
 const {spawnSync}=await import('node:child_process');
 const child=spawnSync(process.execPath,['podcast/generate-podcast.mjs','--episode','fixture','--no-publish'],{encoding:'utf8',env:{...process.env,PODCAST_EXECUTION:'github',NVIDIA_API_KEY:'fixture',FISH_AUDIO_API_KEY:''}});
 assert.notEqual(child.status,0);assert.match(child.stderr,/requires direct Fish credential/);assert.doesNotMatch(child.stderr,/ENOENT/);
});

test('directChapter includes retryFeedback and throws descriptive Invalid dialogue scene errors',async()=>{
 const outline={title:'A launch',description:'Grounded update',targetMinutes:8,chapters:[{title:'AI features',brief:'Explain controls',sourceIds:['src-1']},{title:'Limits',brief:'Check availability',sourceIds:['src-1']}]};
 const plan=await directPlan(snapshot,10,{config,collect:async()=>sources,call:async()=>({model:'writer',data:outline})});
 let seenPrompt='';
 await directChapter({plan:plan.plan,index:0,part:0,previous:'',retryFeedback:'Turn 39: repeats sentence from turn 35'},{
  config,
  call:async(_c,m)=>{seenPrompt=m[1].content;return {model:'writer',data:{turns}};}
 });
 assert.match(seenPrompt,/Turn 39: repeats sentence from turn 35/);
 await assert.rejects(
  ()=>directChapter({plan:plan.plan,index:0,part:0,previous:''},{config,call:async()=>({model:'writer',data:{turns:turns.slice(0,2)}})}),
  /Invalid dialogue scene: expected 4-100 turns, got 2/
 );
 await assert.rejects(
  ()=>directChapter({plan:plan.plan,index:0,part:0,previous:''},{config,call:async()=>({model:'writer',data:{turns:[...turns.slice(0,3),{speaker:'B',text:'   ',citations:['src-1']}]}})}),
  /Invalid dialogue scene: turn 4 has empty text/
 );
});
