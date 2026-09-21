// FB2-02 web-side: send-back controls, the hand-to-coordinator button, the owner's save-verdicts button,
// the on-card annotation chip, and the two new statuses' next steps.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeAssignee, makeQuest, makeSnapshot } from '../../lib/testFixtures';
import { nextStep } from '../../lib/nextStep';
import { STATUS } from '../../lib/labels';
import { ReviewSection } from './ReviewSection';
import { OwnerTaskSection } from './OwnerTaskSection';
import { QuestCard } from '../QuestCard';

const noop = () => undefined;

function renderReviewSection(quest: Parameters<typeof makeQuest>[0]) {
  return renderToStaticMarkup(
    <ReviewSection
      quest={makeQuest(quest)}
      snap={makeSnapshot({ quests: [makeQuest(quest)] })}
      draft=""
      onDraftChange={noop}
      onSelectQuest={noop}
      onAssignCard={noop}
      refresh={noop}
      pushToast={noop}
    />,
  );
}

describe('ReviewSection send-back controls (FB2-02)', () => {
  it('offers the needs-coordinator checkbox and the hand-to-coordinator button next to 退回重做', () => {
    const html = renderReviewSection({ id: 'A-9', status: 'delivered' });
    expect(html).toContain('需要 coordinator 处理');
    expect(html).toContain('交给 coordinator 重写简报');
    expect(html).toContain('退回重做');
  });
});

describe('OwnerTaskSection save-verdicts (FB2-02)', () => {
  function renderOwnerSection(quest: Parameters<typeof makeQuest>[0]) {
    return renderToStaticMarkup(
      <OwnerTaskSection quest={makeQuest(quest)} draft="" onDraftChange={noop} refresh={noop} pushToast={noop} />,
    );
  }

  it('offers 保存评审结论 on a needs_owner art quest with a review page', () => {
    const html = renderOwnerSection({ id: 'ART-9', kind: 'art', status: 'needs_owner', reviewPage: 'robot8' });
    expect(html).toContain('保存评审结论');
  });

  it('does not offer it without a review page or on non-art quests', () => {
    expect(renderOwnerSection({ id: 'ART-10', kind: 'art', status: 'needs_owner' })).not.toContain('保存评审结论');
    expect(renderOwnerSection({ id: 'C-10', kind: 'code', status: 'needs_owner', reviewPage: 'robot8' })).not.toContain('保存评审结论');
  });
});

describe('QuestCard annotation chip (FB2-02)', () => {
  function renderCard(quest: Parameters<typeof makeQuest>[0]) {
    const q = makeQuest(quest);
    return renderToStaticMarkup(
      <QuestCard
        quest={q}
        index={0}
        snap={makeSnapshot({ quests: [q] })}
        pickingCardId={null}
        isNew={false}
        statusChanged={false}
        onSelect={noop}
        onDropCard={noop}
      />,
    );
  }

  it('shows 本次派遣包含 N 条批注 when the attempt carries a snapshot', () => {
    const html = renderCard({
      id: 'ART-11',
      kind: 'art',
      status: 'dispatched',
      assignee: makeAssignee('agy-kimi', { annotationSnapshot: { page: 'robot8', title: 't', count: 3, capturedAt: '2026-09-20T00:00:00.000Z', digest: 'a'.repeat(64), path: 'x.md' } }),
    });
    expect(html).toContain('本次派遣包含 3 条批注');
  });

  it('stays quiet without a snapshot', () => {
    expect(renderCard({ id: 'C-11', status: 'posted' })).not.toContain('批注');
  });
});

describe('new statuses (FB2-02)', () => {
  it('labels and columns know needs_coordinator and owner_ruled', () => {
    expect(STATUS.needs_coordinator).toBe('等 coordinator');
    expect(STATUS.owner_ruled).toBe('已裁决');
  });

  it('nextStep sends both to the coordinator, never to a drag', () => {
    const snap = makeSnapshot({ quests: [] });
    const held = nextStep(makeQuest({ id: 'A-12', status: 'needs_coordinator' }), snap);
    expect(held.who).toBe('coordinator');
    expect(held.action).toBe('none');
    const ruled = nextStep(makeQuest({ id: 'ART-12', kind: 'art', status: 'owner_ruled' }), snap);
    expect(ruled.who).toBe('coordinator');
    expect(ruled.title).toContain('coordinator');
    expect(ruled.action).toBe('none');
  });
});
