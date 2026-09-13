import { formatClock } from '../../lib/board';
import { formatHistoryEvent, type PackageHistoryEvent } from '../../lib/history';

interface HistoryEventsProps {
  events: PackageHistoryEvent[];
}

export function HistoryEvents({ events }: HistoryEventsProps) {
  return (
    <section className="history-events-box">
      <header className="sec-head">
        <span className="eyebrow">TODAY'S LOG</span>
        <h3>今日事件</h3>
      </header>
      <div className="hist-events-scroll">
        {events.length === 0 ? (
          <div className="empty">暂无事件</div>
        ) : (
          events.map((ev, index) => (
            <div key={`${ev.package}-${ev.at}-${index}`} className="hist-event-line">
              <span className="hist-ev-time">{formatClock(ev.at)}</span>
              <strong className="hist-ev-pkg">{ev.package}</strong>
              <span className="hist-ev-desc">{formatHistoryEvent(ev)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
