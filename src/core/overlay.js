// Effective adventurer status = the status log overlaid with what the lanes show right now. A current
// bounce greys a card only while it lasts, so the card heals by itself when the limit resets.

export const BOUNCE_WINDOW_MS = 5 * 60 * 60 * 1000;

const key = (lane, model) => `${lane}|${model}`;

function currentBounces(lanes, now) {
  const bounces = new Map();
  for (const row of (lanes && lanes.packages) || []) {
    if (!row || row.state !== 'bounced') continue;
    const at = Date.parse(row.dispatchedAt || '');
    if (Number.isFinite(at) && now - at > BOUNCE_WINDOW_MS) continue;
    bounces.set(key(row.lane, row.model), row);
  }
  return bounces;
}

export function effectiveRoster(adventurers, lanes, now = Date.now()) {
  if (!lanes) return adventurers.map((a) => ({ ...a }));
  const bounces = currentBounces(lanes, now);
  const laneLimits = lanes.laneLimits || {};
  return adventurers.map((adventurer) => {
    if (adventurer.status !== 'available') return { ...adventurer };
    const row = bounces.get(key(adventurer.lane, adventurer.model));
    if (row) {
      return { ...adventurer, status: 'limited', derived: { from: 'lanes', reason: `${row.package} 限额退回${row.bounceUntil ? `，${row.bounceUntil} 恢复` : ''}` } };
    }
    // A limit detected from a file-based lane's output is per subscription, so it greys that lane's cards.
    const limit = laneLimits[adventurer.lane];
    if (limit) {
      return { ...adventurer, status: 'limited', derived: { from: 'lanes', reason: `${adventurer.lane} 限额中${limit.until ? `，${limit.until} 恢复` : ''}` } };
    }
    return { ...adventurer };
  });
}
