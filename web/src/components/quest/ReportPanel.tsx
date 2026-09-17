import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import '../../styles/report-evidence.css';

interface ReportPanelProps {
  // DOM id (aria-controls target from the receipt's toggle button); not part of the fetch identity.
  id?: string;
  questId: string;
  // Part of the fetch identity, alongside questId: a project switch during a pending fetch must not paint
  // this project's stale response over the next one (see QuestReceipt's own identity reset).
  projectId: string;
  onClose: () => void;
}

type ErrorCode = 'gone' | 'changed' | 'server' | 'network';

type PanelState =
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'error'; code: ErrorCode; message: string };

const UNAVAILABLE_PREFIX = '报告不可用：';

// Strips a reason the server already prefixed with 报告不可用 (two of the three 404 causes in
// src/server/questRoutes.js do this; the third — a moved/deleted file's own reason from readCapturedReport —
// does not), so the panel never doubles the label onto its own message.
export function bareReason(message: string): string {
  return message.startsWith(UNAVAILABLE_PREFIX) ? message.slice(UNAVAILABLE_PREFIX.length) : message;
}

export function errorLine(state: { code: ErrorCode; message: string }): string {
  if (state.code === 'gone') return `${UNAVAILABLE_PREFIX}${bareReason(state.message)}`;
  if (state.code === 'changed') return state.message || '报告在记录之后变过，不再当作同一份显示';
  // A genuine transport failure (no response at all) reads as a network problem; any HTTP status the server
  // did answer with (other than the 404/409 handled above) is its own failure, not the browser's.
  if (state.code === 'server') return `服务器读取报告出错：${state.message}`;
  return `没读到报告（网络请求失败）：${state.message}`;
}

// The bounded full report text (item 34), fetched only when opened — never cached across opens, never part
// of the snapshot fan-out. Plain text, monospace, read-only: the server sends text/plain with nosniff so
// this can never be treated as HTML, and this panel renders it as text too, never dangerouslySetInnerHTML.
export function ReportPanel({ id, questId, projectId, onClose }: ReportPanelProps) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api.report(questId)
      .then((body) => {
        if (cancelled) return;
        setState({ status: 'ready', text: body.text, truncated: body.truncated });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        // ApiError only ever comes from a response the server actually sent (api.report throws it from
        // `!response.ok`), so its status is always set; anything else means fetch itself never got a
        // response — a genuine network failure, not a server error.
        if (err instanceof ApiError) {
          const code: ErrorCode = err.status === 409 ? 'changed' : err.status === 404 ? 'gone' : 'server';
          setState({ status: 'error', code, message });
          return;
        }
        setState({ status: 'error', code: 'network', message });
      });
    return () => {
      cancelled = true;
    };
    // projectId is part of the fetch identity on purpose: a project switch must start a fresh read, not
    // reuse whatever this panel already has in state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, questId]);

  return (
    <div id={id} className="report-panel" role="region" aria-label="完整报告">
      <div className="report-panel-head">
        <strong>完整报告</strong>
        <button type="button" className="btn" onClick={onClose}>
          收起
        </button>
      </div>
      {state.status === 'loading' ? <p className="report-panel-note">读取中…</p> : null}
      {state.status === 'error' ? <p className="report-panel-error">{errorLine(state)}</p> : null}
      {state.status === 'ready' ? (
        <>
          {state.truncated ? <p className="report-panel-truncated">报告没有读完整，只显示了前面一部分</p> : null}
          <pre className="report-panel-body" tabIndex={0}>{state.text}</pre>
        </>
      ) : null}
    </div>
  );
}
