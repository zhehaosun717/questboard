import { type NextStep, WHO_LABEL } from '../../lib/nextStep';

interface NextStepPanelProps {
  step: NextStep;
  onOpenQuest: (questId: string) => void;
}

// The first thing in a dossier: who the quest waits on, what to do, and what happens after. The controls for
// that step sit directly below it; everything further down is record.
export function NextStepPanel({ step, onOpenQuest }: NextStepPanelProps) {
  const target = step.targetId;
  const who = WHO_LABEL[step.who];
  return (
    <section className={`next-step next-step-${step.tone}`} aria-label="下一步">
      <div className="next-step-eyebrow">
        NEXT · 下一步{who ? ` · ${who}` : ''}
      </div>
      <div className="next-step-title">{step.title}</div>
      <p className="next-step-detail">{step.detail}</p>
      {target ? (
        <button className="btn" type="button" onClick={() => onOpenQuest(target)}>
          打开 {target}
        </button>
      ) : null}
    </section>
  );
}
