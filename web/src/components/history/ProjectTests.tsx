import type { Verification } from '../../api/types';
import { summarizeProjectTests } from '../../lib/history';
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

const OVERALL_LABEL: Record<'pass' | 'fail' | 'running', string> = {
  pass: '通过',
  fail: '有失败项',
  running: '进行中',
};

const LINE_LABEL: Record<'pass' | 'fail' | 'done', string> = {
  pass: '通过',
  fail: '失败',
  done: '跑完',
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
  if (!verification) {
    const note =
      lanesState === 'loading'
        ? '正在读取…'
        : lanesState === 'failed'
          ? '读取失败，暂时无法显示。'
          : '这个项目没有配置验证进度文件，暂无可展示的测试结果。';
    return (
      <section className="hist-project-tests" aria-label="项目测试">
        <header className="hist-pt-head">
          <span className="eyebrow">PROJECT TESTS</span>
          <h3>项目测试</h3>
        </header>
        <p className="hist-pt-note">{note}</p>
      </section>
    );
  }
  const summary = summarizeProjectTests(verification);
  return (
    <section className="hist-project-tests" aria-label="项目测试">
      <header className="hist-pt-head">
        <div>
          <span className="eyebrow">PROJECT TESTS</span>
          <h3>项目测试 · 最新全量结果</h3>
        </div>
        <div className="hist-pt-meta">
          <span className={`hist-pt-overall ${summary.overall}`}>{OVERALL_LABEL[summary.overall]}</span>
          {asOf && <span className="hist-pt-asof">截至 {stamp(asOf)}</span>}
        </div>
      </header>
      <ul className="hist-pt-lines">
        {summary.lines.map((line) => (
          <li key={line.name}>
            <span className={`hist-pt-led ${line.verdict}`} aria-hidden="true" />
            <code>{line.name}</code>
            <span className="hist-pt-verdict">{LINE_LABEL[line.verdict]}</span>
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
              {suite.passed}/{suite.total} 通过
            </span>
          </li>
        ))}
      </ul>
      <p className="hist-pt-note">
        这是整个项目最近一次验证的结果，只能说明项目当前的状态，不能作为任何一个委托完成的证明。
      </p>
    </section>
  );
}
