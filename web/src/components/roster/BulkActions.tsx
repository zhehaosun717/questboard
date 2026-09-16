import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import type {
  Card,
  RosterBulkPatch,
  RosterBulkRequest,
  RosterBulkResponse,
  RosterBulkResult,
  RosterBulkStatus,
} from '../../api/types';
import '../../styles/roster-bulk.css';

interface BulkActionsProps {
  /** All cards matching the current filter, including cards in folded provider groups. */
  matchingCards: Card[];
  /** Cards whose rows are actually open on screen. */
  visibleCards?: Card[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onSelectPage: () => void;
  onSelectAllMatching: () => void;
  onClear: () => void;
  refresh: () => void;
  pushToast: (message: string) => void;
  /** Changes when the project or the roster snapshot changes. */
  sourceToken?: string;
}

const STATUS_LABELS: Record<RosterBulkStatus, string> = {
  available: '可用',
  limited: '限额',
  paused: '暂停',
};

function parseEnv(text: string): { set: Record<string, string>; error: string | null } {
  const set: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split <= 0) return { set, error: '环境变量每行写成 NAME=值' };
    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return { set, error: `变量名 ${name} 不是大写下划线格式` };
    set[name] = value;
  }
  if (Object.keys(set).length > 10) return { set, error: '一次最多设置 10 个环境变量' };
  return { set, error: null };
}

function parseRemove(text: string): string[] {
  return text.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
}

function fieldText(fields: string[]): string {
  return fields.length ? fields.join('、') : '无';
}

function idsText(ids: string[]): string {
  return ids.join('、');
}

export function bulkSelectionToken(sourceToken: string, selectedIds: readonly string[]): string {
  return `${sourceToken}\u0000${JSON.stringify(selectedIds)}`;
}

export function formatBulkError(error: unknown): string {
  if (error instanceof ApiError) {
    const isStale = error.reasons.some((reason) => reason.code === 'stale_revision');
    const reasons = error.reasons
      .map((reason) => reason.message)
      .filter((message) => Boolean(message) && message.toLowerCase() !== 'stale');
    if (reasons.length) return reasons.join('；');
    if (isStale || error.message.toLowerCase() === 'stale') return '这次操作已过期，请重新预览后再试。';
  }
  if (error instanceof Error && error.message.toLowerCase() === 'stale') return '这次操作已过期，请重新预览后再试。';
  return error instanceof Error ? error.message : String(error);
}

function isStaleError(error: unknown): boolean {
  return error instanceof ApiError && error.reasons.some((reason) => reason.code === 'stale_revision');
}

function resultReasons(item: RosterBulkResult): string {
  return item.reasons?.map((reason) => reason.message).filter(Boolean).join('；') || '';
}

export function formatBulkResultItem(item: RosterBulkResult): string {
  const reason = resultReasons(item);
  if (item.partial) {
    const applied = fieldText(item.appliedFields ?? []);
    return `部分写入：已应用 ${applied}${reason ? `；${reason}` : item.error ? `；${item.error}` : ''}`;
  }
  if (item.ok) return `已完成：${fieldText(item.changedFields)}`;
  if (item.denied) return reason || '服务器拒绝了这张卡片';
  return item.error || '操作失败，未报告为成功';
}

export function formatBulkApplyToast(response: Pick<RosterBulkResponse, 'counts'>): string {
  const { changed, unchanged, denied, failed, partial } = response.counts;
  return `批量操作完成：已改变 ${changed}，未变化 ${unchanged}，拒绝 ${denied}，失败 ${failed}，部分完成 ${partial}`;
}

export interface BulkOperationToken {
  sourceToken: string;
  selectionKey: string;
}

export interface BulkOperationState {
  busy: boolean;
  preview: RosterBulkResponse | null;
  pendingRequest: RosterBulkRequest | null;
  result: RosterBulkResponse | null;
  operationToken: BulkOperationToken | null;
  deleteConfirm: boolean;
  error: string | null;
  staleRefused: boolean;
}

