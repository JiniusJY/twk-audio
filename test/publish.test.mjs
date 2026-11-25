import test from "node:test";
import assert from "node:assert/strict";
import { publishPodcastFiles } from "../podcast/publish.mjs";

const keys = ["mp3", "transcript", "manifest", "feed"];
const files = keys.map((key) => [key, `/local/${key}`, key === "mp3" ? "audio/mpeg" : "application/json"]);
const urls = Object.fromEntries(keys.map((key) => [key, { signedUrl: `https://objects.test/podcast/${key}?signature=private-test-value` }]));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
function fixture(options = {}) {
  const calls = []; const reads = []; const sleeps = []; const attempts = {};
  const run = () => publishPodcastFiles({ baseUrl: "https://website.test", secret: "private-bearer-test-value", slug: "test-episode", files,
    apiTimeoutMs: options.timeoutMs ?? 1000, uploadTimeoutMs: options.timeoutMs ?? 1000,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    readFileImpl: async (name) => { reads.push(name); if (options.missingFile === name) throw new Error("Local artifact missing"); return Buffer.from(name); },
    fetchImpl: async (url, init) => {
      const stage = init.method === "PUT" ? url.match(/podcast\/([^?]+)/)[1] : JSON.parse(init.body).action;
      calls.push({ url, init, stage }); attempts[stage] = (attempts[stage] ?? 0) + 1;
      if (options.hangStage === stage) return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({})), 10_000);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
      });
      if (options.throwStage === stage) throw new Error("Request lost; secret must not be exposed: private-bearer-test-value");
      const status = options.statusStage === stage ? options.status ?? 503 : 200;
      if (status !== 200 && (!options.failOnce || attempts[stage] === 1)) return json({ remote: "private-response-body" }, status);
      if (stage === "upload-url") return json(options.urlResult ?? { ok: true, uploads: urls });
      if (stage === "complete") return options.invalidCompleteJson ? new Response("not-json")
        : json(options.completeResult ?? { ok: true, episodeUrl: "https://website.test/podcasts/test-episode" });
      return new Response(null, { status: 200 });
    },
  });
  return { calls, reads, sleeps, attempts, run };
}

test("publishes four prepared files with deadlines and completes once", async () => {
  const f = fixture(); const done = await f.run();
  assert.equal(done.ok, true);
  assert.deepEqual(f.calls.map((c) => c.stage), ["upload-url", ...keys, "complete"]);
  for (const call of f.calls) assert.ok(call.init.signal instanceof AbortSignal);
  for (const call of f.calls.filter((c) => c.init.method === "PUT")) {
    assert.equal(call.init.headers.Authorization, undefined);
    assert.ok(Buffer.isBuffer(call.init.body));
  }
  assert.equal(f.reads.length, 4);
});
for (const stage of ["upload-url", "mp3"]) {
  test(`safe ${stage} operation retries a transient error with the same payload`, async () => {
    const f = fixture({ statusStage: stage, failOnce: true }); await f.run();
    assert.equal(f.attempts[stage], 2); assert.deepEqual(f.sleeps, [1000]);
    const attempts = f.calls.filter((c) => c.stage === stage);
    assert.equal(attempts[0].url, attempts[1].url); assert.equal(attempts[0].init.body, attempts[1].init.body);
    assert.notEqual(attempts[0].init.signal, attempts[1].init.signal);
  });
}
for (const stage of ["upload-url", "mp3"]) {
  test(`permanent ${stage} rejection fails once, before completion`, async () => {
    const f = fixture({ statusStage: stage, status: 403 });
    await assert.rejects(f.run, /HTTP 403/); assert.equal(f.attempts[stage], 1); assert.equal(f.attempts.complete, undefined);
  });
  test(`hung ${stage} operation aborts and stops after three attempts`, async () => {
    const f = fixture({ hangStage: stage, timeoutMs: 5 });
    await assert.rejects(f.run, /after 3 attempt/); assert.equal(f.attempts[stage], 3); assert.equal(f.attempts.complete, undefined);
  });
}
for (const option of [{ throwStage: "complete" }, { hangStage: "complete", timeoutMs: 5 },
  { statusStage: "complete", status: 500 }, { invalidCompleteJson: true },
  { completeResult: { ok: false } }, { completeResult: { ok: true, episodeUrl: "https://" } }]) {
  test(`completion uncertainty never causes an automatic repeat: ${JSON.stringify(option)}`, async () => {
    const f = fixture(option);
    await assert.rejects(f.run, /outcome is uncertain.*No automatic completion retry/);
    assert.equal(f.attempts.complete, 1); assert.equal(f.sleeps.length, 0);
  });
}
for (const uploads of [{ ...urls, feed: undefined }, { ...urls, feed: { signedUrl: "http://objects.test/feed" } },
  { ...urls, feed: urls.mp3 }]) {
  test("missing, insecure or overlapping targets fail before file uploads", async () => {
    const f = fixture({ urlResult: { ok: true, uploads } });
    await assert.rejects(f.run, /no files uploaded/); assert.equal(f.calls.length, 1);
  });
}
test("missing local metadata prevents even the first remote upload", async () => {
  const f = fixture({ missingFile: "/local/manifest" });
  await assert.rejects(f.run, /Local artifact missing/); assert.equal(f.calls.length, 1);
});
test("upload errors do not disclose signed URLs, bearer tokens or remote bodies", async () => {
  const f = fixture({ statusStage: "mp3", status: 500 });
  await assert.rejects(f.run, (error) => {
    assert.doesNotMatch(error.message, /private-|signature|https:/); return true;
  });
  assert.equal(f.attempts.mp3, 3); assert.equal(f.attempts.complete, undefined);
});


test("publication uses the same content-derived version for upload and completion", async()=>{
 const f=fixture();await f.run();
 const a=JSON.parse(f.calls[0].init.body),b=JSON.parse(f.calls.at(-1).init.body);
 assert.match(a.audioVersion,/^[a-f0-9]{64}$/);assert.equal(a.audioVersion,b.audioVersion);
});
