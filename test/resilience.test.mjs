import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeHtmlEntities, extractReadableText, collectEvidence } from '../podcast/source-evidence.mjs';
import { parseModelJson, directJson } from '../podcast/direct-model.mjs';
import { directReview, directPlan, directChapter, directRepairTurns, validateAudit, normQuote } from '../podcast/direct-editor.mjs';
import { withRetry, decodeAudioToFloat32, resolveFfmpeg } from '../podcast/generate-podcast.mjs';
import { cacheKey, readCache, writeCache } from '../podcast/cache.mjs';

test('source-evidence decodes HTML entities and strips nav/footer boilerplate', async () => {
  const decoded = decodeHtmlEntities('Apple&#8217;s &ldquo;M5&rdquo; &mdash; 20% faster &amp; &#x27;cooler&#x27;.');
  assert.equal(decoded, `Apple’s "M5" - 20% faster & 'cooler'.`);

  const articleBody = 'Nvidia confirmed the Blackwell Ultra rack ships in Q3 with 288GB HBM3e memory per GPU. '.repeat(8);
  const html = `<nav>Menu Sign In Subscribe</nav><article><p>${articleBody.replace('confirmed', '&#99;onfirmed')}&#8217;s spec</p></article><footer>Copyright 2026</footer>`;
  const extracted = extractReadableText(html);
  assert.match(extracted, /confirmed/);
  assert.doesNotMatch(extracted, /Menu Sign In/);
  assert.doesNotMatch(extracted, /Copyright 2026/);

  const sources = [{ id: 'src-1', title: 'S1', url: 'https://site/s1', originalUrls: ['https://vendor.test/post'] }];
  const collected = await collectEvidence(sources, async () => html);
  assert.equal(collected[0].upstream.length, 1);
  assert.match(collected[0].upstream[0].text, /’s spec$/);
});

test('parseModelJson and directJson handle unclosed think tags, trailing commas, and 400 jsonMode fallback', async () => {
  assert.deepEqual(parseModelJson('<think>still thinking\n{"ok":true,"items":[1,2,],}'), { ok: true, items: [1, 2] });
  assert.deepEqual(parseModelJson('Here is the JSON:\n```json\n{"a":1,}\n```'), { a: 1 });
  assert.equal(parseModelJson('no json here'), null);

  const config = { base: 'https://integrate.api.nvidia.com/v1', models: ['m1', 'm2'], key: 'k' };
  const bodies = [];
  const res = await directJson(config, [{ role: 'user', content: 'hi' }], {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.model === 'm1' && body.response_format) return new Response('', { status: 400 });
      if (body.model === 'm1') return Response.json({ choices: [{ message: { content: 'not json at all' } }] });
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
    },
  });
  assert.equal(res.model, 'm2');
  assert.equal(res.data.ok, true);
  assert.equal(bodies[0].model, 'm1');
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal(bodies[1].model, 'm1');
  assert.equal(bodies[1].response_format, undefined);
});

test('directReview chunks >24 turns in parallel, retries failed slices with feedback, and normalises quotes', async () => {
  const upstreamText = 'Primary engineering report confirms 40% lower latency on ARM64 inference nodes across Singapore clusters. '.repeat(6);
  const sources = [{
    id: 'src-1',
    title: 'Primary',
    url: 'https://site/story',
    evidence: 'Summary',
    originalUrls: ['https://vendor.test/arm64'],
    upstream: [{ url: 'https://vendor.test/arm64/', text: upstreamText }],
  }];
  const turns = Array.from({ length: 30 }, (_, i) => ({
    speaker: i % 2 ? 'B' : 'A',
    text: `Point ${i}: ARM64 nodes cut latency by 40%.`,
    citations: ['src-1'],
  }));

  let slice2Attempts = 0;
  const seenPrompts = [];
  const res = await directReview(
    { sources, turns, hosts: { A: { name: 'Jade' }, B: { name: 'Alok' } }, writerModels: ['writer'] },
    {
      config: { base: 'https://integrate.api.nvidia.com/v1', models: ['writer', 'reviewer'], key: 'k' },
      batchSize: 20,
      concurrency: 2,
      call: async (_cfg, messages) => {
        const prompt = messages[1].content;
        seenPrompts.push(prompt);
        const isFirstSlice = prompt.includes('turns 0 to 19');
        if (!isFirstSlice) {
          slice2Attempts++;
          if (slice2Attempts === 1) {
            return { model: 'reviewer', data: { issues: [], centralClaims: [], turns: [] } };
          }
        }
        const indices = isFirstSlice ? Array.from({ length: 20 }, (_, i) => i) : Array.from({ length: 10 }, (_, i) => i + 20);
        return {
          model: 'reviewer',
          data: {
            issues: [],
            centralClaims: [{
              claim: '40% lower latency',
              sourceId: 'src-1',
              url: 'https://vendor.test/arm64',
              quote: '...primary engineering report confirms 40% lower latency on ARM64 inference nodes...',
              kind: 'primary',
              verified: true,
            }],
            turns: indices.map((index) => ({ index, supported: true, sourceIds: ['src-1'], reason: 'Verified' })),
          },
        };
      },
    },
  );
  assert.equal(res.ok, true);
  assert.equal(res.reviewedTurns, 30);
  assert.equal(slice2Attempts, 2);
  assert.ok(seenPrompts.some((p) => p.includes('Previous audit attempt failed')));

  assert.throws(
    () => validateAudit({
      issues: [],
      centralClaims: [{
        claim: 'Fake',
        sourceId: 'src-1',
        url: 'https://vendor.test/arm64',
        quote: 'Completely fabricated quote that is not in upstream text',
        kind: 'primary',
        verified: true,
      }],
      turns: turns.map((_, index) => ({ index, supported: true, sourceIds: ['src-1'], reason: 'ok' })),
    }, turns, sources),
    /Unverified or fabricated central claim evidence/,
  );
  assert.equal(normQuote('“Hello — World…”'), 'hello - world');
});

