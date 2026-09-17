import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Card, LaneServerStatus } from '../../api/types';
import { createLaneFormKey, type LaneDraft } from '../../lib/settingsForm';
import { t as tStatic, useT } from '../../lib/i18n';
import { LaneCard } from './LaneCard';
import type { LaneServerMessage } from './LaneServerPanel';

interface SettingsLanesSectionProps {
  lanes: LaneDraft[];
  errors: Record<string, string>;
  onChange: (lanes: LaneDraft[]) => void;
  roster?: readonly Card[];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SettingsLanesSection({
  lanes,
  errors,
  onChange,
  roster,
}: SettingsLanesSectionProps) {
  const t = useT();
  // The running board's lanes, by id: the start button acts on the saved, loaded config, not on the draft.
  const [servers, setServers] = useState<Record<string, LaneServerStatus>>({});
  const [startingId, setStartingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, LaneServerMessage>>({});

  const loadServers = useCallback(async () => {
    const report = await api.laneServers();
    setServers(Object.fromEntries(report.lanes.map((lane) => [lane.id, lane])));
  }, []);

  useEffect(() => {
    loadServers().catch((err) => setMessages({ '': { ok: false, text: tStatic('settingsLanes.loadFailed', { error: errorText(err) }) } }));
  }, [loadServers]);

  const startServer = async (laneId: string) => {
    setStartingId(laneId);
    setMessages((prev) => {
      const { [laneId]: _dropped, ...rest } = prev;
      return rest;
    });
    try {
      const result = await api.startLaneServer(laneId);
      setMessages((prev) => ({ ...prev, [laneId]: { ok: true, text: result.started ? tStatic('settingsLanes.started') : tStatic('settingsLanes.alreadyUp') } }));
    } catch (err) {
      setMessages((prev) => ({ ...prev, [laneId]: { ok: false, text: tStatic('settingsLanes.startFailed', { error: errorText(err) }) } }));
    } finally {
      setStartingId(null);
      await loadServers().catch(() => undefined);
    }
  };

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
        formKey: createLaneFormKey(),
        originalId: null,
        run: ['node', 'scripts/run-worker.mjs', '--lane', id],
        outputDir: `.questboard-data/workers/${id}`,
        api: '',
        serve: [],
        deliveryDir: '',
        defaultModel: '',
        editCounter: '',
        serialize: false,
        spacingMs: '',
        env: '',
        sessionRun: [],
        sessionSaveTo: '',
        healthPath: '',
        healthJson: '',
        optionalArgs: [],
      },
    ]);
  };

  const loadError = messages[''];

  return (
    <section className="settings-section">
      <h3 className="settings-sec-title">{t('settingsLanes.title')}</h3>
      {errors.lanes ? (
        <div className="warn-tape settings-error-banner">{errors.lanes}</div>
      ) : null}
      {loadError ? <div className="warn-tape settings-error-banner">{loadError.text}</div> : null}

      <div className="settings-lanes-list">
        {lanes.map((lane, idx) => (
          <LaneCard
            key={lane.formKey}
            lane={lane}
            index={idx}
            errors={errors}
            server={servers[lane.id]}
            serverStarting={startingId === lane.id}
            serverMessage={messages[lane.id]}
            onStartServer={() => void startServer(lane.id)}
            onUpdate={(patch) => updateLane(idx, patch)}
            onRemove={() => removeLane(idx)}
            roster={roster}
          />
        ))}
      </div>

      <div className="settings-add-lane-wrap">
        <button type="button" className="btn secondary" onClick={addLane}>
          {t('settingsLanes.add')}
        </button>
      </div>
    </section>
  );
}
