import type { Card, Quest, Snapshot } from '../../api/types';
import { getQuestVerdict, sharedRefusals } from '../../lib/questState';
import { DrawerSection } from './DrawerSection';

interface AssignSectionProps {
  quest: Quest;
  snap: Snapshot;
  onAssignCard: (questId: string, cardId: string) => void;
}

function CardLine({ card, why }: { card: Card; why: string[] }) {
  return (
    <div>
      <strong>{card.name}</strong>
      <span className="a-model">模型 {card.model} · 接入方式 {card.lane}</span>
      {why.length > 0 ? <div className="why">{why.join('；')}</div> : null}
    </div>
  );
}

// Only cards that can take the quest get a 派遣 button. When none can, the reason they all share is said
// once; listing every card under the same refusal was a wall of red with nothing to press.
export function AssignSection({ quest, snap, onAssignCard }: AssignSectionProps) {
  const shared = sharedRefusals(snap, quest.id);
  const sharedMessages = new Set(shared.map((reason) => reason.message));
  const ownReasons = (card: Card) =>
    (getQuestVerdict(snap, quest.id, card.id)?.reasons ?? [])
      .map((reason) => reason.message)
      .filter((message) => !sharedMessages.has(message));

  const eligible = snap.roster.filter((card) => getQuestVerdict(snap, quest.id, card.id)?.ok);
  const refused = snap.roster.filter((card) => !getQuestVerdict(snap, quest.id, card.id)?.ok);

  if (eligible.length === 0) {
    const withOwnReasons = refused.filter((card) => ownReasons(card).length > 0);
    return (
      <DrawerSection en="ASSIGN" zh="派出冒险者">
        <div className="assign-blocked">
          <strong>现在派不了</strong>
          {shared.length > 0 ? (
            <>
              <span>{shared.map((reason) => reason.message).join('；')}</span>
              <span className="assign-blocked-hint">这件事解决之前，把冒险者拖上来也接不了。</span>
            </>
          ) : (
            <span>{snap.roster.length === 0 ? '名册里还没有冒险者' : '每个冒险者各有原因'}</span>
          )}
        </div>
        {withOwnReasons.length > 0 ? (
          <details className="assign-details" open={shared.length === 0}>
            <summary>
              {shared.length > 0
                ? `另有 ${withOwnReasons.length} 个冒险者还有自己的原因`
                : `每个冒险者的原因（${withOwnReasons.length}）`}
            </summary>
            {withOwnReasons.map((card) => (
              <div key={card.id} className="pick no">
                <CardLine card={card} why={ownReasons(card)} />
              </div>
            ))}
          </details>
        ) : null}
      </DrawerSection>
    );
  }

  return (
    <DrawerSection en="ASSIGN" zh="派出冒险者">
      {eligible.map((card) => (
        <div key={card.id} className="pick ok">
          <CardLine card={card} why={[]} />
          <button className="btn primary" type="button" onClick={() => onAssignCard(quest.id, card.id)}>
            派出
          </button>
        </div>
      ))}
      {refused.length > 0 ? (
        <details className="assign-details">
          <summary>另有 {refused.length} 个现在不能接</summary>
          {refused.map((card) => (
            <div key={card.id} className="pick no">
              <CardLine card={card} why={ownReasons(card)} />
            </div>
          ))}
        </details>
      ) : null}
    </DrawerSection>
  );
}
