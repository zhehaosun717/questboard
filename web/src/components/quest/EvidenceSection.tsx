import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { EvidenceItem, Quest, QuestEvidence } from '../../api/types';
import { formatClock } from '../../lib/board';
import { t, useT } from '../../lib/i18n';
import { DrawerSection } from './DrawerSection';
import '../../styles/report-evidence.css';

const KIND_LABEL: Record<EvidenceItem['kind'], string> = {
  get report() { return t('evidenceSection.kind.report'); },
  get 'project-verification'() { return t('evidenceSection.kind.projectVerification'); },
  get hook() { return t('evidenceSection.kind.hook'); },
};

const STATE_LABEL: Record<EvidenceItem['state'], string> = {
  get passed() { return t('evidenceSection.state.passed'); },
  get findings() { return t('evidenceSection.state.findings'); },
  get failed() { return t('evidenceSection.state.failed'); },
  get unknown() { return t('evidenceSection.state.unknown'); },
  get missing() { return t('evidenceSection.state.missing'); },
  get not_configured() { return t('evidenceSection.state.notConfigured'); },
  get queued() { return t('evidenceSection.state.queued'); },
  get running() { return t('evidenceSection.state.running'); },
  get timedout() { return t('evidenceSection.state.timedout'); },
};

// The raw item.source value (delivery/exit-file/summary/progress-strip, or a hook's command), mapped to a
// Chinese name; an unrecognized value (never expected, but never hidden) falls back to itself.
const SOURCE_LABEL: Record<string, string> = {
  get delivery() { return t('evidenceSection.source.delivery'); },
  get 'exit-file'() { return t('evidenceSection.source.exitFile'); },
  get summary() { return t('evidenceSection.source.summary'); },
  get 'progress-strip'() { return t('evidenceSection.source.progressStrip'); },
};

interface EvidenceSectionProps {
  quest: Quest;
  projectId: string;
}

type SectionState =
  | { status: 'loading' }
  | { status: 'ready'; evidence: QuestEvidence | null }
  | { status: 'error'; message: string };

// Exported for EvidenceSection.test.tsx: a pure row renderer, testable with real JSX/SSR without needing the
// on-demand fetch (which never resolves under this project's no-jsdom test setup) to settle first.
export function EvidenceRow({ item }: { item: EvidenceItem }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const reference = [item.source, item.ref, item.digest].filter((part): part is string => Boolean(part));
  const copy = () => {
    if (!reference.length) return;
    navigator.clipboard?.writeText(reference.join(' · ')).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className={`attempt-evidence-item attempt-evidence-${item.state}${item.bound ? '' : ' attempt-evidence-unbound'}`}>
      <div className="attempt-evidence-head">
        <strong>{KIND_LABEL[item.kind]}</strong>
        <span className="attempt-evidence-chip">{STATE_LABEL[item.state] ?? item.state}</span>
        {/* F6: missing/not_configured mean there is no record at all, not a wrong-version one — the chip
            (and its reason line below) already say why, so 不是这次派遣的 would only be noise here. */}
        {!item.bound && item.state !== 'missing' && item.state !== 'not_configured' ? (
          <span className="attempt-evidence-chip attempt-evidence-chip-unbound">{t('evidenceSection.notThisAttempt')}</span>
        ) : null}
      </div>
      {reference.length ? (
        <p className="attempt-evidence-ref">
          {item.source ? (
            <>
              {item.kind === 'hook' ? t('evidenceSection.commandLabel') : t('evidenceSection.sourceLabel')} {SOURCE_LABEL[item.source] ?? item.source}{' '}
            </>
          ) : null}
          {item.ref ? (
            <>
              {t('evidenceSection.pathLabel')} <code>{item.ref}</code>{' '}
            </>
          ) : null}
          {item.digest ? (
            <>
              {t('evidenceSection.digestLabel')} <code>{item.digest.slice(0, 12)}</code>{' '}
            </>
          ) : null}
          <button type="button" className="btn attempt-evidence-copy" onClick={copy}>
            {copied ? t('evidenceSection.copied') : t('evidenceSection.copy')}
          </button>
        </p>
      ) : null}
      {item.capturedAt ? <p className="attempt-evidence-time">{t('evidenceSection.recordedAt', { time: formatClock(item.capturedAt) })}</p> : null}
      {item.reason ? <p className="attempt-evidence-reason">{item.reason}</p> : null}
    </div>
  );
}

// The three attempt-bound evidence items (S2, src/core/evidence.js), fetched on demand from the detail route
// alongside the receipt's own report block — never part of the snapshot fan-out, never polled. This owns its
// own DrawerSection wrapper (like the EVIDENCE ladder above it): an older server that sends no `evidence`
// field at all renders exactly as before this section existed — no heading, nothing — once the fetch settles,
// not just an empty body under a visible heading. A late response after the quest or project changed is
// discarded rather than painted over the current one.
export function EvidenceSection({ quest, projectId }: EvidenceSectionProps) {
  const t = useT();
  const [state, setState] = useState<SectionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.questDetail(quest.id)
      .then(({ quest: full }) => {
        if (cancelled) return;
        setState({ status: 'ready', evidence: full.evidence ?? null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, quest.id]);

  if (state.status === 'ready' && !state.evidence) return null;

  return (
    <DrawerSection en="ATTEMPT EVIDENCE" zh={t('evidenceSection.title')}>
      {state.status === 'loading' ? <p className="receipt-none">{t('evidenceSection.loading')}</p> : null}
      {state.status === 'error' ? <p className="receipt-none">{t('evidenceSection.loadFailed', { error: state.message })}</p> : null}
      {state.status === 'ready' && state.evidence ? (
        <div className="attempt-evidence">
          <p className="attempt-evidence-attempt">
            {/* F6: the worker name (when the server sends it), not the bare attemptId UUID; an older server
                without attemptName still shows the id so the line is never blank for a real attempt. */}
            {state.evidence.attemptName ?? state.evidence.attemptId
              ? t('evidenceSection.thisAttempt', { name: state.evidence.attemptName ?? state.evidence.attemptId ?? '' })
              : t('evidenceSection.noDispatch')}
            {state.evidence.attemptAt ? ` · ${formatClock(state.evidence.attemptAt)}` : ''}
          </p>
          {state.evidence.items.map((item) => (
            <EvidenceRow key={item.kind} item={item} />
          ))}
        </div>
      ) : null}
    </DrawerSection>
  );
}
