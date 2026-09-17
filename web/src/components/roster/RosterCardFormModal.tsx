import { useState } from 'react';
import { api } from '../../api/client';
import type { Card } from '../../api/types';
import { useT } from '../../lib/i18n';
import { BILLING } from '../../lib/labels';
import { type CardFormValues, suggestDuplicateId, validateCardForm } from '../../lib/rosterForm';

interface RosterCardFormModalProps {
  card?: Card;
  // Open the form filled from `card` but as a new card: every field is kept, only the id has to change.
  duplicate?: boolean;
  lanes: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export function RosterCardFormModal({
  card,
  duplicate,
  lanes,
  onClose,
  onSuccess,
}: RosterCardFormModalProps) {
  const t = useT();
  const isDuplicate = Boolean(duplicate && card);
  const isNew = !card || isDuplicate;

  const [id, setId] = useState(card && isDuplicate ? suggestDuplicateId(card.id) : card?.id ?? '');
  const [name, setName] = useState(card?.name ?? '');
  const [provider, setProvider] = useState(card?.provider ?? '');
  const [lane, setLane] = useState(card?.lane ?? (lanes[0] ?? ''));
  const [model, setModel] = useState(card?.model ?? '');
  const [family, setFamily] = useState(card?.family ?? '');
  const [variant, setVariant] = useState(card?.variant ?? '');
  const initialVariantsMode = card?.variants === undefined ? 'unknown' : card.variants.length === 0 ? 'none' : 'list';
  const [variantsMode, setVariantsMode] = useState<'unknown' | 'none' | 'list'>(initialVariantsMode);
  const [variants, setVariants] = useState(card?.variants?.join(', ') ?? '');
  const [agent, setAgent] = useState(card?.agent ?? '');
  const [billing, setBilling] = useState(card?.billing ?? '');
  const [maxParallel, setMaxParallel] = useState<string>(
    card?.maxParallel !== undefined ? String(card.maxParallel) : '1',
  );
  const [strengths, setStrengths] = useState(card?.strengths?.join(', ') ?? '');
  const [notes, setNotes] = useState(card?.notes ?? '');
  const [env, setEnv] = useState(
    Object.entries(card?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const values: CardFormValues = {
      id,
      name,
      provider,
      lane,
      model,
      family,
      variant,
      variants: variantsMode === 'unknown' ? undefined : variantsMode === 'none' ? [] : variants,
      agent,
      billing,
      maxParallel,
      strengths,
      notes,
      env,
    };

    // Saving upserts by id, so reusing the source id would overwrite the card being copied.
    if (isDuplicate && card && id.trim() === card.id) {
      setErrors({ id: t('rosterForm.duplicateIdError') });
      return;
    }

    const validated = validateCardForm(values, lanes);
    if (!validated.value) {
      setErrors(validated.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      await api.saveCard(validated.value);
      onSuccess();
    } catch (err) {
      setSubmitting(false);
      setServerError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="order roster-form-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cardFormTitle"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="eyebrow">
          {!card
            ? t('rosterForm.eyebrowNew')
            : isDuplicate
              ? t('rosterForm.eyebrowDuplicate')
              : t('rosterForm.eyebrowEdit')}
        </p>
        <h2 id="cardFormTitle">
          {!card
            ? t('rosterForm.titleNew')
            : isDuplicate
              ? t('rosterForm.titleDuplicate', { name: card.name })
              : t('rosterForm.titleEdit', { name: card.name })}
        </h2>

        {serverError ? (
          <div className="warn-tape roster-server-error">{serverError}</div>
        ) : null}

        <form onSubmit={handleSubmit} className="roster-form-body">
          <div className="form-field">
            <label htmlFor="card-id">
              {t('rosterForm.idLabel', { mutable: isNew ? '' : t('rosterForm.idNotEditable') })}
              {errors.id ? <span className="field-error"> · {errors.id}</span> : null}
            </label>
            <input
              id="card-id"
              value={id}
              disabled={!isNew}
              maxLength={48}
              placeholder={t('rosterForm.idPlaceholder')}
              onChange={(e) => setId(e.target.value)}
            />
            {isDuplicate && card ? (
              <p className="hint">
                {t('rosterForm.duplicateHint', { name: card.name })}
              </p>
            ) : null}
          </div>

          <div className="form-grid-2">
            <div className="form-field">
              <label htmlFor="card-name">
                {t('rosterForm.name')}
                {errors.name ? <span className="field-error"> · {errors.name}</span> : null}
              </label>
              <input
                id="card-name"
                value={name}
                placeholder={t('rosterForm.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="card-provider">
                {t('rosterForm.provider')}
                {errors.provider ? <span className="field-error"> · {errors.provider}</span> : null}
              </label>
              <input
                id="card-provider"
                value={provider}
                placeholder={t('rosterForm.providerPlaceholder')}
                onChange={(e) => setProvider(e.target.value)}
              />
            </div>
          </div>

          <div className="form-grid-2">
            <div className="form-field">
              <label htmlFor="card-lane">
                {t('rosterForm.lane')}
                {errors.lane ? <span className="field-error"> · {errors.lane}</span> : null}
              </label>
              <select
                id="card-lane"
                value={lane}
                onChange={(e) => setLane(e.target.value)}
              >
                {lanes.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="card-family">
                {t('rosterForm.family')}
                {errors.family ? <span className="field-error"> · {errors.family}</span> : null}
              </label>
              <input
                id="card-family"
                value={family}
                placeholder={t('rosterForm.familyPlaceholder')}
                onChange={(e) => setFamily(e.target.value)}
              />
            </div>
          </div>

          <div className="form-grid-2">
            <div className="form-field">
              <label htmlFor="card-model">
                {t('rosterForm.model')}
                {errors.model ? <span className="field-error"> · {errors.model}</span> : null}
              </label>
              <input
                id="card-model"
                value={model}
                placeholder={t('rosterForm.modelPlaceholder')}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="card-variant">{t('rosterForm.variant')}</label>
              <input
                id="card-variant"
                value={variant}
                placeholder={t('rosterForm.variantPlaceholder')}
                onChange={(e) => setVariant(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="card-variants-mode">
              {t('rosterForm.variants')}
              {errors.variants ? <span className="field-error"> · {errors.variants}</span> : null}
            </label>
            <select
              id="card-variants-mode"
              value={variantsMode}
              onChange={(e) => setVariantsMode(e.target.value as 'unknown' | 'none' | 'list')}
            >
              <option value="unknown">{t('rosterForm.variantsUnknown')}</option>
              <option value="none">{t('rosterForm.variantsNone')}</option>
              <option value="list">{t('rosterForm.variantsList')}</option>
            </select>
            {variantsMode === 'list' ? (
              <input
                id="card-variants"
                value={variants}
                placeholder={t('rosterForm.variantsPlaceholder')}
                onChange={(e) => setVariants(e.target.value)}
              />
            ) : null}
            <p className="hint">{t('rosterForm.variantsHint')}</p>
          </div>

          <div className="form-grid-3">
            <div className="form-field">
              <label htmlFor="card-agent">{t('rosterForm.agent')}</label>
              <input
                id="card-agent"
                value={agent}
                placeholder={t('rosterForm.agentPlaceholder')}
                onChange={(e) => setAgent(e.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="card-billing">
                {t('rosterForm.billing')}
                {errors.billing ? <span className="field-error"> · {errors.billing}</span> : null}
              </label>
              <select
                id="card-billing"
                value={billing}
                onChange={(e) => setBilling(e.target.value)}
              >
                <option value="">{t('rosterForm.billingUnset')}</option>
                {Object.entries(BILLING).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="card-maxParallel">
                {t('rosterForm.maxParallel')}
                {errors.maxParallel ? (
                  <span className="field-error"> · {errors.maxParallel}</span>
                ) : null}
              </label>
              <input
                id="card-maxParallel"
                type="number"
                min={1}
                step={1}
                value={maxParallel}
                onChange={(e) => setMaxParallel(e.target.value)}
              />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="card-strengths">{t('rosterForm.strengths')}</label>
            <input
              id="card-strengths"
              value={strengths}
              placeholder={t('rosterForm.strengthsPlaceholder')}
              onChange={(e) => setStrengths(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="card-notes">
              {t('rosterForm.notes')}
              {errors.notes ? <span className="field-error"> · {errors.notes}</span> : null}
            </label>
            <textarea
              id="card-notes"
              maxLength={300}
              rows={3}
              value={notes}
              placeholder={t('rosterForm.notesPlaceholder')}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="card-env">
              {t('rosterForm.env')}
              {errors.env ? <span className="field-error"> · {errors.env}</span> : null}
            </label>
            <textarea
              id="card-env"
              rows={3}
              value={env}
              placeholder={t('rosterForm.envPlaceholder')}
              onChange={(e) => setEnv(e.target.value)}
            />
          </div>

          <div className="row end form-actions">
            <button className="btn ghost" type="button" onClick={onClose}>
              {t('common.neverMind')}
            </button>
            <button
              className="btn primary"
              type="submit"
              disabled={submitting}
            >
              {submitting ? t('rosterForm.submitting') : isNew ? t('rosterForm.submitNew') : t('rosterForm.submitSave')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
