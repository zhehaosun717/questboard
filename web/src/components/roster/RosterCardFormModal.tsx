import { useState } from 'react';
import { api } from '../../api/client';
import type { Card } from '../../api/types';
import { BILLING } from '../../lib/labels';
import { type CardFormValues, suggestDuplicateId, validateCardForm } from '../../lib/rosterForm';

interface RosterCardFormModalProps {
  card?: Card;
  // Open the form filled from `card` but as a new card: every field is kept, only the id has to change.
  duplicate?: boolean;
  lanes: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function RosterCardFormModal({
  card,
  duplicate,
  lanes,
  onClose,
  onSuccess,
}: RosterCardFormModalProps) {
  const isDuplicate = Boolean(duplicate && card);
  const isNew = !card || isDuplicate;

  const [id, setId] = useState(card && isDuplicate ? suggestDuplicateId(card.id) : card?.id ?? '');
  const [name, setName] = useState(card?.name ?? '');
  const [provider, setProvider] = useState(card?.provider ?? '');
  const [lane, setLane] = useState(card?.lane ?? (lanes[0] ?? ''));
  const [model, setModel] = useState(card?.model ?? '');
  const [family, setFamily] = useState(card?.family ?? '');
  const [variant, setVariant] = useState(card?.variant ?? '');
  const [agent, setAgent] = useState(card?.agent ?? '');
  const [billing, setBilling] = useState(card?.billing ?? '');
  const [maxParallel, setMaxParallel] = useState<string>(
    card?.maxParallel !== undefined ? String(card.maxParallel) : '1',
  );
  const [strengths, setStrengths] = useState(card?.strengths?.join(', ') ?? '');
  const [notes, setNotes] = useState(card?.notes ?? '');
  const [env, setEnv] = useState(
    Object.entries(card?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const values: CardFormValues = {
      id,
      name,
      provider,
      lane,
      model,
      family,
      variant,
      agent,
      billing,
      maxParallel,
      strengths,
      notes,
      env,
    };

    // Saving upserts by id, so reusing the source id would overwrite the card being copied.
    if (isDuplicate && card && id.trim() === card.id) {
      setErrors({ id: '复制出来的 ID 要和原工牌不同，否则会覆盖原来那张' });
      return;
    }

    const validated = validateCardForm(values, lanes);
    if (!validated.value) {
      setErrors(validated.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      await api.saveCard(validated.value);
      onSuccess();
    } catch (err) {
      setSubmitting(false);
      setServerError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="order roster-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cardFormTitle"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow">
          {!card
            ? 'NEW ADVENTURER · 录入档案'
            : isDuplicate
              ? 'DUPLICATE ADVENTURER · 照着再开一张'
              : 'EDIT ADVENTURER · 修改档案'}
        </p>
        <h2 id="cardFormTitle">
          {!card ? '新冒险者' : isDuplicate ? `复制「${card.name}」` : `编辑「${card.name}」`}
        </h2>

        {serverError ? (
          <div className="warn-tape roster-server-error">{serverError}</div>
        ) : null}

        <form onSubmit={handleSubmit} className="roster-form-body">
          <div className="form-field">
            <label htmlFor="card-id">
              ID（小写字母、数字、连字符{isNew ? '' : '，不可修改'}）
              {errors.id ? <span className="field-error"> · {errors.id}</span> : null}
            </label>
            <input
              id="card-id"
              value={id}
              disabled={!isNew}
              maxLength={48}
              placeholder="例如 deepseek-v3"
              onChange={(e) => setId(e.target.value)}
            />
            {isDuplicate && card ? (
              <p className="hint">
                照「{card.name}」复制，其余字段都填好了；改完 ID 和名称就能入册。
              </p>
            ) : null}
          </div>

          <div className="form-grid-2">
            <div className="form-field">
              <label htmlFor="card-name">
                名称
                {errors.name ? <span className="field-error"> · {errors.name}</span> : null}
              </label>
              <input
                id="card-name"
                value={name}
                placeholder="例如 深度求索"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="card-provider">
                服务商
                {errors.provider ? <span className="field-error"> · {errors.provider}</span> : null}
              </label>
              <input
                id="card-provider"
                value={provider}
                placeholder="例如 deepseek"
                onChange={(e) => setProvider(e.target.value)}
              />
            </div>
          </div>

          <div className="form-grid-2">
            <div className="form-field">
              <label htmlFor="card-lane">
                通道
                {errors.lane ? <span className="field-error"> · {errors.lane}</span> : null}
              </label>
              <select
                id="card-lane"
                value={lane}
                onChange={(e) => setLane(e.target.value)}
              >
                {lanes.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="card-family">
                系列
                {errors.family ? <span className="field-error"> · {errors.family}</span> : null}
              </label>
              <input
                id="card-family"
                value={family}
                placeholder="例如 deepseek"
                onChange={(e) => setFamily(e.target.value)}
              />
            </div>
          </div>

          <div className="form-grid-2">
            <div className="form-field">
              <label htmlFor="card-model">
                模型
                {errors.model ? <span className="field-error"> · {errors.model}</span> : null}
              </label>
              <input
                id="card-model"
                value={model}
                placeholder="例如 deepseek-chat"
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="card-variant">变体（可选）</label>
              <input
                id="card-variant"
                value={variant}
                placeholder="例如 reasoning"
                onChange={(e) => setVariant(e.target.value)}
              />
            </div>
          </div>

          <div className="form-grid-3">
            <div className="form-field">
              <label htmlFor="card-agent">代理（可选）</label>
              <input
                id="card-agent"
                value={agent}
                placeholder="例如 sisyphus"
                onChange={(e) => setAgent(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="card-billing">
                计费模式
                {errors.billing ? <span className="field-error"> · {errors.billing}</span> : null}
              </label>
              <select
                id="card-billing"
                value={billing}
                onChange={(e) => setBilling(e.target.value)}
              >
                <option value="">未指定</option>
                {Object.entries(BILLING).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="card-maxParallel">
                最大并发
                {errors.maxParallel ? (
                  <span className="field-error"> · {errors.maxParallel}</span>
                ) : null}
              </label>
              <input
                id="card-maxParallel"
                type="number"
                min={1}
                step={1}
                value={maxParallel}
                onChange={(e) => setMaxParallel(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="card-strengths">专长（英文逗号分隔）</label>
            <input
              id="card-strengths"
              value={strengths}
              placeholder="例如 code, refactor, review"
              onChange={(e) => setStrengths(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="card-notes">
              备注（最多300字）
              {errors.notes ? <span className="field-error"> · {errors.notes}</span> : null}
            </label>
            <textarea
              id="card-notes"
              maxLength={300}
              rows={3}
              value={notes}
              placeholder="使用说明或特性记录..."
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="card-env">
              环境变量（可选，每行 NAME=值；不要放密钥）
              {errors.env ? <span className="field-error"> · {errors.env}</span> : null}
            </label>
            <textarea
              id="card-env"
              rows={3}
              value={env}
              placeholder={'OPENAI_BASE_URL=https://api.example.com/v1\n# 密钥请放系统环境变量，通道命令会继承'}
              onChange={(e) => setEnv(e.target.value)}
            />
          </div>

          <div className="row end form-actions">
            <button className="btn ghost" type="button" onClick={onClose}>
              算了
            </button>
            <button
              className="btn primary"
              type="submit"
              disabled={submitting}
            >
              {submitting ? '正在登记…' : isNew ? '入册' : '盖章保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
