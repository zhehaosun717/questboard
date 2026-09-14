import type { LaneHistoryEntry, LanePackage } from '../api/types';

export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '0s';
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function splitStale(packages: LanePackage[]): {
  active: LanePackage[];
  stale: LanePackage[];
} {
  const active: LanePackage[] = [];
  const stale: LanePackage[] = [];
  for (const p of packages) {
    if (p.stale) {
      stale.push(p);
    } else {
      active.push(p);
    }
  }
  return { active, stale };
}

export type PackageHistoryEvent = LaneHistoryEntry & { package: string };

export function recentEvents(
  packages: LanePackage[],
  limit = 30,
): PackageHistoryEvent[] {
  const events: PackageHistoryEvent[] = [];
  for (const p of packages) {
    if (p.history) {
      for (const h of p.history) {
        events.push({ ...h, package: p.package });
      }
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, limit);
}

export function laneLabel(lane: string): string {
  const mapping: Record<string, string> = {
    opencode: 'OpenCode',
    codex: 'Codex',
    agy: 'Gemini',
  };
  return mapping[lane] ?? lane;
}

export function formatHistoryEvent(entry: LaneHistoryEntry): string {
  if (entry.event === 'dispatch') {
    return `派出 → ${laneLabel(entry.lane)} ${entry.model}`;
  }
  return entry.text;
}
