import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { Card, LanePreviewRequest, LanePreviewResponse } from '../../api/types';
import { parseHealthJson, parseLaneEnv, type LaneDraft } from '../../lib/settingsForm';

export interface ArgvPreviewProps {
  lane: LaneDraft;
  roster?: readonly Card[];
  initialPreview?: LanePreviewResponse | null;
  initialUnsupported?: boolean;
  initialError?: string | null;
}

export function cardPreviewValues(card: Card): { model: string; variant: string; agent: string } {
  return {
    model: card.model,
    variant: card.variant ?? '',
    agent: card.agent ?? '',
  };
}

export function buildPreviewLane(lane: LaneDraft): Record<string, unknown> {
  const payload: Record<string, unknown> = { id: lane.id, run: [...lane.run] };
  if (lane.outputDir.trim()) payload.outputDir = lane.outputDir.trim();
  if (lane.api.trim()) payload.api = lane.api.trim();
  if (lane.serve.length > 0) payload.serve = [...lane.serve];
  if (lane.deliveryDir.trim()) payload.deliveryDir = lane.deliveryDir.trim();
  if (lane.defaultModel.trim()) payload.defaultModel = lane.defaultModel.trim();
  if (lane.editCounter.trim()) payload.editCounter = lane.editCounter.trim();
  if (lane.serialize) payload.serialize = true;
  if (lane.spacingMs.trim()) payload.spacingMs = Number(lane.spacingMs.trim());

  const parsedEnv = parseLaneEnv(lane.env);
  if (Object.keys(parsedEnv.env).length > 0) payload.env = parsedEnv.env;

  if (lane.sessionRun.length > 0 || lane.sessionSaveTo.trim()) {
    const session: Record<string, unknown> = { run: [...lane.sessionRun] };
    if (lane.sessionSaveTo.trim()) session.saveTo = lane.sessionSaveTo.trim();
    payload.session = session;
  }

  if (lane.healthPath.trim()) {
    const health: Record<string, unknown> = { path: lane.healthPath.trim() };
    if (lane.healthJson.trim()) {
      const parsedHealth = parseHealthJson(lane.healthJson);
      if (Object.keys(parsedHealth.json).length > 0) health.json = parsedHealth.json;
    }
    payload.health = health;
  } else if (lane.healthMalformed !== undefined) {
    payload.health = lane.healthMalformed;
  }

  if (lane.optionalArgsMalformed !== undefined) {
    payload.optionalArgs = lane.optionalArgsMalformed;
  } else if (lane.optionalArgs && lane.optionalArgs.length > 0) {
    payload.optionalArgs = lane.optionalArgs.map((group) => {
      if (group.parseError && Object.prototype.hasOwnProperty.call(group, 'rawOptionalArg')) return group.rawOptionalArg;
      const { when, args, omitWhen, insertAt, ...unknown } = group;
      return {
        ...unknown,
        when,
        args: [...args],
        ...(omitWhen && omitWhen.length > 0 ? { omitWhen: [...omitWhen] } : {}),
        ...(typeof insertAt === 'number' ? { insertAt } : {}),
      };
    });
  }
  return payload;
}

// The preview request must be invalidated by every draft edit, including fields
// which are omitted from a valid payload or currently fail parsing.
export function previewLaneDraftKey(lane: LaneDraft): string {
  return JSON.stringify(lane);
}