/**
 * A source or selection change invalidates only the in-flight operation. A completed result is a receipt
 * for a server write and must survive the snapshot refresh that follows it.
 */
export function invalidateBulkOperationForIdentityChange(state: BulkOperationState): BulkOperationState {
  return {
    ...state,
    busy: false,
    preview: null,
    pendingRequest: null,
    operationToken: null,
    deleteConfirm: false,
    error: null,
    staleRefused: false,
  };
}

/** The async continuation may commit UI only while its mount, source, selection and sequence are current. */
export function isBulkOperationCurrent(
  token: BulkOperationToken,
  current: { mounted: boolean; sourceToken: string; selectionKey: string; sequence: number },
  expectedSequence: number,
): boolean {
  return current.mounted
    && current.sourceToken === token.sourceToken
    && current.selectionKey === token.selectionKey
    && current.sequence === expectedSequence;
}

export function BulkActions({
  matchingCards,
  visibleCards = matchingCards,
  selectedIds,
  onToggle,
  onSelectPage,
  onSelectAllMatching,
  onClear,
  refresh,
  pushToast,
  sourceToken = '',
}: BulkActionsProps) {
  const [status, setStatus] = useState<RosterBulkStatus | ''>('');
  const [reason, setReason] = useState('');
  const [variantEnabled, setVariantEnabled] = useState(false);
  const [variant, setVariant] = useState('');
  const [envText, setEnvText] = useState('');
  const [removeText, setRemoveText] = useState('');
  const [preview, setPreview] = useState<RosterBulkResponse | null>(null);
  const [pendingRequest, setPendingRequest] = useState<RosterBulkRequest | null>(null);
  const [result, setResult] = useState<RosterBulkResponse | null>(null);
  const [operationToken, setOperationToken] = useState<BulkOperationToken | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleRefused, setStaleRefused] = useState(false);

  const selectedSet = new Set(selectedIds);
  const matchingSet = new Set(matchingCards.map((card) => card.id));
  const visibleSet = new Set(visibleCards.map((card) => card.id));
  const hiddenFilterCount = selectedIds.filter((id) => !matchingSet.has(id)).length;
  const foldedSelectedCount = selectedIds.filter((id) => matchingSet.has(id) && !visibleSet.has(id)).length;
  const selectionKey = bulkSelectionToken(sourceToken, selectedIds);
  const sourceRef = useRef(sourceToken);
  const selectionRef = useRef(selectionKey);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const previousSelectionKeyRef = useRef(selectionKey);
  sourceRef.current = sourceToken;
  selectionRef.current = selectionKey;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);

  // Selection and source are part of the request identity. If either changes while a request or dialog
  // is alive, clear it synchronously from the next render and invalidate the promise continuation.
  useEffect(() => {
    if (previousSelectionKeyRef.current === selectionKey) return;
    previousSelectionKeyRef.current = selectionKey;
    requestSequenceRef.current += 1;
    const next = invalidateBulkOperationForIdentityChange({
      busy,
      preview,
      pendingRequest,
      result,
      operationToken,
      deleteConfirm,
      error,
      staleRefused,
    });
    setBusy(next.busy);
    setPreview(next.preview);
    setPendingRequest(next.pendingRequest);
    setOperationToken(next.operationToken);
    setDeleteConfirm(next.deleteConfirm);
    setError(next.error);
    setStaleRefused(next.staleRefused);
    setResult(next.result);
  }, [selectionKey]);

  const operationIsCurrent = !operationToken || (
    operationToken.sourceToken === sourceToken && operationToken.selectionKey === selectionKey
  );

  const isCurrent = (token: BulkOperationToken, sequence: number): boolean => isBulkOperationCurrent(token, {
    mounted: mountedRef.current,
    sourceToken: sourceRef.current,
    selectionKey: selectionRef.current,
    sequence: requestSequenceRef.current,
  }, sequence);

  const makeRequest = (action: 'update' | 'delete'): RosterBulkRequest => {
    if (selectedIds.length === 0) throw new Error('先选择至少一位冒险者');
    const patch: RosterBulkPatch = action === 'delete' ? { action: 'delete' } : {};
    if (action === 'update') {
      if (status) patch.status = status;
      if (reason.trim() && !status) throw new Error('状态原因需要先选择状态');
      if (reason.trim()) patch.reason = reason.trim();
      if (variantEnabled) patch.variant = variant.trim();
      const parsed = parseEnv(envText);
      if (parsed.error) throw new Error(parsed.error);
      const remove = parseRemove(removeText);
      if (Object.keys(parsed.set).length || remove.length) patch.env = { set: parsed.set, remove };
      if (!status && !variantEnabled && !Object.keys(parsed.set).length && !remove.length) throw new Error('先选择要批量修改的字段');
    }
    return { ids: [...selectedIds], patch };
  };

  const loadPreview = async (action: 'update' | 'delete') => {
    const token: BulkOperationToken = { sourceToken, selectionKey };
    const sequence = ++requestSequenceRef.current;
    setError(null);
    setStaleRefused(false);
    setPreview(null);
    setPendingRequest(null);
    setResult(null);
    setOperationToken(null);
    setDeleteConfirm(false);
    setBusy(true);
    try {
      const request = makeRequest(action);
      const response = await api.rosterBulkPreview(request);
      if (!isCurrent(token, sequence)) return;
      setPendingRequest(request);
      setPreview(response);
      setOperationToken(token);
    } catch (caught) {
      if (isCurrent(token, sequence)) setError(formatBulkError(caught));
    } finally {
      if (isCurrent(token, sequence)) setBusy(false);
    }
  };

  const applyPreview = async () => {
    if (!preview || !pendingRequest || !operationToken || !operationIsCurrent) return;
    const token = operationToken;
    const sequence = ++requestSequenceRef.current;
    setError(null);
    setBusy(true);
    try {
      const response = await api.rosterBulkApply({
        ...pendingRequest,
        fingerprint: preview.fingerprint,
        revision: preview.revision,
      });
      const current = isCurrent(token, sequence);
      if (!mountedRef.current) return;
      if (current) {
        setPreview(null);
        setPendingRequest(null);
        setResult(response);
        setOperationToken(null);
      }
      pushToast(formatBulkApplyToast(response));
      refresh();
    } catch (caught) {
      if (isCurrent(token, sequence)) {
        setError(formatBulkError(caught));
        if (isStaleError(caught)) setStaleRefused(true);
      } else if (mountedRef.current) {
        pushToast(`批量操作未完成：${formatBulkError(caught)}`);
      }
    } finally {
      if (isCurrent(token, sequence)) setBusy(false);
    }
  };

  const closeDialogs = () => {
    if (busy) return;
    setPreview(null);
    setPendingRequest(null);
    setResult(null);
    setOperationToken(null);
    setDeleteConfirm(false);
    setError(null);
    setStaleRefused(false);
  };

  const mainError = error && !preview && !result ? <div className="warn-tape roster-bulk-error" role="alert">{error}</div> : null;

  return (
    <section className="roster-bulk-actions" aria-label="批量管理冒险者">
      <div className="roster-bulk-heading">
        <div>
          <strong>批量管理</strong>
          <span className="roster-bulk-count" aria-live="polite">已选 {selectedIds.length} 张</span>
        </div>
        <div className="roster-bulk-select-buttons">
          <button className="btn" type="button" onClick={onSelectPage} disabled={!visibleCards.length}>
            选择可见的（{visibleCards.length}）
          </button>
          <button className="btn" type="button" onClick={onSelectAllMatching} disabled={!matchingCards.length}>
            选择全部匹配（{matchingCards.length}）
          </button>
          <button className="btn ghost" type="button" onClick={onClear} disabled={!selectedIds.length}>清空选择</button>
        </div>
      </div>

      {visibleCards.length < matchingCards.length ? (
        <p className="roster-bulk-fold-note" role="note">
          当前有 {matchingCards.length - visibleCards.length} 张匹配卡片在折叠组内；“选择可见的”只包含屏幕上打开的行。
        </p>
      ) : null}
      {hiddenFilterCount > 0 ? (
        <p className="roster-bulk-warning" role="status">有 {hiddenFilterCount} 张已选卡片被当前筛选隐藏；批量操作仍会包含它们。</p>
      ) : null}
      {foldedSelectedCount > 0 ? (
        <p className="roster-bulk-warning" role="status">有 {foldedSelectedCount} 张已选卡片在折叠组内；批量操作仍会包含它们。</p>
      ) : null}

      <div className="roster-bulk-picker" aria-label="选择冒险者">
        {matchingCards.map((card) => {
          const folded = !visibleSet.has(card.id);
          return (
            <label className={`roster-bulk-card-check${folded ? ' folded' : ''}`} key={card.id}>
              <input
                type="checkbox"
                checked={selectedSet.has(card.id)}
                onChange={() => onToggle(card.id)}
                aria-label={`选择 ${card.name}`}
              />
              <span>{card.name}</span>
              {folded ? <small>折叠</small> : null}
              <code>{card.id}</code>
            </label>
          );
        })}
        {selectedIds.filter((id) => !matchingSet.has(id)).map((id) => (
          <label className="roster-bulk-card-check hidden" key={id}>
            <input type="checkbox" checked onChange={() => onToggle(id)} aria-label={`取消选择 ${id}`} />
            <span>已筛选隐藏</span>
            <code>{id}</code>
          </label>
        ))}
        {!matchingCards.length && !selectedIds.length ? <p className="hint roster-bulk-empty">当前筛选没有匹配卡片。</p> : null}
      </div>

      <div className="roster-bulk-fields">
        <label>
          <span>状态</span>
          <select aria-label="批量状态" value={status} onChange={(event) => setStatus(event.target.value as RosterBulkStatus | '')}>
            <option value="">不修改状态</option>
            {(Object.keys(STATUS_LABELS) as RosterBulkStatus[]).map((value) => <option value={value} key={value}>{STATUS_LABELS[value]}</option>)}
          </select>
        </label>
        <label>
          <span>状态原因</span>
          <input aria-label="批量状态原因" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="选择状态后填写" />
        </label>
        <label className="roster-bulk-variant-field">
          <span><input type="checkbox" checked={variantEnabled} onChange={(event) => setVariantEnabled(event.target.checked)} /> 修改变体</span>
          <input aria-label="批量变体" value={variant} onChange={(event) => setVariant(event.target.value)} disabled={!variantEnabled} placeholder="空白=清除，不会强制 high" />
        </label>
        <label>
          <span>设置环境变量</span>
          <textarea aria-label="批量设置环境变量" value={envText} onChange={(event) => setEnvText(event.target.value)} rows={2} placeholder="BASE_URL=https://example.test" />
        </label>
        <label>
          <span>移除环境变量</span>
          <input aria-label="批量移除环境变量" value={removeText} onChange={(event) => setRemoveText(event.target.value)} placeholder="OLD_URL, LEGACY_ID" />
        </label>
      </div>

      {mainError}

      <div className="roster-bulk-footer">
        <span className="hint">状态记录与实时通道限额分开显示；暂停是手动决定。</span>
        <div className="roster-bulk-buttons">
          <button className="btn primary" type="button" onClick={() => void loadPreview('update')} disabled={busy || !selectedIds.length}>预览批量修改</button>
          <button className="btn danger" type="button" onClick={() => setDeleteConfirm(true)} disabled={busy || !selectedIds.length}>删除所选</button>
        </div>
      </div>

      {deleteConfirm ? (
        <div className="modal-back" onClick={() => setDeleteConfirm(false)}>
          <div className="order roster-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulkDeleteTitle" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">REMOVE CARDS · 批量删除</p>
            <h2 id="bulkDeleteTitle">确认删除 {selectedIds.length} 张卡片？</h2>
            <p>这一步只会删除你明确选中的 ID，不会按筛选器临时隐藏的卡片扩大范围。</p>
            <div className="roster-bulk-id-list"><code>{idsText(selectedIds)}</code></div>
            <div className="row end">
              <button className="btn ghost" type="button" onClick={() => setDeleteConfirm(false)}>算了</button>
              <button className="btn danger confirm-delete-btn" type="button" disabled={busy} onClick={() => void loadPreview('delete')}>继续预览删除</button>
            </div>
          </div>
        </div>
      ) : null}

      {preview && operationIsCurrent ? (
        <div className="modal-back" onClick={closeDialogs}>
          <div className="order roster-bulk-dialog roster-bulk-preview" role="dialog" aria-modal="true" aria-labelledby="bulkPreviewTitle" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">PREFLIGHT · 批量预览</p>
            <h2 id="bulkPreviewTitle">{preview.action === 'delete' ? '预览删除' : '预览批量修改'}</h2>
            <p className="hint">{preview.statusNote}</p>
            {error ? <div className="warn-tape roster-bulk-error" role="alert">{error}</div> : null}
            <dl className="roster-bulk-summary">
              <div><dt>选中 ID</dt><dd><code>{idsText(preview.ids)}</code></dd></div>
              <div><dt>会变化</dt><dd>{fieldText(preview.changedFields)}</dd></div>
              <div><dt>继续保留</dt><dd>{fieldText(preview.preservedFields)}</dd></div>
              <div><dt>结果</dt><dd>{preview.counts.ready} 可执行，{preview.counts.denied} 张被拒绝</dd></div>
            </dl>
            {preview.deniedActiveCards.length ? (
              <div className="roster-bulk-denied">
                <strong>正在执行或结果未定，不能改：</strong>
                {preview.deniedActiveCards.map((item) => <div key={item.id}><code>{item.id}</code>：{item.reasons?.map((r) => r.message).join('；')}</div>)}
              </div>
            ) : null}
            <ul className="roster-bulk-result-list">
                {preview.results.map((item) => <li key={item.id} className={item.ok ? 'ok' : 'bad'}><code>{item.id}</code><span>{item.ok ? `会改：${fieldText(item.changedFields)}` : formatBulkResultItem(item)}</span></li>)}
            </ul>
            <div className="row end">
              <button className="btn ghost" type="button" onClick={closeDialogs}>取消</button>
              <button className="btn primary" type="button" disabled={busy || staleRefused || !preview.counts.ready} onClick={() => void applyPreview()}>
                {busy ? '正在执行…' : preview.action === 'delete' ? '确认删除可执行项' : '确认批量修改'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="modal-back" onClick={closeDialogs}>
          <div className="order roster-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulkResultTitle" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">RESULT · 批量结果</p>
            <h2 id="bulkResultTitle">批量操作完成</h2>
            <p className="roster-bulk-result-count">
              成功 {result.counts.changed}，未变化 {result.counts.unchanged}，拒绝 {result.counts.denied}，失败 {result.counts.failed}，部分完成 {result.counts.partial}
            </p>
            <ul className="roster-bulk-result-list">
                {result.results.map((item) => <li key={item.id} className={item.partial ? 'partial' : item.ok ? 'ok' : 'bad'}><code>{item.id}</code><span>{formatBulkResultItem(item)}</span></li>)}
            </ul>
            <div className="row end"><button className="btn primary" type="button" onClick={closeDialogs}>知道了</button></div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
