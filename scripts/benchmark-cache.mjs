// Local end-to-end check. The proxy is a stub, not a paid Fish/writer call.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, symlink, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = await mkdtemp(path.join(os.tmpdir(), 'twk-e2e-'));
const { default: ffmpeg } = await import(`${repo}/node_modules/ffmpeg-static/index.js`);
const tone = execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=0.4','-f','mp3','pipe:1']);
await mkdir(path.join(dir, 'podcast/episodes'), {recursive: true});
for (const file of ['generate-podcast.mjs', 'cache.mjs', 'speech-cache.mjs']) await cp(path.join(repo,'podcast',file),path.join(dir,'podcast',file));
await cp(path.join(repo,'podcast/kit'),path.join(dir,'podcast/kit'),{recursive:true});
await symlink(path.join(repo,'node_modules'),path.join(dir,'node_modules'));
let chapters = 0, speech = 0;
const server = createServer(async (req,res) => {
  let body = '';
  for await (const part of req) body += part;
  const input = body ? JSON.parse(body) : {};
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET') return res.end(JSON.stringify({pending: true, model: 'stub-writer', plan: {
    slug: 'cache-check',title:'Cache check',episodeNumber:1,description:'Local mock check',
    publishedAt:'2026-11-21T00:00:00Z',targetMinutes:1,chapters:[{title:'Test'}], sources:[]
  }}));
  if (input.action === 'write-chapter') {
    chapters++;
    await new Promise(r=>setTimeout(r,100));
    return res.end(JSON.stringify({words:5,model:'stub-writer',turns:[{
      speaker:input.part ? 'B' : 'A',text:input.part ? 'Subscribe to the show.' : 'Welcome to our test.',
      chapter:'Test',...(input.part ? {segment:'subscribe'} : {})
    }]}));
  }
  if(input.action === 'tts') {
    speech++;
    await new Promise(r=>setTimeout(r,200));
    res.setHeader('Content-Type','audio/mpeg'); return res.end(tone);
  }
  res.statusCode = 400; res.end('{}');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
async function run() {
  const before = { chapters,speech };
  const started = performance.now();
  const child = spawn(process.execPath,[path.join(dir,'podcast/generate-podcast.mjs'),'--auto','--no-publish'],{
    env:{...process.env,TWK_AUTOMATION_URL:`http://127.0.0.1:${server.address().port}`,AUTOMATION_INGEST_SECRET:'mock-only',TWK_PODCAST_CACHE_DIR:path.join(dir,'.cache/podcast')},
    stdio:['ignore','pipe','pipe']
  });
  let output = '';
  child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
  const code = await new Promise(r=>child.on('close',r));
  assert.equal(code,0,output);
  const audio = await readFile(path.join(dir,'podcast/episodes/cache-check/episode.mp3'));
  return {ms:Math.round(performance.now()-started),chapters:chapters-before.chapters,speech:speech-before.speech,audio,output};
}
try {
 const cold = await run(); const warm = await run();
 assert.equal(cold.chapters,2); assert.equal(cold.speech,2);
 assert.equal(warm.chapters,0); assert.equal(warm.speech,0);
 assert.deepEqual(warm.audio,cold.audio);
 console.log(JSON.stringify({cold:{ms:cold.ms,chapterRequests:cold.chapters,ttsRequests:cold.speech},warm:{ms:warm.ms,chapterRequests:warm.chapters,ttsRequests:warm.speech},identicalMp3:true},null,2));
 console.log(warm.output);
} finally {server.close(); await rm(dir,{recursive:true,force:true});}
