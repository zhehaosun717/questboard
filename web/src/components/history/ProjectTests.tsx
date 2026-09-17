import type { Verification } from '../../api/types';
import { summarizeProjectTests } from '../../lib/history';
import { useT, type I18nKey } from '../../lib/i18n';
import '../../styles/history.css';

/**
 * The project's OWN latest verification (src/lanes progress files), one clearly-labelled panel —
 * replacing the per-step chips that repeated the same result everywhere. It speaks for the whole
 * project only; no task may point at it as its own proof.
 */
export interface ProjectTestsProps {
  verification: Verification | null;
  /** ISO time of the lanes report that carried this result. */
  asOf: string | null;
  /** Provenance of `verification` itself (revision 6 F2): before the first successful lanes read,
   * `verification` is null for a reason that has nothing to do with the project's own config, and this
   * panel must say which — never claim "not configured" while the read is only pending or has failed. */
  lanesState: 'loading' | 'failed' | 'ok';
}

const OVERALL_LABEL_KEYS: Record<'pass' | 'fail' | 'running', I18nKey> = {
  pass: 'projectTests.overallPass',
  fail: 'projectTests.overallFail',
  running: 'projectTests.overallRunning',
};

const LINE_LABEL_KEYS: Record<'pass' | 'fail' | 'done', I18nKey> = {
  pass: 'projectTests.linePass',
  fail: 'projectTests.lineFail',
  done: 'projectTests.lineDone',
};

function stamp(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ProjectTests({ verification, asOf, lanesState }: ProjectTestsProps) {
  const t = useT();
  if (!verification) {
    const note =
      lanesState === 'loading'
        ? t('common.reading')
        : lanesState === 'failed'
          ? t('projectTests.readFailed')
          : t('projectTests.notConfigured');
    return (
      <section className="hist-project-tests" aria-label={t('projectTests.title')}>
        <header className="hist-pt-head">
          <span className="eyebrow">{t('projectTests.eyebrow')}</span>
          <h3>{t('projectTests.title')}</h3>
        </header>
        <p className="hist-pt-note">{note}</p>
      </section>
    );
  }
  const summary = summarizeProjectTests(verification);
  return (
    <section className="hist-project-tests" aria-label={t('projectTests.title')}>
      <header className="hist-pt-head">
        <div>
          <span className="eyebrow">{t('projectTests.eyebrow')}</span>
          <h3>{t('projectTests.titleLatest')}</h3>
        </div>
        <div className="hist-pt-meta">
          <span className={`hist-pt-overall ${summary.overall}`}>{t(OVERALL_LABEL_KEYS[summary.overall])}</span>
          {asOf && <span className="hist-pt-asof">{t('projectTests.asOf', { time: stamp(asOf) })}</span>}
        </div>
      </header>
      <ul className="hist-pt-lines">
        {summary.lines.map((line) => (
          <li key={line.name}>
            <span className={`hist-pt-led ${line.verdict}`} aria-hidden="true" />
            <code>{line.name}</code>
            <span className="hist-pt-verdict">{t(LINE_LABEL_KEYS[line.verdict])}</span>
            <span className="hist-pt-value">{line.value}</span>
          </li>
        ))}
        {summary.suites.map((suite) => (
          <li key={suite.label}>
            <span
              className={`hist-pt-led ${suite.passed === suite.total ? 'pass' : 'fail'}`}
              aria-hidden="true"
            />
            <code>{suite.label}</code>
            <span className="hist-pt-value">
              {t('projectTests.passedCount', { passed: suite.passed, total: suite.total })}
            </span>
          </li>
        ))}
      </ul>
      <p className="hist-pt-note">{t('projectTests.note')}</p>
    </section>
  );
}
