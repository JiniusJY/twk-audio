import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const UPLOAD_KEYS = ["mp3", "transcript", "manifest", "feed"];
function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === "string" && url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

/** Bounded publish I/O. Only URL creation and identical-key PUTs retry. */
export async function publishPodcastFiles({
  baseUrl, secret, slug, files,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  sleepImpl = sleep,
  apiTimeoutMs = 30_000,
  uploadTimeoutMs = 180_000,
  log = () => {},
}) {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/automation/podcast`;
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };

  async function request(label, url, options, { timeoutMs, json = false, retry = false }) {
    for (let attempt = 1; attempt <= (retry ? 3 : 1); attempt++) {
      try {
        const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          const error = new Error(`${label} returned HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        if (json) return await response.json();
        await response.body?.cancel().catch(() => {});
        return;
      } catch (cause) {
        const transient = !cause.status || cause.status === 429 || cause.status >= 500;
        if (!retry || !transient || attempt === 3) {
          // Never include signed URLs, bearer tokens or remote response bodies in errors.
          const detail = cause.status ? `HTTP ${cause.status}` : "network, timeout or invalid response";
          throw new Error(`${label} failed (${detail}) after ${attempt} attempt(s)`);
        }
        log(`${label}: transient failure, retry ${attempt}/2`);
        await sleepImpl(1000 * 2 ** (attempt - 1));
      }
    }
  }

  // Content-addressed audio avoids stale same-URL media after a correction.
  const mp3Entry = files.find(([key]) => key === "mp3");
  if (!mp3Entry) throw new Error("Prepared MP3 missing");
  const audioBytes = await readFileImpl(mp3Entry[1]);
  const audioVersion = createHash("sha256").update(audioBytes).digest("hex");
  const result = await request("upload-url", endpoint, {
    method: "POST", headers, body: JSON.stringify({ action: "upload-url", slug, audioVersion }),
  }, { timeoutMs: apiTimeoutMs, json: true, retry: true });
  const uploads = result?.uploads;
  if (result?.ok !== true || !uploads || UPLOAD_KEYS.some((key) => !isHttpsUrl(uploads[key]?.signedUrl))) {
    throw new Error("upload-url response did not contain all four HTTPS upload targets; no files uploaded");
  }
  if (new Set(UPLOAD_KEYS.map((key) => {
    const url = new URL(uploads[key].signedUrl);
    return url.origin + url.pathname;
  })).size !== UPLOAD_KEYS.length) throw new Error("Upload targets overlap; no files uploaded");
  if (files.length !== UPLOAD_KEYS.length || new Set(files.map(([key]) => key)).size !== UPLOAD_KEYS.length
    || files.some(([key]) => !UPLOAD_KEYS.includes(key))) throw new Error("Expected exactly four podcast upload files");

  // Check all local artifacts before overwriting any remote object.
  const loaded = [];
  for (const [key, filePath, contentType] of files) loaded.push([key, key === "mp3" ? audioBytes : await readFileImpl(filePath), contentType]);
  for (const [key, bytes, contentType] of loaded) {
    await request(`Upload ${key}`, uploads[key].signedUrl, {
      method: "PUT", headers: { "Content-Type": contentType }, body: bytes,
    }, { timeoutMs: uploadTimeoutMs, retry: true });
  }

  // Completion mutates a shared episode index. A lost response may follow a committed
  // write; repeating the POST is not assumed safe under concurrent episode publication.
  try {
    const done = await request("Website completion", endpoint, {
      method: "POST", headers, body: JSON.stringify({ action: "complete", slug, audioVersion }),
    }, { timeoutMs: apiTimeoutMs, json: true });
    if (done?.ok !== true || !isHttpsUrl(done.episodeUrl)) {
      throw new Error("Completion response could not confirm publication");
    }
    return done;
  } catch {
    throw new Error("Website completion failed or its outcome is uncertain. No automatic completion retry was made. Local files remain ready. Check the website episode and index before rerunning publication.");
  }
}
