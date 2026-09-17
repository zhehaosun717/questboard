import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeQuest } from '../../lib/testFixtures';
import { AcceptancePanel } from './AcceptancePanel';

// Same constraint as EvidenceSection.test.tsx: no DOM test environment is installed here, so the on-demand
// fetch inside the effect never fires under SSR. What IS reachable is the synchronous loading render — proof
// this additive, old-server-safe panel does not crash before its fetch would resolve.
describe('AcceptancePanel (SSR)', () => {
  it('shows a loading note before the on-demand fetch would resolve, and nothing crashes with no evidence yet', () => {
    const quest = makeQuest({ id: 'AP-W-1' });
    const html = renderToStaticMarkup(<AcceptancePanel quest={quest} onChange={() => {}} />);
    expect(html).toContain('证据读取中');
    expect(html).toContain('选择这次验收依据的证据');
  });
});
