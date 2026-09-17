import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { apiFieldPatch, toDrafts, type LaneDraft } from '../../lib/settingsForm';
import { LaneCard } from './LaneCard';

// Renders the real LaneCard.tsx (not a stand-in) so a JSX regression — a wrong condition on which block or
// which fields show — is caught the same way a human clicking through the settings tab would catch it.
const API = 'http://127.0.0.1:6096';

function draftLane(rawLane: Record<string, unknown>): LaneDraft {
  const drafts = toDrafts({ name: 'P', lanes: { oc: { run: ['node', 'x.js'], ...rawLane } } });
  const lane = drafts.lanes[0];
  if (!lane) throw new Error('toDrafts did not produce a lane');
  return lane;
}

function render(lane: LaneDraft, errors: Record<string, string>) {
  return renderToStaticMarkup(
    <LaneCard
      lane={lane}
      index={0}
      errors={errors}
      server={undefined}
      serverStarting={false}
      serverMessage={undefined}
      onStartServer={() => {}}
      onUpdate={() => {}}
      onRemove={() => {}}
    />,
  );
}

const pathInputId = 'id="cfg-lane-health-path-0"';
const checkboxRowMarker = '健康检查 (health';
const protocolSelectId = 'id="cfg-lane-protocol-0"';

describe('LaneCard health block (real JSX)', () => {
  it('a plain lane with no api and no health shows neither the api-server panel nor the health block', () => {
    const lane = draftLane({});
    const html = render(lane, {});
    expect(html).not.toContain(checkboxRowMarker);
  });

  it('a lane with api but no health configured shows the checkbox unchecked, fields hidden', () => {
    const lane = draftLane({ api: API });
    const html = render(lane, {});
    expect(html).toContain(checkboxRowMarker);
    expect(html).not.toContain(pathInputId);
  });

  it('C1: clearing api on a lane that still has a configured health path keeps the block reachable, with a visible error', () => {
    const lane: LaneDraft = { ...draftLane({}), healthPath: '/global/health', healthJson: '{"healthy":true}' };
    expect(lane.api).toBe('');
    const errors = { 'lanes.0.healthPath': '健康检查需要先填接口服务 (api)；不需要健康检查就把它关掉' };
    const html = render(lane, errors);
    expect(html).toContain(checkboxRowMarker);
    // The checkbox stays usable (checked, with its fields shown) so the owner can see and clear it.
    expect(html).toContain(pathInputId);
    expect(html).toContain('健康检查需要先填接口服务');
  });

  it('C2: health.json without healthPath (a hand-edited file) opens the fields and shows the error, without needing a prior click', () => {
    const lane = draftLane({ api: API, health: { json: { healthy: true } } });
    expect(lane.healthPath).toBe('');
    expect(lane.healthJson).not.toBe('');
    const errors = { 'lanes.0.healthJson': '填了期望字段就要先填健康检查路径' };
    const html = render(lane, errors);
    expect(html).toContain(pathInputId);
    expect(html).toContain('填了期望字段就要先填健康检查路径');
  });

  it('a lane with an already-configured health contract opens with the path visible', () => {
    const lane = draftLane({ api: API, health: { path: '/global/health' } });
    const html = render(lane, {});
    expect(html).toContain(pathInputId);
  });

  it('C4: an api error (trailing slash) surfaces on the api field once health is set', () => {
    const lane: LaneDraft = { ...draftLane({ api: `${API}/` }), healthPath: '/global/health' };
    const errors = { 'lanes.0.api': '开启健康检查时，接口服务 (api) 不能以 / 结尾（会和健康检查路径拼接）' };
    const html = render(lane, errors);
    expect(html).toContain('不能以 / 结尾');
  });

  // S1's "shows the hint once genuinely blank and open" side is not exercised here: the hint only appears
  // while `healthOpen` (the box was just checked, nothing typed yet) is true, and that is local React state
  // that starts fresh on every render() in this file — there is no prop-only way to represent "checked, but
  // still blank" the way there is for every other case in this suite. It would need a mounted-and-interacted
  // test (fireEvent on the checkbox), which needs a DOM environment (e.g. jsdom) this project does not have
  // installed; adding one is outside this brief's "no dependency installs". The reachable, previously-broken
  // half — a blank path is never a safe no-op once healthJson or healthMalformed says otherwise — is covered
  // below and by the R1 tests.
  it('contradictory-hint fix: an empty path with json still filled does not show the "saves as no health check" hint', () => {
    // Same json-only shape as C2, but this time asserting on the hint rather than the error — the two must
    // never both be visible, since one says "this is fine as no-op" and the other blocks the save.
    const lane: LaneDraft = { ...draftLane({ api: API }), healthJson: '{"healthy":true}' };
    expect(lane.healthPath).toBe('');
    const errors = { 'lanes.0.healthJson': '填了期望字段就要先填健康检查路径' };
    const html = render(lane, errors);
    expect(html).not.toContain('路径留空保存 = 不做健康检查');
    expect(html).toContain('填了期望字段就要先填健康检查路径');
  });

  describe('R1: malformed health from a hand-edited file', () => {
    it('opens checked with an explanatory message, with no save attempt and no errors prop needed', () => {
      const lane = draftLane({ api: API, health: { timeout: 5 } });
      expect(lane.healthMalformed).toEqual({ timeout: 5 });
      const html = render(lane, {});
      expect(html).toContain(pathInputId);
      expect(html).toContain('写法不对');
      expect(html).toContain('没有可用的 path 字段');
    });

    it('an empty object and a null health are both shown, not silently treated as no health', () => {
      for (const health of [{}, null]) {
        const lane = draftLane({ api: API, health });
        const html = render(lane, {});
        expect(html).toContain(pathInputId);
        expect(html).toContain('写法不对');
      }
    });

    it('R1c: an invalid path alongside json shows the json too, not just the path banner', () => {
      const lane = draftLane({ api: API, health: { path: null, json: { healthy: true }, timeout: 5 } });
      expect(lane.healthMalformed).toEqual({ path: null, json: { healthy: true }, timeout: 5 });
      expect(lane.healthJson).toBe('{"healthy":true}');
      const html = render(lane, {});
      expect(html).toContain(pathInputId);
      expect(html).toContain('写法不对');
      // The json textarea shows what the file expects (quotes HTML-escaped by SSR, same as any other text).
      expect(html).toContain('{&quot;healthy&quot;:true}');
    });
  });

  describe('should-fix: a bad repair shows its own reason; a valid repair clears the stale banner', () => {
    it('typing an invalid repair path (e.g. "abc") shows the real format error instead of hiding behind the generic malformed banner', () => {
      const lane = draftLane({ api: API, health: { timeout: 5 } });
      const repaired: LaneDraft = { ...lane, healthPath: 'abc' };
      expect(repaired.healthMalformed).toEqual({ timeout: 5 });
      const errors = { 'lanes.0.healthPath': '健康检查路径必须是以 / 开头的相对路径，不能是 //、带反斜杠或空白（比如 /global/health）' };
      const html = render(repaired, errors);
      expect(html).toContain('必须是以 / 开头');
    });

    it('a valid repair removes the stale "写法不对" banner even though healthMalformed is still set until Save', () => {
      const lane = draftLane({ api: API, health: { timeout: 5 } });
      const repaired: LaneDraft = { ...lane, healthPath: '/global/health' };
      expect(repaired.healthMalformed).toEqual({ timeout: 5 });
      const html = render(repaired, {});
      expect(html).not.toContain('写法不对');
    });
  });

  describe('R2: checked/open state comes from the draft, not stale position-keyed errors', () => {
    it('failed-save then uncheck: a stale error for this slot must not keep the box checked or the fields open', () => {
      // What onUpdate({ healthPath: '', healthJson: '', healthMalformed: undefined }) leaves behind right after
      // the owner unchecks, with api already cleared earlier — the save-time error for this slot is still in
      // `errors` because nothing has re-validated since the failed save.
      const lane: LaneDraft = { ...draftLane({}), healthPath: '', healthJson: '' };
      const staleErrors = { 'lanes.0.healthPath': '健康检查需要先填接口服务 (api)；不需要健康检查就把它关掉' };
      const html = render(lane, staleErrors);
      expect(html).not.toContain(checkboxRowMarker);
    });

    it('failed-save then delete a different lane: this lane inheriting the deleted lane\'s stale index-keyed error must not open its box', () => {
      // Lane "b" (has api, no health) slides into index 0 after lane "a" (had the health error) is deleted.
      // `errors['lanes.0.healthPath']` is still "a"'s message; nothing about "b" is actually invalid.
      const lane = draftLane({ api: API });
      const staleErrors = { 'lanes.0.healthPath': '健康检查路径必须是以 / 开头的相对路径，不能是 //、带反斜杠或空白（比如 /global/health）' };
      const html = render(lane, staleErrors);
      expect(html).toContain(checkboxRowMarker);
      expect(html).not.toContain(pathInputId);
    });
  });

  describe('LaneCard optionalArgs collapsed section', () => {
    it('renders the collapsed 可选参数 summary section with empty state when unconfigured', () => {
      const lane = draftLane({});
      const html = render(lane, {});
      expect(html).toContain('可选参数 (Optional Arguments)');
      expect(html).toContain('未配置');
      expect(html).toContain('lane-optional-args-section');
      expect(html).toContain('命令预览 (Argv Preview)');
    });

    it('shows group count badge when optionalArgs are configured', () => {
      const lane: LaneDraft = {
        ...draftLane({}),
        optionalArgs: [
          { when: 'variant', args: ['--effort', '{variant}'], omitWhen: ['none'], insertAt: 2 },
        ],
      };
      const html = render(lane, {});
      expect(html).toContain('已配置 1 组');
      expect(html).toContain('当卡片填了 variant 时，在第 3 个位置插入 --effort {variant}；值为 none 时整组省略');
    });

    it('automatically opens details section when an error exists on optionalArgs', () => {
      const lane = draftLane({});
      const errors = { 'lanes.0.optionalArgs[0].args': '参数不能为空白' };
      const html = render(lane, errors);
      expect(html).toContain('<details class="lane-optional-args-section" open=""');
    });
  });

  describe('Bundle 3: protocol select', () => {
    it('a plain lane with no api shows no protocol select', () => {
      const lane = draftLane({});
      const html = render(lane, {});
      expect(html).not.toContain(protocolSelectId);
    });

    it('a lane with api shows the select, defaulted, with the one accepted value listed', () => {
      const lane = draftLane({ api: API });
      const html = render(lane, {});
      expect(html).toContain(protocolSelectId);
      expect(html).toContain('opencode-session');
    });

    it('shows the field error next to the label when present', () => {
      const lane = draftLane({ api: API });
      const errors = { 'lanes.0.protocol': '协议只能是：opencode-session' };
      const html = render(lane, errors);
      expect(html).toContain('协议只能是：opencode-session');
    });

    it('M1: a lane loaded with api+protocol, api cleared via the api field\'s own patch, hides the select with no stray error', () => {
      const lane: LaneDraft = { ...draftLane({ api: API, protocol: 'opencode-session' }), ...apiFieldPatch('') };
      expect(lane.protocol).toBe('');
      const html = render(lane, {});
      expect(html).not.toContain(protocolSelectId);
      expect(html).not.toContain('field-error');
    });
  });
});
