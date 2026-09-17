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
import { t, useT, type I18nKey } from '../../lib/i18n';
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

// The bulk panel shows three coarse states, not the full card status table.
const STATUS_LABEL_KEYS: Record<RosterBulkStatus, I18nKey> = {
  available: 'rosterBulk.statusAvailable',
  limited: 'rosterBulk.statusLimited',
  paused: 'rosterBulk.statusPaused',
};

function parseEnv(text: string): { set: Record<string, string>; error: string | null } {
  const set: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split <= 0) return { set, error: t('rosterBulk.envFormat') };
    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) return { set, error: t('rosterBulk.envBadName', { name }) };
    set[name] = value;
  }
  if (Object.keys(set).length > 10) return { set, error: t('rosterBulk.envTooMany') };
  return { set, error: null };
}

function parseRemove(text: string): string[] {
  return text.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
}

function fieldText(fields: string[]): string {
  return fields.length ? fields.join(t('common.listSeparator')) : t('rosterBulk.fieldNone');
}

function idsText(ids: string[]): string {
  return ids.join(t('common.listSeparator'));
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
    if (reasons.length) return reasons.join(t('common.statementSeparator'));
    if (isStale || error.message.toLowerCase() === 'stale') return t('rosterBulk.expired');
  }
  if (error instanceof Error && error.message.toLowerCase() === 'stale') return t('rosterBulk.expired');
  return error instanceof Error ? error.message : String(error);
}

function isStaleError(error: unknown): boolean {
  return error instanceof ApiError && error.reasons.some((reason) => reason.code === 'stale_revision');
}

function resultReasons(item: RosterBulkResult): string {
  return item.reasons?.map((reason) => reason.message).filter(Boolean).join(t('common.statementSeparator')) || '';
}

export function formatBulkResultItem(item: RosterBulkResult): string {
  const reason = resultReasons(item);
  if (item.partial) {
    const applied = fieldText(item.appliedFields ?? []);
    const separator = t('common.statementSeparator');
    const suffix = reason ? `${separator}${reason}` : item.error ? `${separator}${item.error}` : '';
    return t('rosterBulk.partial', { fields: applied, reason: suffix });
  }
  if (item.ok) return t('rosterBulk.done', { fields: fieldText(item.changedFields) });
  if (item.denied) return reason || t('rosterBulk.refused');
  return item.error || t('rosterBulk.failed');
}

