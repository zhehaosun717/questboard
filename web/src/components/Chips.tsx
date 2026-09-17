import type { Snapshot } from '../api/types';
import { formatClock } from '../lib/board';
import { useT } from '../lib/i18n';

interface ChipsProps {
  snap: Snapshot | null;
  connected: boolean;
  error: string | null;
}

// A dated `until` string can outlive the window it named (a passed known reset, or a manual relimit that
// keeps the old bounce's dated text while resetsAt itself is cleared to null) — never show it unless the
// entry's own resetsAt still parses to a real future time (review B3).
function hasActiveReset(resetsAt: string | null): boolean {
  if (!resetsAt) return false;
  const t = Date.parse(resetsAt);
  return Number.isFinite(t) && t > Date.now();
}

export function Chips({ snap, connected, error }: ChipsProps) {
  const t = useT();

  if (!snap) {
    return (
      <div id="chips" className="chips" aria-live="polite">
        <span className={`chip ${connected ? 'ok' : 'bad'}`}>
          <i className="led" />
          {connected ? t('chips.connected') : t('chips.reconnecting')}
        </span>
        {error && (
          <span className="chip bad">
            <i className="led" />
            {t('chips.readFailed', { error })}
          </span>
        )}
      </div>
    );
  }

  const v = snap.verification;
  let verificationChip: React.ReactNode = null;
  if (v && v.steps && v.steps.length > 0) {
    const failed = v.steps.filter(
      (step) => (step.kind === 'exit' || step.kind === 'errorCS') && step.value !== '0',
    );
    const counts = `${v.editXml ? ` · Edit ${v.editXml.passed}/${v.editXml.total}` : ''}${
      v.playXml ? ` · Play ${v.playXml.passed}/${v.playXml.total}` : ''
    }`;
    // The whole project's latest test run, not any one quest's; it sat above delivered quests reading as theirs.
    const result = failed.length > 0
      ? t('chips.projectTestsFailed', { names: failed.map((f) => f.name).join(t('common.listSeparator')) })
      : t('chips.projectTestsPassed');
    const text = t('chips.projectTests', { result, counts });
    verificationChip = (
      <span className={`chip ${failed.length > 0 ? 'bad' : 'ok'}`} title={t('chips.projectTestsTitle')}>
        <i className="led" />
        {text}
      </span>
    );
  }

  return (
    <div id="chips" className="chips" aria-live="polite">
      <span className={`chip ${connected ? 'ok' : 'bad'}`}>
        <i className="led" />
        {connected ? t('chips.connected') : t('chips.reconnecting')}
      </span>
      {snap.env.treeLocked && (
        <span className="chip warn">
          <i className="led" />
          {t('chips.treeLocked')}
        </span>
      )}
      {Object.entries(snap.laneLimits || {}).map(([lane, limit]) => {
        // The kept card can be manually re-limited after its bounce cleared (N18): the top-level `until` is
        // then the old bounce's, not a live one. Only show a recovery time while the card it names still
        // carries `derived` — i.e. the limit is still the automatic one this chip is reporting.
        const card = snap.roster.find((c) => c.id === limit.adventurerId);
        const showUntil = Boolean(limit.until && card?.derived && hasActiveReset(limit.resetsAt));
        return (
          <span className="chip warn" key={lane}>
            <i className="led" />
            {t('chips.laneLimited', { lane })}
            {showUntil && limit.until ? t('chips.laneLimitedUntil', { until: limit.until }) : ''}
          </span>
        );
      })}
      {Boolean(snap.openQuestions) && (
        <a className="chip warn" href="/board" target="_blank" rel="noreferrer">
          <i className="led" />
          {t('chips.openQuestions', { count: snap.openQuestions })}
        </a>
      )}
      {verificationChip}
      <span className="chip">
        <i className="led" />
        {t('chips.updatedAt', { time: formatClock(snap.generatedAt) })}
      </span>
    </div>
  );
}
