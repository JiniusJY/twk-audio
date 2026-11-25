import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export function publicIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !([0, 10, 127].includes(a) || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)) || (a === 192 && b === 0) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
};

export function decodeHtmlEntities(str) {
  return String(str || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower];
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    return full;
  });
}

export function extractReadableText(html) {
  const stripBoilerplate = (raw) =>
    decodeHtmlEntities(
      String(raw || '')
        .replace(/<(script|style|noscript|svg|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    )
      .replace(/\s+/g, ' ')
      .trim();

  const articleMatches = [...String(html || '').matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  if (articleMatches.length) {
    const focused = stripBoilerplate(articleMatches.map((m) => m[2]).join(' '));
    if (focused.length >= 500) return focused.slice(0, 16000);
  }
  return stripBoilerplate(html).slice(0, 16000);
}

/** Resolve and pin a public address on each hop; no cookies or credentials. */
export function readPublicPage(raw, hops = 0) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || hops > 3) {
    return Promise.reject(new Error('Unsafe source URL'));
  }
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        timeout: 10000,
        autoSelectFamily: false,
        lookup: (host, options, done) =>
          dns.lookup(host, { family: 4 }, (err, address, family) => {
            if (err || !publicIPv4(address)) return done(new Error('Private source address blocked'));
            done(null, address, family);
          }),
        headers: { 'user-agent': 'TechWhoKnows-Podcast/1.0', accept: 'text/html,text/plain' },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (!res.headers.location) return reject(new Error('Redirect missing'));
          return resolve(readPublicPage(new URL(res.headers.location, url).href, hops + 1));
        }
        if (res.statusCode !== 200 || !/text\/(html|plain)/.test(res.headers['content-type'] || '')) {
          res.resume();
          return reject(new Error('Source unavailable'));
        }
        let bytes = 0;
        let settled = false;
        const chunks = [];
        const finish = (fn, val) => {
          if (settled) return;
          settled = true;
          fn(val);
        };
        res.on('data', (c) => {
          if (settled) return;
          bytes += c.length;
          if (bytes > 1500000) {
            finish(resolve, Buffer.concat(chunks).toString('utf8'));
            request.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('error', (err) => finish(reject, err));
        res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      },
    );
    request.on('timeout', () => request.destroy(new Error('Source timeout')));
    request.on('error', reject);
  });
}

export async function fetchTavilyFallback(source, { apiKey = process.env.TAVILY_API_KEY, fetchImpl = fetch } = {}) {
  if (!apiKey) return [];
  const upstream = [];
  const externalUrls = [...new Set(source.originalUrls || [])]
    .filter((raw) => {
      try {
        const u = new URL(raw);
        return u.protocol === 'https:' && u.hostname !== 'techwhoknows.com' && !u.hostname.endsWith('.techwhoknows.com');
      } catch {
        return false;
      }
    })
    .slice(0, 3);

  const pushEntry = (url, rawText) => {
    const text = decodeHtmlEntities(String(rawText || ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 16000);
    if (text.length < 300 || /just a moment|verify you are human|access denied/i.test(text.slice(0, 600))) return;
    upstream.push({
      url,
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
      retrievedAt: new Date().toISOString(),
    });
  };

  if (externalUrls.length) {
    try {
      const res = await fetchImpl('https://api.tavily.com/extract', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: externalUrls }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        for (const item of data?.results || []) {
          if (item?.url && item?.raw_content) pushEntry(item.url, item.raw_content);
        }
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {}
  }

  if (!upstream.length && source.title) {
    try {
      const res = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: source.title,
          max_results: 3,
          include_raw_content: true,
          exclude_domains: ['techwhoknows.com'],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        for (const item of data?.results || []) {
          if (item?.url && (item?.raw_content || item?.content)) {
            pushEntry(item.url, item.raw_content || item.content);
          }
        }
      } else {
        await res.body?.cancel().catch(() => {});
      }
    } catch {}
  }

  return upstream;
}

export async function collectEvidence(sources, read = readPublicPage, { tavilyKey = process.env.TAVILY_API_KEY, fetchImpl = fetch } = {}) {
  const results = await Promise.all(
    sources.map(async (source, idx) => {
      let upstream = [];
      for (const url of [...new Set(source.originalUrls || [])].slice(0, 3)) {
        try {
          const host = new URL(url).hostname;
          if (host === 'techwhoknows.com' || host.endsWith('.techwhoknows.com')) continue;
          const html = await read(url);
          const text = extractReadableText(html);
          if (text.length < 300 || /just a moment|verify you are human|access denied/i.test(text.slice(0, 600))) continue;
          upstream.push({
            url,
            text,
            sha256: createHash('sha256').update(text).digest('hex'),
            retrievedAt: new Date().toISOString(),
          });
        } catch {}
      }
      if (!upstream.length && tavilyKey) {
        upstream = await fetchTavilyFallback(source, { apiKey: tavilyKey, fetchImpl });
      }
      if (!upstream.length) {
        if (idx === 0) throw new Error(`Original source verification blocked for ${source.id}`);
        return null;
      }
      return { ...source, upstream };
    }),
  );
  const valid = results.filter(Boolean);
  if (!valid.length) throw new Error(`Original source verification blocked for ${sources[0]?.id || 'src-1'}`);
  return valid;
}
