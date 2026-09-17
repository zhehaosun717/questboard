import type { Card } from '../../api/types';
import { formatMonthDay } from '../../lib/board';
import { useT } from '../../lib/i18n';
import { BILLING, CARD_STATUS } from '../../lib/labels';

export interface RosterCardRowProps {
  card: Card;
  onOpenStatus: (card: Card) => void;
  onEdit: (card: Card) => void;
  onDuplicate: (card: Card) => void;
  onDelete: (card: Card) => void;
}

// Feedback9 row 5: the card IS in the roster; only its status is inferred from lane evidence while it stays
// there. The old wording ("推断，不在名册里") said the opposite. The hint text now lives in the i18n table.

export function RosterCardRow({ card, onOpenStatus, onEdit, onDuplicate, onDelete }: RosterCardRowProps) {
  const t = useT();
  const isDerived = Boolean(card.derived);
  const billingLabel = card.billing ? BILLING[card.billing] ?? card.billing : '-';
  const led = card.status === 'available' ? 'ok' : card.status === 'limited' ? 'warn' : 'bad';
  const fullModel = `${card.model}${card.variant ? ` · ${card.variant}` : ''}`;
  const baseStatus = card.baseStatus ?? card.status;

  return (
    <tr className={isDerived ? 'row-derived' : ''}>
      <td>
        <div className="adv-cell-name">
          <strong title={t('rosterRow.nameTitle', {
            name: card.name,
            provider: card.provider || t('rosterRow.noProvider'),
            lane: card.lane,
          })}>{card.name}</strong>
          <code className="adv-cell-id" title={t('rosterRow.idTitle', { id: card.id })}>{card.id}</code>
        </div>
      </td>
      <td>
        <span className="lane-chip">{card.lane}</span>
      </td>
      <td>
        <div className="adv-cell-model" title={t('rosterRow.modelTitle', { model: fullModel })}>
          <span title={t('rosterRow.fullModelTitle', {
            model: card.model,
            variant: card.variant ? t('rosterRow.variantSuffix', { variant: card.variant }) : '',
          })}>
            {card.model}
            {card.variant ? ` · ${card.variant}` : ''}
          </span>
          {card.agent ? <span className="adv-agent-badge">{card.agent}</span> : null}
        </div>
      </td>
      <td>
        <span className={card.billing === 'payg' ? 'pay' : ''}>{billingLabel}</span>
      </td>
      <td>{card.maxParallel ?? 1}</td>
      <td className="adv-cell-strengths">
        {card.strengths && card.strengths.length > 0 ? (
          <div className="strengths-tags">
            {card.strengths.map((s) => (
              <span key={s} className="tag-strength">
                {s}
              </span>
            ))}
          </div>
        ) : (
          <span className="muted">-</span>
        )}
      </td>
      <td>
        <div className="adv-cell-status">
          <div className="status-row">
            <i className={`led ${led}`} />
            <span className={`st-label st-${card.status}`}>{CARD_STATUS[card.status] ?? card.status}</span>
          </div>
          {isDerived && baseStatus !== card.status ? (
            <span className="status-reason">{t('rosterRow.baseStatus', { status: CARD_STATUS[baseStatus] ?? baseStatus })}</span>
          ) : null}
          {card.statusSince ? <span className="status-since">{t('rosterRow.since', { date: formatMonthDay(card.statusSince) })}</span> : null}
          {card.statusReason ? (
            // N4: on a derived row this is the older manual reason sitting underneath the effective
            // status, not the reason for the current 限额 — label it so it does not read as one reason.
            <span className="status-reason" title={card.statusReason}>
              {isDerived ? t('rosterRow.baseReason', { reason: card.statusReason }) : card.statusReason}
            </span>
          ) : null}
          {isDerived && card.derived ? (
            <span className="derived-hint">
              {card.derived.reason}
              {card.derived.resetsAt ? '' : t('rosterRow.resetUnknown')}
            </span>
          ) : null}
          {isDerived ? <span className="derived-hint">{t('rosterRow.derivedHint')}</span> : null}
          {card.envPolicy ? (
            <span className="status-reason envpolicy-note" title={card.envPolicy.reason}>
              {t('rosterRow.envPolicy', { reason: card.envPolicy.reason })}
            </span>
          ) : null}
        </div>
      </td>
      <td className="adv-cell-actions">
        <div className="action-buttons">
          <button className="btn action-btn" type="button" onClick={() => onOpenStatus(card)}>
            {t('rosterRow.setStatus')}
          </button>
          <button className="btn action-btn" type="button" onClick={() => onEdit(card)}>
            {t('rosterRow.edit')}
          </button>
          <button
            className="btn action-btn"
            type="button"
            title={t('rosterRow.duplicateHint')}
            onClick={() => onDuplicate(card)}
          >
            {t('rosterRow.duplicate')}
          </button>
          <button className="btn action-btn danger-text" type="button" onClick={() => onDelete(card)}>
            {t('rosterRow.remove')}
          </button>
        </div>
      </td>
    </tr>
  );
}