test('withRetry honours shouldRetry, decodeAudioToFloat32 decodes via pipes, and cache round-trips', async () => {
  let attempts = 0;
  const val = await withRetry(
    async () => {
      attempts++;
      if (attempts < 2) throw new Error('Invalid model JSON; audio blocked.');
      return 'ok';
    },
    {
      attempts: 3,
      baseMs: 1,
      shouldRetry: (e) => /Invalid model JSON/.test(e.message),
      sleepFn: async () => {},
    },
  );
  assert.equal(val, 'ok');
  assert.equal(attempts, 2);

  const ffmpeg = await resolveFfmpeg();
  const kitBytes = await readFile(path.resolve('podcast/kit/midroll.mp3'));
  const samples = await decodeAudioToFloat32(ffmpeg, null, 'test', kitBytes, 'mp3');
  assert.ok(samples instanceof Float32Array);
  assert.ok(samples.length > 1000);
  assert.ok(samples.every(Number.isFinite));

  const tmpCache = await mkdtemp(path.join(os.tmpdir(), 'twk-cache-test-'));
  try {
    const key = cacheKey({ stage: 'plan', slug: 'ep-test' });
    await writeCache(tmpCache, 'plans', key, JSON.stringify({ model: 'm1', plan: { chapters: [1, 2] } }));
    const loaded = JSON.parse((await readCache(tmpCache, 'plans', key)).toString('utf8'));
    assert.equal(loaded.model, 'm1');
  } finally {
    await rm(tmpCache, { recursive: true, force: true });
  }
});

test('directPlan and directChapter omit unverified TWK evidence summaries from writer prompts', async () => {
  const sources = [{
    id: 'src-1',
    title: 'Primary',
    url: 'https://site/story',
    evidence: 'SECRET_TWK_SUMMARY_SHOULD_NOT_LEAK_TO_WRITER',
    originalUrls: ['https://vendor.test/post'],
    upstream: [{ url: 'https://vendor.test/post', text: 'Verified upstream fact about chip yield. '.repeat(12) }],
  }];
  const snapshot = {
    slug: 'ep-test',
    episodeNumber: 1,
    title: 'Test',
    hosts: { A: { name: 'Jade' }, B: { name: 'Alok' } },
    sources,
    subscribeTurns: [{ speaker: 'A', text: 'Subscribe.', segment: 'subscribe', citations: [] }],
  };
  let planPrompt = '';
  const plan = await directPlan(snapshot, 10, {
    config: { base: 'https://integrate.api.nvidia.com/v1', models: ['writer', 'reviewer'], key: 'k' },
    collect: async () => sources,
    call: async (_cfg, messages) => {
      planPrompt = messages[1].content;
      return {
        model: 'writer',
        data: {
          title: 'Chip yield',
          description: 'Grounded update',
          targetMinutes: 8,
          chapters: [
            { title: 'Yield', brief: 'Facts', sourceIds: ['src-1'] },
            { title: 'Outlook', brief: 'Next', sourceIds: ['src-1'] },
          ],
        },
      };
    },
  });
  assert.doesNotMatch(planPrompt, /SECRET_TWK_SUMMARY_SHOULD_NOT_LEAK_TO_WRITER/);

  let chapterPrompt = '';
  await directChapter({ plan: plan.plan, index: 0, part: 0, previous: '' }, {
    config: { base: 'https://integrate.api.nvidia.com/v1', models: ['writer', 'reviewer'], key: 'k' },
    call: async (_cfg, messages) => {
      chapterPrompt = messages[1].content;
      return {
        model: 'writer',
        data: {
          turns: [
            { speaker: 'A', text: 'What did the report find?', citations: [] },
            { speaker: 'B', text: 'Chip yield improved.', citations: ['src-1'] },
            { speaker: 'A', text: 'How big is the gain?', citations: [] },
            { speaker: 'B', text: 'Significant enough for Q3.', citations: ['src-1'] },
          ],
        },
      };
    },
  });
  assert.doesNotMatch(chapterPrompt, /SECRET_TWK_SUMMARY_SHOULD_NOT_LEAK_TO_WRITER/);
});

