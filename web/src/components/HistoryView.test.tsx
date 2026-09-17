import { describe, expect, it } from 'vitest';
import type { LaneEvidence, LaneLimit } from '../api/types';
import { buildLaneEvidenceRows, evidenceReason, laneLimitUntilLabel } from './HistoryView';

// HistoryView itself self-fetches (no props to inject a report), so this tests the pure functions behind the
// feedback9 requirement 5 addition directly: laneEvidence is shown as history/diagnostics, worded neutrally
// (N16), never as a limit.

describe('evidenceReason', () => {
  it('words an owner-cleared entry neutrally, never claiming the owner acted (N16)', () => {
    expect(evidenceReason('owner')).toBe('这张卡已不算限额');
    expect(evidenceReason('owner')).not.toContain('确认');
  });

  it('names a status-cleared and a no_card entry distinctly', () => {
    expect(evidenceReason('status')).toBe('该卡片状态已改变');
    expect(evidenceReason('no_card')).toBe('名册里已经没有这张卡');
  });

  it('falls back to a generic expired/unattributable label with no cleared marker', () => {
    expect(evidenceReason(undefined)).toBe('已过期或对不上具体卡的证据');
  });

  it('falls back the same way for an unrecognized future cleared value', () => {
    expect(evidenceReason('something-new')).toBe('已过期或对不上具体卡的证据');
  });
});

describe('buildLaneEvidenceRows', () => {
  it('flattens every lane\'s cards into rows, each carrying the lane, a display name and a reason', () => {
    const laneEvidence: Record<string, LaneEvidence> = {
      codex: {
        cards: {
          'codex-luna': { since: 's', at: 'a', until: null, resetsAt: null, adventurerId: 'codex-luna', name: 'a-old', cleared: 'owner' },
          'codex-astra': { since: 's', at: 'a', until: '9:50 AM', resetsAt: '2020-01-01T00:00:00.000Z', adventurerId: 'codex-astra', name: 'b-expired' },
        },
        unidentified: [],
      },
    };
    const rows = buildLaneEvidenceRows(laneEvidence);
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({ key: 'codex-codex-luna', lane: 'codex', name: 'a-old', reason: '这张卡已不算限额' });
    expect(rows).toContainEqual({ key: 'codex-codex-astra', lane: 'codex', name: 'b-expired', reason: '已过期或对不上具体卡的证据' });
  });

  it('falls back to the adventurer id when a card carries no name', () => {
    const laneEvidence: Record<string, LaneEvidence> = {
      codex: { cards: { 'codex-luna': { since: 's', at: 'a', until: null, resetsAt: null, adventurerId: 'codex-luna', name: '' } }, unidentified: [] },
    };
    const rows = buildLaneEvidenceRows(laneEvidence);
    expect(rows[0]?.name).toBe('codex-luna');
  });

  it('is empty for an undefined or empty laneEvidence (older server / nothing to show)', () => {
    expect(buildLaneEvidenceRows(undefined)).toEqual([]);
    expect(buildLaneEvidenceRows({})).toEqual([]);
  });

  it('N1: also surfaces unidentified evidence, worded the same as an unattributable entry', () => {
    const laneEvidence: Record<string, LaneEvidence> = {
      codex: {
        cards: {},
        unidentified: [{ since: 's', at: 'a', until: null, resetsAt: null, name: 'x-unid' }],
      },
    };
    const rows = buildLaneEvidenceRows(laneEvidence);
    expect(rows).toContainEqual({ key: 'codex-unid-0', lane: 'codex', name: 'x-unid', reason: '已过期或对不上具体卡的证据' });
  });

  it('N1: falls back to a generic name when unidentified evidence carries none', () => {
    const laneEvidence: Record<string, LaneEvidence> = {
      codex: { cards: {}, unidentified: [{ since: 's', at: 'a', until: null, resetsAt: null }] },
    };
    const rows = buildLaneEvidenceRows(laneEvidence);
    expect(rows[0]?.name).toBe('未知来源');
  });
});

function laneLimit(over: Partial<LaneLimit> = {}): LaneLimit {
  return {
    since: '2026-09-16T08:00:00.000Z',
    at: '2026-09-16T08:00:00.000Z',
    until: '10:50 AM',
    resetsAt: '2099-01-01T00:00:00.000Z',
    adventurerId: 'card-a',
    name: 'a',
    cards: {},
    ...over,
  };
}

describe('laneLimitUntilLabel (B3: never a stale recovery time)', () => {
  it('shows the recovery time when resetsAt is a real future time', () => {
    expect(laneLimitUntilLabel(laneLimit())).toBe('，10:50 AM 恢复');
  });

  it('shows nothing once resetsAt is null, even with a dated until string (N11 Codex-dated form)', () => {
    expect(laneLimitUntilLabel(laneLimit({ until: 'Sep 1st, 2026 1:54 PM', resetsAt: null }))).toBe('');
  });

  it('shows nothing once the known reset has already passed', () => {
    expect(laneLimitUntilLabel(laneLimit({ resetsAt: '2020-01-01T00:00:00.000Z' }))).toBe('');
  });

  it('shows nothing when there is no until at all', () => {
    expect(laneLimitUntilLabel(laneLimit({ until: null }))).toBe('');
  });
});
