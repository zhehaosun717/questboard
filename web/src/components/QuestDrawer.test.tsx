import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeQuest, makeSnapshot } from '../lib/testFixtures';
import { QuestDrawer } from './QuestDrawer';

const noop = () => undefined;

function render(quest: ReturnType<typeof makeQuest>, snap: ReturnType<typeof makeSnapshot>) {
  return renderToStaticMarkup(
    <QuestDrawer
      quest={quest}
      snap={snap}
      draft=""
      onDraftChange={noop}
      onClose={noop}
      onSelectQuest={noop}
      onAssignCard={noop}
      refresh={noop}
      pushToast={noop}
      setDragging={noop}
    />,
  );
}

describe('QuestDrawer 修改委托 hook-in', () => {
  it('shows a collapsed 修改委托 section, below 下一步/evidence and above 交回的东西 (RECEIPT)', () => {
    const quest = makeQuest({ id: 'A-1', status: 'delivered', lastDetail: 'owner 验收' });
    const snap = makeSnapshot({ quests: [quest] });
    const html = render(quest, snap);
    expect(html).toContain('修改委托');
    // Anchor on the DrawerSection headings themselves (<span>EN</span>zh), not any mention of the words
    // elsewhere — ReviewSection's own hint text also says "交回的东西" earlier in the drawer.
    expect(html.indexOf('修改委托')).toBeGreaterThan(html.indexOf('<span>EVIDENCE</span>'));
    expect(html.indexOf('修改委托')).toBeLessThan(html.indexOf('<span>RECEIPT</span>'));
  });

  it('is collapsed by default — no form fields rendered until opened', () => {
    const quest = makeQuest({ id: 'A-1' });
    const snap = makeSnapshot({ quests: [quest] });
    const html = render(quest, snap);
    expect(html).toContain('<details');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).not.toContain('标题');
    expect(html).not.toContain('前置委托');
  });
});
