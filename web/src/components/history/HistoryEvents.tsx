import { useState } from 'react';
import { eventKindLabel, formatEventClock, hasInvalidAt, laneLabel, type TaskGroup } from '../../lib/history';
import '../../styles/history.css';

export interface HistoryEventsProps {
  /** Filtered, grouped tasks; empty array renders nothing (the parent owns the no-results text). */
  groups: TaskGroup[];
}

function verdictClass(event: string): string {
  if (event === 'delivered' || event === 'owner_ruling' || event === 'status_done') return 'ok';
  if (event === 'failed' || event === 'bounced' || event === 'stalled' || event === 'delivery_write_failed') return 'bad';
  if (event === 'dispatched' || event === 'assigned' || event === 'status_reviewing') return 'run';
  return 'info';
}

/**
 * Every real value the record carries, complete and in order:接入方式 (lane), 模型 (model, with its
 * variant folded in when present), 冒险者 (worker name). `store.emitEvent` commonly writes all three
 * together (review 73f4bd71 B1: 670/812 real lines carry lane + name + model) and hiding any of them
 * behind a `lane · name` shortcut loses the model on every one of those lines.
 */
function whoParts(ev: TaskGroup['events'][number]): string[] {
  const parts: string[] = [];
  if (ev.lane) parts.push(laneLabel(ev.lane));
  if (ev.model) parts.push(ev.variant ? `${ev.model}/${ev.variant}` : ev.model);
  if (ev.name) parts.push(ev.name);
  return parts;
}

/** How long a detail can get before the 2-line clamp is likely to actually cut it (review 73f4bd71:
 * real details run up to 377 chars, 205/812 lines pass 120). Below this the toggle would be a no-op,
 * so it stays hidden rather than cluttering every short line with a control that does nothing. */
const DETAIL_EXPAND_THRESHOLD = 80;

function EventDetail({ id, detail }: { id: string; detail: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!detail) return null;
  const canClip = detail.length > DETAIL_EXPAND_THRESHOLD;
  return (
    <span className="hist-ev-detail-wrap">
      <span id={id} className={`hist-ev-detail${expanded ? ' expanded' : ''}`}>
        {detail}
      </span>
      {canClip && (
        <button
          type="button"
          className="hist-ev-detail-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : '展开全文'}
        </button>
      )}
    </span>
  );
}

function EventLine({ ev }: { ev: TaskGroup['events'][number] }) {
  const who = whoParts(ev);
  return (
    <div className="hist-event-line">
      <span className="hist-ev-time">{formatEventClock(ev.at)}</span>
      {hasInvalidAt(ev) && (
        <span className="hist-ev-badtime" title="这条记录自身的时间无法识别">
          ⚠ 时间未识别
        </span>
      )}
      <span className={`hist-ev-kind ${verdictClass(ev.event)}`}>{eventKindLabel(ev.event)}</span>
      {/* No aria-label here: ARIA 1.2 doesn't allow naming a generic span, and the visible text already
          says the complete thing (lane · model/variant · name) — a label would only be invalid AND
          redundant (revision 5 note 5). */}
      {who.length > 0 ? <span className="hist-ev-who">{who.join(' · ')}</span> : null}
      {ev.by ? <span className="hist-ev-by">由 {ev.by}</span> : null}
      <EventDetail id={`hist-ev-detail-${ev.seq}`} detail={ev.detail} />
    </div>
  );
}

/**
 * The dispatch timeline: one block per task, every record in real seq order (the file order), newest
 * task first. The group heading already names the task, so a per-line id would only repeat it — and at
 * up to 162 characters, a repeated id is what overflowed the page at 1024/1440 (review 25756a14 B4).
 */
export function HistoryEvents({ groups }: HistoryEventsProps) {
  return (
    <div className="hist-timeline">
      {groups.map((group) => {
        // groupEventsByTask never creates an empty group: it starts each one from the event that
        // introduced its package. first/last are the group's own bounds, not the whole timeline's.
        const first = group.events[0];
        const last = group.events.at(-1);
        if (!first || !last) throw new Error(`task group ${group.key} has no events`);
        return (
          <article key={group.key} className="hist-group" aria-label={`任务 ${group.key}`}>
            <header className="hist-group-head">
              <code className="hist-group-pkg">{group.key}</code>
              <span className="hist-group-count">{group.events.length} 条记录</span>
              <span className="hist-group-span">
                {formatEventClock(first.at)} 起 → {formatEventClock(last.at)}
              </span>
            </header>
            {group.events.map((ev) => (
              <EventLine key={ev.seq} ev={ev} />
            ))}
          </article>
        );
      })}
    </div>
  );
}
