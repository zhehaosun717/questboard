// FB2-03 派单前置检查 — the board face of the gates: a held quest says why on its card.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestCard } from '../QuestCard';
import { makeQuest, makeSnapshot } from '../../lib/testFixtures';

const noop = () => {};

describe('FB2-03 dispatch gates on the board', () => {
  function renderCard(partial: Parameters<typeof makeQuest>[0]) {
    const quest = makeQuest(partial);
    return renderToStaticMarkup(
      <QuestCard
        quest={quest}
        index={0}
        snap={makeSnapshot({ quests: [quest] })}
        pickingCardId={null}
        isNew={false}
        statusChanged={false}
        onSelect={noop}
        onDropCard={noop}
      />,
    );
  }

  it('shows the hold reason on the card face', () => {
    const html = renderCard({ id: 'QD-13', hold: '等设计稿' });
    expect(html).toContain('挂起');
    expect(html).toContain('等设计稿');
  });

  it('no hold, no chip', () => {
    const html = renderCard({ id: 'QD-14' });
    expect(html).not.toContain('⏸');
  });
});

describe('check column red line (FB2-04 item 4)', () => {
  const HOUR = 3600 * 1000;
  it('paints a quest red once it waited past the threshold, and names the wait', () => {
    const quest = makeQuest({ id: 'CK-9', status: 'delivered', statusAt: new Date(Date.now() - 30 * HOUR).toISOString() });
    const html = renderToStaticMarkup(
      <QuestCard
        quest={quest}
        index={0}
        snap={makeSnapshot({ quests: [quest], reviewBacklogRedAfterHours: 12 })}
        pickingCardId={null}
        isNew={false}
        statusChanged={false}
        onSelect={noop}
        onDropCard={noop}
      />,
    );
    expect(html).toContain('qb-overdue');
    expect(html).toContain('已等');
  });

  it('a fresh delivery is not red', () => {
    const quest = makeQuest({ id: 'CK-10', status: 'delivered', statusAt: new Date(Date.now() - HOUR).toISOString() });
    const html = renderToStaticMarkup(
      <QuestCard
        quest={quest}
        index={0}
        snap={makeSnapshot({ quests: [quest], reviewBacklogRedAfterHours: 12 })}
        pickingCardId={null}
        isNew={false}
        statusChanged={false}
        onSelect={noop}
        onDropCard={noop}
      />,
    );
    expect(html).not.toContain('qb-overdue');
  });
});

describe('batch card face (FB2-04 item 5)', () => {
  it('shows 和 X、Y 一批 · 等 Z on a batched quest', () => {
    const quest = makeQuest({ id: 'B-1', batch: ['B-1', 'B-2', 'B-4'], waitingOn: 'B-3' });
    const html = renderToStaticMarkup(
      <QuestCard quest={quest} index={0} snap={makeSnapshot({ quests: [quest] })} pickingCardId={null} isNew={false} statusChanged={false} onSelect={noop} onDropCard={noop} />,
    );
    expect(html).toContain('和 B-2、B-4 一批');
    expect(html).toContain('等 B-3');
  });

  it('a lone quest shows no batch line', () => {
    const quest = makeQuest({ id: 'B-9' });
    const html = renderToStaticMarkup(
      <QuestCard quest={quest} index={0} snap={makeSnapshot({ quests: [quest] })} pickingCardId={null} isNew={false} statusChanged={false} onSelect={noop} onDropCard={noop} />,
    );
    expect(html).not.toContain('一批');
  });
});
