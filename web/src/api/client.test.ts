import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('preview route errors', () => {
  const request = {
    lane: { id: 'test-lane', run: ['node', 'worker.js'], outputDir: 'out' },
    card: { model: 'model-a', variant: '', agent: '' },
    sample: { name: 'w-1', brief: 'brief.md', package: 'PKG-1' },
  };

  it('retains the router status for an unknown preview route', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    await expect(api.lanePreview(request)).rejects.toMatchObject({ status: 404, message: 'not found' });
  });

  it('does not turn a 400 engine refusal containing not found into an old-server result', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'Git Bash not found; configure bash' }), { status: 400 }));
    await expect(api.lanePreview(request)).rejects.toMatchObject({ status: 400, message: 'Git Bash not found; configure bash' });
  });
});