export function isUnsupportedPreviewError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function ArgvPreview({
  lane,
  roster,
  initialPreview = null,
  initialUnsupported = false,
  initialError = null,
}: ArgvPreviewProps) {
  const [localRoster, setLocalRoster] = useState<readonly Card[]>(roster || []);
  const [selectedCardId, setSelectedCardId] = useState<string>('');

  const [model, setModel] = useState<string>(lane.defaultModel || '');
  const [variant, setVariant] = useState<string>('');
  const [agent, setAgent] = useState<string>('');
  const sampleName = 'w-1';
  const [sampleBrief, setSampleBrief] = useState<string>('docs/briefs/SAMPLE-1.md');
  const [samplePackage, setSamplePackage] = useState<string>('SAMPLE-1');

  const [preview, setPreview] = useState<LanePreviewResponse | null>(initialPreview);
  const [loading, setLoading] = useState<boolean>(false);
  const [unsupported, setUnsupported] = useState<boolean>(initialUnsupported);
  const [error, setError] = useState<string | null>(initialError);

  // Load roster if not provided
  useEffect(() => {
    if (roster && roster.length > 0) {
      setLocalRoster(roster);
    } else {
      let active = true;
      api
        .snapshot()
        .then((snap) => {
          if (active && snap?.roster) {
            setLocalRoster(snap.roster);
          }
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }
  }, [roster]);

  // When user selects a card from the roster
  const handleSelectCard = (cardId: string) => {
    setSelectedCardId(cardId);
    if (!cardId) return;
    const card = localRoster.find((c) => c.id === cardId);
    if (!card) return;
    const values = cardPreviewValues(card);
    setModel(values.model);
    setVariant(values.variant);
    setAgent(values.agent);
  };

  // Debounced call to /api/settings/lanes/preview
  const laneDraftKey = previewLaneDraftKey(lane);
  useEffect(() => {
    if (initialUnsupported) return;

    let active = true;
    setLoading(true);

    const timer = setTimeout(async () => {
      const lanePayload = buildPreviewLane(lane);

      const request: LanePreviewRequest = {
        lane: lanePayload,
        card: { model, variant, agent },
        sample: { name: sampleName, brief: sampleBrief, package: samplePackage },
      };

      try {
        const res = await api.lanePreview(request);
        if (!active) return;
        setPreview(res);
        setError(null);
        setUnsupported(false);
      } catch (err: unknown) {
        if (!active) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (isUnsupportedPreviewError(err)) {
          setUnsupported(true);
          setPreview(null);
        } else {
          setError(msg);
          setPreview(null);
        }
      } finally {
        if (active) setLoading(false);
      }
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    laneDraftKey,
    model,
    variant,
    agent,
    sampleName,
    sampleBrief,
    samplePackage,
    initialUnsupported,
  ]);

  return (
    <div className="argv-preview-panel">
      <div className="argv-preview-header">
        <h4 className="argv-preview-title">命令预览 (Argv Preview)</h4>
        <span className="argv-preview-tag">只读实时预览 · 不会保存配置</span>
      </div>

      <div className="argv-preview-desc">
        选择冒险者卡片或自行填写变体/智能体参数，实时观察接入命令在不同卡片条件下的完整展开效果（精确逐行显示参数，不按空格拼接）。
      </div>

      <div className="argv-preview-controls form-grid-3">
        <div className="form-field">
          <label htmlFor={`cfg-preview-roster-${lane.id}`}>从公会花名册选择卡片</label>
          <select
            id={`cfg-preview-roster-${lane.id}`}
            value={selectedCardId}
            onChange={(e) => handleSelectCard(e.target.value)}
          >
            <option value="">-- 手动填写参数 --</option>
            {localRoster.map((card) => (
              <option key={card.id} value={card.id}>
                {card.name || card.id} ({card.model || '无模型'}
                {card.variant ? ` · ${card.variant}` : ''}
                {card.agent ? ` · ${card.agent}` : ''})
              </option>
            ))}
          </select>
        </div>

        <div className="form-field">
          <label htmlFor={`cfg-preview-model-${lane.id}`}>模型 (model)</label>
          <input
            id={`cfg-preview-model-${lane.id}`}
            value={model}
            placeholder="例如 claude-3-7-sonnet"
            onChange={(e) => {
              setSelectedCardId('');
              setModel(e.target.value);
            }}
          />
        </div>

        <div className="form-field">
          <label htmlFor={`cfg-preview-variant-${lane.id}`}>变体 (variant)</label>
          <input
            id={`cfg-preview-variant-${lane.id}`}
            value={variant}
            placeholder="例如 high、none、空"
            onChange={(e) => {
              setSelectedCardId('');
              setVariant(e.target.value);
            }}
          />
        </div>
      </div>

      <div className="argv-preview-controls-sub form-grid-3">
        <div className="form-field">
          <label htmlFor={`cfg-preview-agent-${lane.id}`}>智能体 (agent)</label>
          <input
            id={`cfg-preview-agent-${lane.id}`}
            value={agent}
            placeholder="例如 coder、oracle"
            onChange={(e) => {
              setSelectedCardId('');
              setAgent(e.target.value);
            }}
          />
        </div>

        <div className="form-field">
          <label htmlFor={`cfg-preview-pkg-${lane.id}`}>任务包名 (package)</label>
          <input
            id={`cfg-preview-pkg-${lane.id}`}
            value={samplePackage}
            placeholder="SAMPLE-1"
            onChange={(e) => setSamplePackage(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label htmlFor={`cfg-preview-brief-${lane.id}`}>简报路径 (brief)</label>
          <input
            id={`cfg-preview-brief-${lane.id}`}
            value={sampleBrief}
            placeholder="docs/briefs/SAMPLE-1.md"
            onChange={(e) => setSampleBrief(e.target.value)}
          />
        </div>
      </div>

      {unsupported ? (
        <div className="warn-tape argv-unsupported-banner">
          这个版本的看板还不支持命令预览
        </div>
      ) : error ? (
        <div className="warn-tape argv-error-banner">
          预览失败：{error}
        </div>
      ) : (
        <>
          {preview?.warnings && preview.warnings.length > 0 ? (
            <div className="argv-warnings-box">
              {preview.warnings.map((w, wIdx) => (
                <div key={wIdx} className="warn-tape argv-warning-item">
                  {w}
                </div>
              ))}
            </div>
          ) : null}

          {preview?.omitted && preview.omitted.length > 0 ? (
            <div className="argv-omitted-box">
              <span className="omitted-label">已根据条件整组省略的参数：</span>
              {preview.omitted.map((o, oIdx) => (
                <span key={oIdx} className="omitted-badge">
                  {o.when} ({o.reason === 'absent' ? '未填写' : o.reason})
                </span>
              ))}
            </div>
          ) : null}

          <div className="argv-comparison-grid">
            <div className="argv-column">
              <div className="argv-column-title">
                <span>基础模板 (Run Arguments)</span>
                <span className="count-badge">{lane.run.length} 项</span>
              </div>
              <div className="argv-list-box">
                {lane.run.length === 0 ? (
                  <div className="argv-empty-note">未配置基础参数</div>
                ) : (
                  lane.run.map((arg, idx) => (
                    <div key={idx} className="argv-line-item">
                      <span className="argv-line-no">{idx + 1}</span>
                      <code className="argv-line-text">{arg}</code>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="argv-column">
              <div className="argv-column-title">
                <span>最终执行命令 (展开后 Argv)</span>
                {loading ? (
                  <span className="loading-badge">计算中…</span>
                ) : preview ? (
                  <span className="count-badge">{preview.argv.length} 项</span>
                ) : null}
              </div>
              <div className="argv-list-box final-argv-box">
                {preview ? (
                  preview.argv.map((arg, idx) => (
                    <div key={idx} className="argv-line-item">
                      <span className="argv-line-no">{idx + 1}</span>
                      <code className="argv-line-text">{arg}</code>
                    </div>
                  ))
                ) : (
                  <div className="argv-empty-note">
                    {loading ? '正在计算命令参数…' : '等待输入计算…'}
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
