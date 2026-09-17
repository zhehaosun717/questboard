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

// The state a report fetch settles into, given a stubbed-or-real `api.report`. Pulled out of the effect
// below (item 7/M6) so the async, 404 and 409 paths are reachable from vitest with a plain stub — this
// project has no DOM test environment installed (see QuestReceipt.test.tsx's own note on the same gap), so
// a `useEffect` full of this logic inline would only ever be provable by the browser scripts under
// web/test/browser, never by `npx vitest run`.
export async function loadReport(apiClient: Pick<typeof api, 'report'>, questId: string): Promise<PanelState> {
  try {
    const body = await apiClient.report(questId);
    return { status: 'ready', text: body.text, truncated: body.truncated };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // ApiError only ever comes from a response the server actually sent (api.report throws it from
    // `!response.ok`), so its status is always set; anything else means fetch itself never got a
    // response — a genuine network failure, not a server error.
    if (err instanceof ApiError) {
      const code: ErrorCode = err.status === 409 ? 'changed' : err.status === 404 ? 'gone' : 'server';
      return { status: 'error', code, message };
    }
    return { status: 'error', code: 'network', message };
  }
}

// A focus target duck-typed like threadAsyncGuards' canReceiveFocus (kept local — quest/* does not depend
// on components/threads/*): still connected to the document and not disabled.
interface FocusTarget {
  isConnected: boolean;
  disabled?: boolean;
  focus: () => void;
}

// M2/item 4: refocuses `opener` (captured at mount — see the effect below) only if it can still take focus.
// Exported so the decision is unit-testable with a plain object standing in for a real button, the same way
// this project already tests focus-adjacent logic (threadAsyncGuards.test.ts's canReceiveFocus) without a
// DOM: real, intercepted browser coverage of the actual unmount race is out of reach the same way item 7's
// fetch paths are (no DOM test environment here, and the brief for this fix bars installing one).
export function restoreOpenerFocus(opener: FocusTarget | null): void {
  if (opener && opener.isConnected && !opener.disabled) opener.focus();
}

// The bounded full report text (item 34), fetched only when opened — never cached across opens, never part
// of the snapshot fan-out. Plain text, monospace, read-only: the server sends text/plain with nosniff so
// this can never be treated as HTML, and this panel renders it as text too, never dangerouslySetInnerHTML.
export function ReportPanel({ id, questId, projectId, onClose }: ReportPanelProps) {
  const [state, setState] = useState<PanelState>({ status: 'loading' });

  // M2: this panel's own 收起 button lives inside it, so the instant the panel (or that button) is removed
  // from the DOM, the browser drops focus to `<body>` unless something else claims it first. Whatever had
  // focus when this panel mounted is almost always QuestReceipt's toggle button — captured here and handed
  // back on unmount, so closing via 收起 lands focus back on the control that opened it, never on `<body>`.
  useEffect(() => {
    const opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => restoreOpenerFocus(opener);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadReport(api, questId).then((next) => {
      if (!cancelled) setState(next);
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
