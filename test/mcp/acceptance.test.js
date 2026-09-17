// Feedback 15: questboard_set_quest_status carries an optional acceptance input through to the status route
// with `by: author` (the actor the server checks it against), and questboard_get_quest carries the resulting
// `acceptance` field back additively, same as every other quest field. A stub `request` stands in for the
// HTTP round trip, matching test/mcp/evidence.test.js's pattern.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';
import { createTools } from '../../src/mcp/tools.js';

describe('questboard_set_quest_status — acceptance (feedback 15)', () => {
  it('sends the acceptance input alongside status/by, and returns it in the summary', async () => {
    const { config } = makeProject();
    let sentBody;
    const acceptedQuest = {
      id: 'RUN-4', status: 'done', kind: 'code', priority: 2, title: 'x', revision: 2, parents: [],
      acceptance: { actor: 'coordinator', evidenceRefs: [{ kind: 'report', ref: '.work/oc/mod1.md', digest: 'd1', attemptId: 'a1' }], note: '看过了' },
    };
    const tools = createTools({
      config, base: 'http://test', author: 'coordinator', home: {},
      request: async (base, route, method, body) => {
        if (route === '/api/quests/RUN-4/status' && method === 'POST') { sentBody = body; return { quest: acceptedQuest }; }
        throw new Error(`unexpected route in test stub: ${route}`);
      },
    });
    const setStatus = tools.find((t) => t.name === 'questboard_set_quest_status');
    const result = await setStatus.handler({
      id: 'RUN-4', status: 'done',
      acceptance: { actor: 'coordinator', evidenceRefs: [{ kind: 'report', digest: 'd1', attemptId: 'a1' }], note: '看过了' },
    });
    assert.deepEqual(sentBody.acceptance, { actor: 'coordinator', evidenceRefs: [{ kind: 'report', digest: 'd1', attemptId: 'a1' }], note: '看过了' });
    assert.equal(sentBody.by, 'coordinator', 'the same identity the server checks acceptance.actor against');
    assert.deepEqual(result.acceptance, acceptedQuest.acceptance);
  });

  it('omits acceptance from the request when the caller passes none', async () => {
    const { config } = makeProject();
    let sentBody;
    const tools = createTools({
      config, base: 'http://test', author: 'coordinator', home: {},
      request: async (base, route, method, body) => {
        sentBody = body;
        return { quest: { id: 'RUN-4', status: 'needs_owner', kind: 'code', priority: 2, title: 'x', revision: 1, parents: [] } };
      },
    });
    const setStatus = tools.find((t) => t.name === 'questboard_set_quest_status');
    const result = await setStatus.handler({ id: 'RUN-4', status: 'needs_owner' });
    assert.equal('acceptance' in sentBody, false);
    assert.equal('acceptance' in result, false);
  });
});
