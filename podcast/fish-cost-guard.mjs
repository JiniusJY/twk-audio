// Conservative expiry: vendor states free access through November30,2026.
// Any extension or paid-model choice requires a reviewed code/config change, never fallback.
export const FREE_FISH_UNTIL = Date.parse('2026-12-01T00:00:00Z');
export function assertFreeFish(model, now = Date.now()) {
  if (model !== 's2.1-pro-free') throw new Error('Paid Fish synthesis blocked; no paid fallback is authorised.');
  if (!Number.isFinite(now) || now >= FREE_FISH_UNTIL) throw new Error('Verified Fish free window expired; recheck vendor terms before synthesis.');
}
