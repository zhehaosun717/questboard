import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { makeQuest } from '../lib/testFixtures';
import { QuestNode, type QuestNodeData } from './QuestNode';

// Renders the real QuestNode.tsx (map pin). Round 3 (PM ruling, fix a): the accept hint and an
// unconfirmed-capability warning share the single 14px row map.css reserves (grid-row 4), the hint first
// so a truncating ellipsis never covers it, and each keeps its own `title` so the full text is reachable
// even when the row is visually cut off.

function render(data: QuestNodeData) {
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <QuestNode
        id="n1"
        data={data}
        type="quest"
        selected={false}
        isConnectable
        zIndex={0}
        dragging={false}
        selectable
        deletable
        draggable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider>,
  );
}

describe('QuestNode accept hint and warning (real JSX, round 3 single-row)', () => {
  it('shows both the accept hint and the warning text, on separate elements sharing one row, each with a full-text title', () => {
    const quest = makeQuest({ id: 'Q-1' });
    const html = render({
      quest,
      dropClass: 'drop-ok',
      dropHint: '放下：派去做',
      dropWarning: '尚未确认这张卡支持 variant，派遣会照常进行',
    });

    expect(html).toContain('放下：派去做');
    expect(html).toContain('尚未确认这张卡支持 variant，派遣会照常进行');

    // Both live on distinct elements, both inside the one drop-line row map.css puts on grid-row 4.
    const lineMatch = html.match(/<span class="drop-line">([\s\S]*?)<\/span><\/div>/);
    expect(lineMatch).toBeTruthy();
    const line = lineMatch![1];
    expect(line).toContain('<span class="drop-hint');
    expect(line).toContain('<span class="drop-warning"');

    const hintMatch = html.match(/<span class="drop-hint[^"]*" title="([^"]*)">([^<]*)<\/span>/);
    expect(hintMatch?.[1]).toBe('放下：派去做');
    expect(hintMatch?.[2]).toBe('放下：派去做');

    const warningMatch = html.match(/<span class="drop-warning"[^>]*title="([^"]*)"[^>]*>/);
    expect(warningMatch?.[1]).toBe('尚未确认这张卡支持 variant，派遣会照常进行');

    // The hint comes before the warning in document order, so an overflow ellipsis on the shared row
    // truncates the warning's tail, never the hint.
    expect(html.indexOf('放下：派去做')).toBeLessThan(
      html.indexOf('尚未确认这张卡支持 variant，派遣会照常进行'),
    );
  });

  it('renders the hint alone (no warning span) when there is no warning', () => {
    const quest = makeQuest({ id: 'Q-2' });
    const html = render({
      quest,
      dropClass: 'drop-ok',
      dropHint: '放下：派去做',
    });

    expect(html).toContain('放下：派去做');
    expect(html).toContain('title="放下：派去做"');
    expect(html).not.toContain('drop-warning');
  });
});