test('directReview attaches auditFailure without burning slice retries, and directRepairTurns fixes only flagged turns', async () => {
  const upstreamText = 'Verified upstream report states the new runtime reduces cold starts by 35 percent. '.repeat(8);
  const sources = [{
    id: 'src-1',
    title: 'Primary',
    url: 'https://site/story',
    originalUrls: ['https://vendor.test/runtime'],
    upstream: [{ url: 'https://vendor.test/runtime', text: upstreamText }],
  }];
  const turns = Array.from({ length: 26 }, (_, i) => ({
    speaker: i % 2 ? 'B' : 'A',
    ...(i === 0 ? { chapter: 'Intro' } : {}),
    text: i === 25 ? 'Unverified claim about 99 percent speedup.' : `Grounded turn ${i} about 35 percent cold start reduction.`,
    citations: ['src-1'],
  }));

  let slice2Calls = 0;
  let caught;
  try {
    await directReview(
      { sources, turns, hosts: { A: { name: 'Jade' }, B: { name: 'Alok' } }, writerModels: ['writer'] },
      {
        config: { base: 'https://integrate.api.nvidia.com/v1', models: ['writer', 'reviewer'], key: 'k' },
        batchSize: 20,
        concurrency: 2,
        call: async (_cfg, messages) => {
          const prompt = messages[1].content;
          if (prompt.includes('turns 0 to 19')) {
            return {
              model: 'reviewer',
              data: {
                issues: [],
                centralClaims: [{
                  claim: '35% reduction',
                  sourceId: 'src-1',
                  url: 'https://vendor.test/runtime',
                  quote: 'Verified upstream report states the new runtime reduces cold starts by 35 percent',
                  kind: 'primary',
                  verified: true,
                }],
                turns: Array.from({ length: 20 }, (_, index) => ({ index, supported: true, sourceIds: ['src-1'], reason: 'ok' })),
              },
            };
          }
          slice2Calls++;
          return {
            model: 'reviewer',
            data: {
              issues: [],
              centralClaims: [{
                claim: '35% reduction',
                sourceId: 'src-1',
                url: 'https://vendor.test/runtime',
                quote: 'Verified upstream report states the new runtime reduces cold starts by 35 percent',
                kind: 'primary',
                verified: true,
              }],
              turns: Array.from({ length: 6 }, (_, j) => ({
                index: 20 + j,
                supported: 20 + j !== 25,
                sourceIds: ['src-1'],
                reason: 20 + j === 25 ? '99 percent speedup not in upstream' : 'ok',
              })),
            },
          };
        },
      },
    );
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(slice2Calls, 1);
  assert.deepEqual(caught.auditFailure.unsupportedTurns, [{ index: 25, reason: '99 percent speedup not in upstream' }]);

  const repaired = await directRepairTurns(
    {
      script: { hosts: { A: { name: 'Jade' }, B: { name: 'Alok' } }, turns },
      sources,
      flaggedTurns: caught.auditFailure.unsupportedTurns,
      issues: caught.auditFailure.issues,
    },
    {
      config: { base: 'https://integrate.api.nvidia.com/v1', models: ['writer', 'reviewer'], key: 'k' },
      call: async () => ({
        model: 'writer',
        data: {
          replacements: [{
            index: 25,
            speaker: 'B',
            text: 'The upstream report specifically measures a 35 percent reduction in cold starts.',
            citations: ['src-1'],
          }],
        },
      }),
    },
  );
  assert.equal(repaired.turns.length, 26);
  assert.equal(repaired.turns[25].speaker, 'B');
  assert.match(repaired.turns[25].text, /35 percent/);
  assert.equal(repaired.turns[0].text, turns[0].text);
});
