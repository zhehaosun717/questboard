import type { LaneServerStatus } from '../../api/types';
import { useT } from '../../lib/i18n';

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
  const t = useT();
  if (!server) {
    return <div className="lane-server hint">{t('laneServer.pending')}</div>;
  }
  return (
    <div className={`lane-server ${server.up ? 'is-up' : 'is-down'}`}>
      <div className="lane-server-status">
        <i className={`led ${server.up ? 'ok' : 'bad'}`} aria-hidden="true" />
        <span>
          {server.up ? t('laneServer.up') : t('laneServer.down')}
          <code>{server.api}</code>
        </span>
      </div>
      {server.up ? null : server.serve ? (
        <button type="button" className="btn primary sm-btn" disabled={starting} onClick={onStart}>
          {starting ? t('laneServer.starting') : t('laneServer.start')}
        </button>
      ) : (
        <span className="lane-server-note">{t('laneServer.noServe')}</span>
      )}
      {message ? <div className={`lane-server-msg ${message.ok ? 'ok' : 'bad'}`}>{message.text}</div> : null}
    </div>
  );
}
