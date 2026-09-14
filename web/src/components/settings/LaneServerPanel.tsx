import type { LaneServerStatus } from '../../api/types';

export interface LaneServerMessage {
  ok: boolean;
  text: string;
}

interface LaneServerPanelProps {
  /** The running board's view of this lane; undefined while loading or when the saved lane has no api. */
  server: LaneServerStatus | undefined;
  starting: boolean;
  message: LaneServerMessage | undefined;
  onStart: () => void;
}

// A server lane is useless while its server is down: a dispatch fails ten seconds later with "fetch failed".
// Say whether it answers now, and start it from here instead of a terminal.
export function LaneServerPanel({ server, starting, message, onStart }: LaneServerPanelProps) {
  if (!server) {
    return <div className="lane-server hint">保存并重启看板后，这里会显示服务是否在运行</div>;
  }
  return (
    <div className={`lane-server ${server.up ? 'is-up' : 'is-down'}`}>
      <div className="lane-server-status">
        <i className={`led ${server.up ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span>
          {server.up ? '服务在运行' : '服务没开，派到这条通道的委托会失败'}
          <code>{server.api}</code>
        </span>
      </div>
      {server.up ? null : server.serve ? (
        <button type="button" className="btn primary sm-btn" disabled={starting} onClick={onStart}>
          {starting ? '正在启动…' : '一键启动服务'}
        </button>
      ) : (
        <span className="lane-server-note">下面填上启动命令，保存并重启看板后就能一键启动</span>
      )}
      {message ? <div className={`lane-server-msg ${message.ok ? 'ok' : 'bad'}`}>{message.text}</div> : null}
    </div>
  );
}
