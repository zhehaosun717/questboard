import type { LaneDraft } from '../../lib/settingsForm';
import { LaneCard } from './LaneCard';

interface SettingsLanesSectionProps {
  lanes: LaneDraft[];
  errors: Record<string, string>;
  onChange: (lanes: LaneDraft[]) => void;
}

export function SettingsLanesSection({
  lanes,
  errors,
  onChange,
}: SettingsLanesSectionProps) {
  const updateLane = (index: number, patch: Partial<LaneDraft>) => {
    const next = [...lanes];
    const current = next[index];
    if (!current) return;
    next[index] = { ...current, ...patch };
    onChange(next);
  };

  const removeLane = (index: number) => {
    onChange(lanes.filter((_, i) => i !== index));
  };

  const addLane = () => {
    const id = `lane-${lanes.length + 1}`;
    onChange([
      ...lanes,
      {
        id,
        run: ['node', 'scripts/run-worker.mjs', '--lane', id],
        outputDir: `.questboard-data/workers/${id}`,
        api: '',
        deliveryDir: '',
        defaultModel: '',
        editCounter: '',
        serialize: false,
        spacingMs: '',
        env: '',
        sessionRun: [],
        sessionSaveTo: '',
      },
    ]);
  };

  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">通道 (Lanes)</h3>
      {errors.lanes ? (
        <div className="warn-tape settings-error-banner">{errors.lanes}</div>
      ) : null}

      <div className="settings-lanes-list">
        {lanes.map((lane, idx) => (
          <LaneCard
            key={idx}
            lane={lane}
            index={idx}
            errors={errors}
            onUpdate={(patch) => updateLane(idx, patch)}
            onRemove={() => removeLane(idx)}
          />
        ))}
      </div>

      <div className="settings-add-lane-wrap">
        <button type="button" className="btn secondary" onClick={addLane}>
          + 添加通道
        </button>
      </div>
    </section>
  );
}
