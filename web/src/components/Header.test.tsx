import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Header } from './Header';

const render = (over: { defaultCard?: string | null; defaultCardMissing?: boolean } = {}) =>
  renderToStaticMarkup(<Header tab="board" onTabChange={() => {}} {...over} />);

describe('Header missing default card note', () => {
  it('tells the owner when the default card is not in the roster', () => {
    const html = render({ defaultCard: 'oc-mimo', defaultCardMissing: true });
    expect(html).toContain('默认卡「oc-mimo」不在名册里，去「派遣规则」改掉，或先把卡补进名册。');
  });

  it('stays quiet while the card is present or none is set', () => {
    expect(render({ defaultCard: 'oc-mimo', defaultCardMissing: false })).not.toContain('不在名册里');
    expect(render()).not.toContain('不在名册里');
  });
});
