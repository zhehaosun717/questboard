import type { Snapshot } from '../api/types';
import { formatClock } from '../lib/board';

interface ChipsProps {
  snap: Snapshot | null;
  connected: boolean;
  error: string | null;
}

export function Chips({ snap, connected, error }: ChipsProps) {
  if (!snap) {
    return (
      <div id="chips" className="chips" aria-live="polite">
        <span className={`chip ${connected ? 'ok' : 'bad'}`}>
          <i className="led" />
          {connected ? '实时连接' : '重连中…'}
        </span>
        {error && (
          <span className="chip bad">
            <i className="led" />
            读取失败：{error}
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
    const text = `验证${failed.length > 0 ? `失败 ${failed.map((f) => f.name).join('、')}` : '通过'}${counts}`;
    verificationChip = (
      <span className={`chip ${failed.length > 0 ? 'bad' : 'ok'}`}>
        <i className="led" />
        {text}
      </span>
    );
  }

  return (
    <div id="chips" className="chips" aria-live="polite">
      <span className={`chip ${connected ? 'ok' : 'bad'}`}>
        <i className="led" />
        {connected ? '实时连接' : '重连中…'}
      </span>
      {snap.env.treeLocked && (
        <span className="chip warn">
          <i className="led" />
          🔒 coordinator 正在验证，暂停派遣
        </span>
      )}
      {Object.entries(snap.laneLimits || {}).map(([lane, limit]) => (
        <span className="chip warn" key={lane}>
          <i className="led" />
          {lane} 限额中{limit.until ? `，${limit.until} 恢复` : ''}
        </span>
      ))}
      {Boolean(snap.openQuestions) && (
        <a className="chip warn" href="/board" target="_blank" rel="noreferrer">
          <i className="led" />
          留言板待答 {snap.openQuestions}
        </a>
      )}
      {verificationChip}
      <span className="chip">
        <i className="led" />
        更新 {formatClock(snap.generatedAt)}
      </span>
    </div>
  );
}
