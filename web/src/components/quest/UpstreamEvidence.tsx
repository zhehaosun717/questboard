import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Quest, UpstreamEvidenceKind, UpstreamEvidenceState, UpstreamParent, UpstreamReview } from '../../api/types';
import { formatClock } from '../../lib/board';
import { t, useT } from '../../lib/i18n';
import { DrawerSection } from './DrawerSection';
import '../../styles/report-evidence.css';

const KIND_LABEL: Record<UpstreamEvidenceKind, string> = {
  get report() { return t('upstreamEvidence.kind.report'); },
  get 'project-verification'() { return t('upstreamEvidence.kind.projectVerification'); },
  get hook() { return t('upstreamEvidence.kind.hook'); },
};

const STATE_LABEL: Record<UpstreamEvidenceState, string> = {
  get passed() { return t('upstreamEvidence.state.passed'); },
  get failed() { return t('upstreamEvidence.state.failed'); },
  get stale() { return t('upstreamEvidence.state.stale'); },
  get missing() { return t('upstreamEvidence.state.missing'); },
  get not_configured() { return t('upstreamEvidence.state.notConfigured'); },
  get unknown() { return t('upstreamEvidence.state.unknown'); },
};

// Exported for UpstreamEvidence.test.tsx: a pure row renderer, testable with real JSX/SSR without needing
// the on-demand fetch (which never resolves under this project's no-jsdom test setup) to settle first.
export function UpstreamParentRow({ parent }: { parent: UpstreamParent }) {
  const t = useT();
  return (
    <div className={`upstream-evidence-parent${parent.failing.length ? ' upstream-evidence-parent-failing' : ''}`}>
      <div className="upstream-evidence-parent-head">
        <strong>{parent.id}</strong>
        {parent.gap ? <span className="upstream-evidence-chip upstream-evidence-chip-gap">{t('upstreamEvidence.gap')}</span> : null}
      </div>
      <div className="upstream-evidence-kinds">
        {(Object.keys(KIND_LABEL) as UpstreamEvidenceKind[]).map((kind) => (
          <span
            key={kind}
            className={`upstream-evidence-chip upstream-evidence-${parent.states[kind]}${parent.failing.includes(kind) ? ' upstream-evidence-chip-failing' : ''}`}
          >
            {KIND_LABEL[kind]} {STATE_LABEL[parent.states[kind]]}
          </span>
        ))}
      </div>
    </div>
  );
}

interface UpstreamEvidenceProps {
  quest: Quest;
  projectId: string;
  // F3: a signature of the parents' current state (each parent's revision, read from the snapshot the
  // caller already holds), so the effect below refetches when a parent is re-dispatched or redelivered
  // while the drawer stays open — never a poll, since this only changes when the snapshot itself does.
  parentsKey?: string;
  refresh: () => void;
  pushToast: (message: string) => void;
}

type SectionState =
  | { status: 'loading' }
  | { status: 'ready'; review: UpstreamReview | null }
  | { status: 'error'; message: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// S3: the review-order warning/refusal (src/core/rules.js reviewUpstreamEvidence), shown on a review quest's
// own drawer regardless of which card (if any) is selected — the drop preview's warnings channel already
// covers the per-card moment, this is the standing record. Fetched on demand alongside EvidenceSection,
// never part of the snapshot fan-out; an older server that sends no `upstreamReview` field renders exactly
// as before this section existed.
export function UpstreamEvidence({ quest, projectId, parentsKey, refresh, pushToast }: UpstreamEvidenceProps) {
  const t = useT();
  const [state, setState] = useState<SectionState>({ status: 'loading' });
  const [overrideReason, setOverrideReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (quest.kind !== 'review') return undefined;
    let cancelled = false;
    // R2-F2: keep showing the previous ready state while refetching — never drop back to the loading note —
    // so an unmount/remount of the chips and override form on every legitimate refetch doesn't also happen
    // here on the (now much rarer) occasions this effect actually re-runs.
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    api.questDetail(quest.id)
      .then(({ quest: full }) => {
        if (cancelled) return;
        setState({ status: 'ready', review: full.upstreamReview ?? null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: errorText(err) });
      });
    return () => {
      cancelled = true;
    };
    // R2-F2: quest.reviewOverride is a fresh object on every snapshot delivery even when nothing about it
    // actually changed, so depending on it directly refetched on every snapshot forever once an override
    // existed (about every 10s here, with no revision change in between). Depend on the primitive `at`
    // instead — the override's own identity in this project's terms — alongside the parents' own signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, quest.id, quest.kind, quest.reviewOverride?.at, parentsKey]);

  if (quest.kind !== 'review') return null;
  if (state.status === 'ready' && !state.review) return null;

  const recordOverride = async () => {
    const reason = overrideReason.trim();
    if (!reason) {
      pushToast(t('upstreamEvidence.reasonRequired'));
      return;
    }
    setBusy(true);
    try {
      await api.reviewOverride(quest.id, reason);
      setOverrideReason('');
      pushToast(t('upstreamEvidence.overrideSuccess', { questId: quest.id }));
      refresh();
    } catch (err) {
      pushToast(t('upstreamEvidence.overrideFailed', { error: errorText(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DrawerSection en="UPSTREAM EVIDENCE" zh={t('upstreamEvidence.title')}>
      {state.status === 'loading' ? <p className="receipt-none">{t('upstreamEvidence.loading')}</p> : null}
      {state.status === 'error' ? <p className="receipt-none">{t('upstreamEvidence.loadFailed', { error: state.message })}</p> : null}
      {state.status === 'ready' && state.review ? (
        <div className="upstream-evidence">
          {state.review.parents.map((parent) => (
            <UpstreamParentRow key={parent.id} parent={parent} />
          ))}
          {state.review.blocked ? (
            <p className="upstream-evidence-refusal">
              {t('upstreamEvidence.refusalPrefix', { kinds: state.review.required.map((k) => KIND_LABEL[k]).join(t('common.listSeparator')) })}
              {state.review.failingParents.join(t('common.listSeparator'))}
              {t('upstreamEvidence.refusalSuffix')}
            </p>
          ) : null}
          {state.review.override ? (
            <p className={state.review.override.valid ? 'upstream-evidence-override' : 'upstream-evidence-override upstream-evidence-override-invalid'}>
              {state.review.override.valid
                ? t('upstreamEvidence.overrideValid', {
                    by: state.review.override.by === 'owner' ? t('upstreamEvidence.overrideByOwner') : state.review.override.by,
                    time: formatClock(state.review.override.at),
                    reason: state.review.override.reason,
                  })
                : t('upstreamEvidence.overrideInvalid', { reason: state.review.override.reason })}
            </p>
          ) : null}
          {state.review.blocked ? (
            <div className="upstream-evidence-override-form">
              <textarea
                rows={2}
                placeholder={t('upstreamEvidence.overridePlaceholder')}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
              <div className="row end">
                <button className="btn" type="button" disabled={busy} onClick={() => void recordOverride()}>
                  {t('upstreamEvidence.recordOverride')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </DrawerSection>
  );
}
