import { createHash } from 'node:crypto';

export const EDITORIAL_VERSION = 'podcast-editorial-v2';
export function scriptIdentity(script) {
  return createHash('sha256').update(JSON.stringify({ hosts: script.hosts, turns: script.turns, version: EDITORIAL_VERSION })).digest('hex');
}
export function scriptProblems(script) {
  const problems = [];
  if (!script?.hosts?.A?.name || !script?.hosts?.B?.name || script.hosts.A.name === script.hosts.B.name) problems.push('Two distinct named hosts are required');
  const seen = new Map();
  for (const [i, turn] of (script.turns || []).entries()) {
    if (!['A', 'B'].includes(turn.speaker)) problems.push(`Turn ${i + 1}: invalid speaker`);
    const own = script.hosts?.[turn.speaker]?.name?.split(' ')[0];
    if (own && new RegExp(`(?:^|[.!?]\\s+|,\\s*)${own}[,!?]`, 'i').test(turn.text || '')) problems.push(`Turn ${i + 1}: host addresses their own name`);
    if (/\b(?:let's dive in|the evidence frames|the evidence says|the real question is|at its core|that distinction matters|in today's rapidly evolving|a paradigm shift)\b/i.test(turn.text || '')) problems.push(`Turn ${i + 1}: stock presentation language`);
    if (turn.segment === 'subscribe') continue;
    for (const sentence of (turn.text || '').split(/[.!?]+/)) {
      const key = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (key.split(' ').length < 12 || new Set(key.split(' ')).size < 6) continue;
      if (seen.has(key)) problems.push(`Turn ${i + 1}: repeats sentence from turn ${seen.get(key) + 1}`);
      else seen.set(key, i);
    }
  }
  return problems;
}
export function assertScriptQuality(script) {
  const problems = scriptProblems(script);
  if (problems.length) throw new Error(`Podcast editorial review required: ${problems.join('; ')}`);
}
export function continuityContext(turns) {
  // Whole dialogue, not the last three lines. The server rejects oversized context rather than silently losing it.
  return turns.filter(t => t.segment !== 'subscribe').map(t => `${t.speaker}: ${t.text}`).join('\n');
}