export function formatBulkApplyToast(response: Pick<RosterBulkResponse, 'counts'>): string {
  const { changed, unchanged, denied, failed, partial } = response.counts;
  return t('rosterBulk.toast', { changed, unchanged, denied, failed, partial });
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
  const t = useT();
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
    if (selectedIds.length === 0) throw new Error(t('rosterBulk.pickAdventurer'));
    const patch: RosterBulkPatch = action === 'delete' ? { action: 'delete' } : {};
    if (action === 'update') {
      if (status) patch.status = status;
      if (reason.trim() && !status) throw new Error(t('rosterBulk.reasonNeedsStatus'));
      if (reason.trim()) patch.reason = reason.trim();
      if (variantEnabled) patch.variant = variant.trim();
      const parsed = parseEnv(envText);
      if (parsed.error) throw new Error(parsed.error);
      const remove = parseRemove(removeText);
      if (Object.keys(parsed.set).length || remove.length) patch.env = { set: parsed.set, remove };
      if (!status && !variantEnabled && !Object.keys(parsed.set).length && !remove.length) throw new Error(t('rosterBulk.pickFields'));
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
        pushToast(t('rosterBulk.notFinished', { error: formatBulkError(caught) }));
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
    <section className="roster-bulk-actions" aria-label={t('rosterBulk.sectionLabel')}>
      <div className="roster-bulk-heading">
        <div>
          <strong>{t('rosterBulk.heading')}</strong>
          <span className="roster-bulk-count" aria-live="polite">{t('rosterBulk.selected', { count: selectedIds.length })}</span>
        </div>
        <div className="roster-bulk-select-buttons">
          <button className="btn" type="button" onClick={onSelectPage} disabled={!visibleCards.length}>
            {t('rosterBulk.selectVisible', { count: visibleCards.length })}
          </button>
          <button className="btn" type="button" onClick={onSelectAllMatching} disabled={!matchingCards.length}>
            {t('rosterBulk.selectAllMatching', { count: matchingCards.length })}
          </button>
          <button className="btn ghost" type="button" onClick={onClear} disabled={!selectedIds.length}>{t('rosterBulk.clear')}</button>
        </div>
      </div>

      {visibleCards.length < matchingCards.length ? (
        <p className="roster-bulk-fold-note" role="note">
          {t('rosterBulk.foldedNote', { count: matchingCards.length - visibleCards.length })}
        </p>
      ) : null}
      {hiddenFilterCount > 0 ? (
        <p className="roster-bulk-warning" role="status">{t('rosterBulk.hiddenWarning', { count: hiddenFilterCount })}</p>
      ) : null}
      {foldedSelectedCount > 0 ? (
        <p className="roster-bulk-warning" role="status">{t('rosterBulk.foldedWarning', { count: foldedSelectedCount })}</p>
      ) : null}

      <div className="roster-bulk-picker" aria-label={t('rosterBulk.pickerLabel')}>
        {matchingCards.map((card) => {
          const folded = !visibleSet.has(card.id);
          return (
            <label className={`roster-bulk-card-check${folded ? ' folded' : ''}`} key={card.id}>
              <input
                type="checkbox"
                checked={selectedSet.has(card.id)}
                onChange={() => onToggle(card.id)}
                aria-label={t('rosterBulk.selectCard', { name: card.name })}
              />
              <span>{card.name}</span>
              {folded ? <small>{t('rosterBulk.foldedTag')}</small> : null}
              <code>{card.id}</code>
            </label>
          );
        })}
        {selectedIds.filter((id) => !matchingSet.has(id)).map((id) => (
          <label className="roster-bulk-card-check hidden" key={id}>
            <input type="checkbox" checked onChange={() => onToggle(id)} aria-label={t('rosterBulk.deselectCard', { id })} />
            <span>{t('rosterBulk.hiddenTag')}</span>
            <code>{id}</code>
          </label>
        ))}
        {!matchingCards.length && !selectedIds.length ? <p className="hint roster-bulk-empty">{t('rosterBulk.empty')}</p> : null}
      </div>

      <div className="roster-bulk-fields">
        <label>
          <span>{t('rosterBulk.statusLabel')}</span>
          <select aria-label={t('rosterBulk.statusFieldLabel')} value={status} onChange={(event) => setStatus(event.target.value as RosterBulkStatus | '')}>
            <option value="">{t('rosterBulk.statusNoChange')}</option>
            {(Object.keys(STATUS_LABEL_KEYS) as RosterBulkStatus[]).map((value) => <option value={value} key={value}>{t(STATUS_LABEL_KEYS[value])}</option>)}
          </select>
        </label>
        <label>
          <span>{t('rosterBulk.reasonLabel')}</span>
          <input aria-label={t('rosterBulk.reasonFieldLabel')} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('rosterBulk.reasonPlaceholder')} />
        </label>
        <label className="roster-bulk-variant-field">
          <span><input type="checkbox" checked={variantEnabled} onChange={(event) => setVariantEnabled(event.target.checked)} /> {t('rosterBulk.variantLabel')}</span>
          <input aria-label={t('rosterBulk.variantFieldLabel')} value={variant} onChange={(event) => setVariant(event.target.value)} disabled={!variantEnabled} placeholder={t('rosterBulk.variantPlaceholder')} />
        </label>
        <label>
          <span>{t('rosterBulk.envLabel')}</span>
          <textarea aria-label={t('rosterBulk.envFieldLabel')} value={envText} onChange={(event) => setEnvText(event.target.value)} rows={2} placeholder="BASE_URL=https://example.test" />
        </label>
        <label>
          <span>{t('rosterBulk.removeEnvLabel')}</span>
          <input aria-label={t('rosterBulk.removeEnvFieldLabel')} value={removeText} onChange={(event) => setRemoveText(event.target.value)} placeholder="OLD_URL, LEGACY_ID" />
        </label>
      </div>

      {mainError}

      <div className="roster-bulk-footer">
        <span className="hint">{t('rosterBulk.footerNote')}</span>
        <div className="roster-bulk-buttons">
          <button className="btn primary" type="button" onClick={() => void loadPreview('update')} disabled={busy || !selectedIds.length}>{t('rosterBulk.previewUpdate')}</button>
          <button className="btn danger" type="button" onClick={() => setDeleteConfirm(true)} disabled={busy || !selectedIds.length}>{t('rosterBulk.deleteSelected')}</button>
        </div>
      </div>

      {deleteConfirm ? (
        <div className="modal-back" onClick={() => setDeleteConfirm(false)}>
          <div className="order roster-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulkDeleteTitle" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">{t('rosterBulk.eyebrowDelete')}</p>
            <h2 id="bulkDeleteTitle">{t('rosterBulk.confirmTitle', { count: selectedIds.length })}</h2>
            <p>{t('rosterBulk.confirmBody')}</p>
            <div className="roster-bulk-id-list"><code>{idsText(selectedIds)}</code></div>
            <div className="row end">
              <button className="btn ghost" type="button" onClick={() => setDeleteConfirm(false)}>{t('rosterBulk.neverMind')}</button>
              <button className="btn danger confirm-delete-btn" type="button" disabled={busy} onClick={() => void loadPreview('delete')}>{t('rosterBulk.continuePreview')}</button>
            </div>
          </div>
        </div>
      ) : null}

      {preview && operationIsCurrent ? (
        <div className="modal-back" onClick={closeDialogs}>
          <div className="order roster-bulk-dialog roster-bulk-preview" role="dialog" aria-modal="true" aria-labelledby="bulkPreviewTitle" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">{t('rosterBulk.eyebrowPreview')}</p>
            <h2 id="bulkPreviewTitle">{preview.action === 'delete' ? t('rosterBulk.previewDelete') : t('rosterBulk.previewUpdate')}</h2>
            <p className="hint">{preview.statusNote}</p>
            {error ? <div className="warn-tape roster-bulk-error" role="alert">{error}</div> : null}
            <dl className="roster-bulk-summary">
              <div><dt>{t('rosterBulk.summaryIds')}</dt><dd><code>{idsText(preview.ids)}</code></dd></div>
              <div><dt>{t('rosterBulk.summaryChanged')}</dt><dd>{fieldText(preview.changedFields)}</dd></div>
              <div><dt>{t('rosterBulk.summaryPreserved')}</dt><dd>{fieldText(preview.preservedFields)}</dd></div>
              <div><dt>{t('rosterBulk.summaryResult')}</dt><dd>{t('rosterBulk.summaryCounts', { ready: preview.counts.ready, denied: preview.counts.denied })}</dd></div>
            </dl>
            {preview.deniedActiveCards.length ? (
              <div className="roster-bulk-denied">
                <strong>{t('rosterBulk.deniedTitle')}</strong>
                {preview.deniedActiveCards.map((item) => <div key={item.id}><code>{item.id}</code>：{item.reasons?.map((r) => r.message).join('；')}</div>)}
              </div>
            ) : null}
            <ul className="roster-bulk-result-list">
                {preview.results.map((item) => <li key={item.id} className={item.ok ? 'ok' : 'bad'}><code>{item.id}</code><span>{item.ok ? t('rosterBulk.itemChange', { fields: fieldText(item.changedFields) }) : formatBulkResultItem(item)}</span></li>)}
            </ul>
            <div className="row end">
              <button className="btn ghost" type="button" onClick={closeDialogs}>{t('rosterBulk.dialogCancel')}</button>
              <button className="btn primary" type="button" disabled={busy || staleRefused || !preview.counts.ready} onClick={() => void applyPreview()}>
                {busy ? t('rosterBulk.running') : preview.action === 'delete' ? t('rosterBulk.confirmDelete') : t('rosterBulk.confirmApply')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="modal-back" onClick={closeDialogs}>
          <div className="order roster-bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulkResultTitle" onClick={(event) => event.stopPropagation()}>
            <p className="eyebrow">{t('rosterBulk.eyebrowResult')}</p>
            <h2 id="bulkResultTitle">{t('rosterBulk.resultTitle')}</h2>
            <p className="roster-bulk-result-count">
              {t('rosterBulk.toast', { changed: result.counts.changed, unchanged: result.counts.unchanged, denied: result.counts.denied, failed: result.counts.failed, partial: result.counts.partial })}
            </p>
            <ul className="roster-bulk-result-list">
                {result.results.map((item) => <li key={item.id} className={item.partial ? 'partial' : item.ok ? 'ok' : 'bad'}><code>{item.id}</code><span>{formatBulkResultItem(item)}</span></li>)}
            </ul>
            <div className="row end"><button className="btn primary" type="button" onClick={closeDialogs}>{t('rosterBulk.resultOk')}</button></div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
