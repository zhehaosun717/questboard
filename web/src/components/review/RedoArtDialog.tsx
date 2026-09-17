import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { ApiError, api } from '../../api/client';
import { reviewSourcePath } from '../../lib/board';
import {
  describeExistingPackageRefusal,
  describeRedoFieldErrors,
  describeRedoProblem,
  findQuestByPackage,
  REDO_FIELD_LABELS,
  type RedoFieldErrors,
  type RedoFieldName,
} from '../../lib/redoSubmission';
import { useT } from '../../lib/i18n';
import type { ArtRedoRequest, Quest, ReviewPage, UnpostedBrief } from '../../api/types';
import '../../styles/review-redo.css';

export interface RedoDraft {
  packageId: string;
  brief: string;
  reviewPage: string;
}

export function isRedoDraftReady(draft: RedoDraft): boolean {
  return (
    draft.packageId.trim().length > 0 &&
    draft.brief.trim().length > 0 &&
    draft.reviewPage.length > 0
  );
}

export function buildRedoRequest(draft: RedoDraft): ArtRedoRequest {
  return {
    package: draft.packageId.trim(),
    brief: draft.brief.trim(),
    kind: 'art',
    reviewPage: draft.reviewPage,
  };
}

export interface RedoArtDialogProps {
  page: ReviewPage;
  briefs?: UnpostedBrief[];
  // Feedback 11 round 2 (F1): the board's own quests. POST /api/quests upserts an existing package
  // nobody holds, so a typed id that is already on the board would silently rewrite that quest —
  // the dialog refuses those ids instead. Optional so older callers and tests keep working.
  existingQuests?: Quest[];
  projectId?: string;
  onClose: () => void;
  onPosted: (questId: string) => void;
}

export function RedoArtDialog({
  page,
  briefs,
  existingQuests,
  projectId,
  onClose,
  onPosted,
}: RedoArtDialogProps) {
  const t = useT();
  const [selectedBrief, setSelectedBrief] = useState<UnpostedBrief | null>(null);
  const [customBrief, setCustomBrief] = useState('');
  const [packageId, setPackageId] = useState('');
  const [packageFromShelf, setPackageFromShelf] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<RedoFieldErrors>({});
  const [problem, setProblem] = useState('');
  const aliveRef = useRef(true);
  const projectRef = useRef(projectId);
  const panelRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    projectRef.current = projectId;
  }, [projectId]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const pageId = page.page ?? '';
  const sourcePath = reviewSourcePath(page.url);
  const effectiveBrief =
    customBrief.trim().length > 0 ? customBrief.trim() : selectedBrief ? selectedBrief.brief : '';
  const draft: RedoDraft = { packageId, brief: effectiveBrief, reviewPage: pageId };
  const existingQuest = findQuestByPackage(existingQuests, packageId);
  const existingRefusal = existingQuest ? describeExistingPackageRefusal(existingQuest) : '';
  const ready = isRedoDraftReady(draft) && !submitting && existingQuest === null;

  if (pageId.length === 0) return null;

  const pickBrief = (brief: UnpostedBrief) => {
    setSelectedBrief(brief);
    setPackageId(brief.package);
    setPackageFromShelf(true);
    setCustomBrief('');
    setFieldErrors({});
  };

  const changeCustomBrief = (value: string) => {
    setCustomBrief(value);
    setSelectedBrief(null);
    if (packageFromShelf) {
      setPackageId('');
      setPackageFromShelf(false);
    }
    setFieldErrors({});
  };

  const changePackage = (value: string) => {
    setPackageId(value);
    setPackageFromShelf(false);
    setFieldErrors({});
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!submitting) onClose();
    }
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !submitting) onClose();
  };

  const submit = async () => {
    if (!isRedoDraftReady(draft) || submitting || existingQuest) return;
    setSubmitting(true);
    setFieldErrors({});
    setProblem('');
    const projectAtSubmit = projectRef.current;
    const stillCurrent = () => aliveRef.current && projectRef.current === projectAtSubmit;
    try {
      const result = await api.postArtRedo(buildRedoRequest(draft));
      if (!stillCurrent()) return;
      const questId = result && result.quest ? result.quest.id : '';
      if (!questId) {
        setSubmitting(false);
        // The disabled confirm button drops focus to <body>; bring it back so Escape keeps working.
        panelRef.current?.focus();
        setProblem(t('redoDialog.missingQuestId'));
        return;
      }
      onPosted(questId);
    } catch (error) {
      if (!stillCurrent()) return;
      setSubmitting(false);
      // A failed submit re-enables the button but focus was on <body>; refocus the panel for Escape.
      panelRef.current?.focus();
      if (error instanceof ApiError) {
        // Feedback 11 round 2 (F2): field refusals and the top-level message both go through fixed
        // Chinese strings; the server's own text is never rendered.
        const mapped = describeRedoFieldErrors(error.fields);
        if (Object.keys(mapped).length > 0) {
          setFieldErrors(mapped);
          setProblem('');
        } else {
          setProblem(describeRedoProblem({ message: error.message, status: error.status }));
        }
      } else if (error instanceof TypeError) {
        setProblem(t('redoDialog.connectFailed'));
      } else {
        setProblem(t('redoDialog.submitFailed'));
      }
    }
  };

  // Feedback 11 round 2 (F3): only a click on the confirm button may post. The form's own submit event
  // (Enter inside a text field) is swallowed here; Enter/Space on the focused button still fires its click.
  const handleFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
  };

  const otherFieldErrors = (Object.entries(fieldErrors) as [RedoFieldName, string][]).filter(
    ([key]) => key !== 'package' && key !== 'brief' && key !== 'reviewPage',
  );

  return (
    <div
      className="redo-overlay"
      role="presentation"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <form
        className="redo-dialog"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="redo-title"
        onSubmit={handleFormSubmit}
      >
        <div className="redo-head">
          <span className="redo-kicker">{t('redoDialog.kicker')}</span>
          <h3 className="redo-title" id="redo-title">
            {t('redoDialog.title')}
          </h3>
        </div>

        <div className="redo-target">
          <div className="redo-row">
            <span className="redo-label">{t('redoDialog.pageId')}</span>
            <span className="redo-value">{pageId}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">{t('redoDialog.pageTitle')}</span>
            <span className="redo-value">{page.title}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">{t('redoDialog.pageUrl')}</span>
            <span className="redo-value redo-path">{page.url}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">{t('redoDialog.annotationStats')}</span>
            <span className="redo-value">
              {t('redoDialog.annotationCount', { total: page.total, answered: page.answered })}
            </span>
          </div>
          {sourcePath ? (
            <div className="redo-row">
              <span className="redo-label">{t('redoDialog.pageFile')}</span>
              <span className="redo-value redo-path">{t('redoDialog.pageFileValue', { path: sourcePath })}</span>
            </div>
          ) : null}
          {fieldErrors.reviewPage ? <p className="redo-field-error">{fieldErrors.reviewPage}</p> : null}
        </div>

        <div className="redo-section">
          <h4 className="redo-subtitle">{t('redoDialog.pickBrief')}</h4>
          {briefs && briefs.length > 0 ? (
            <div className="redo-brief-list" role="radiogroup" aria-label={t('redoDialog.noBriefsListed')}>
              {briefs.map((brief) => {
                const picked =
                  selectedBrief !== null &&
                  selectedBrief.brief === brief.brief &&
                  selectedBrief.package === brief.package;
                return (
                  <label
                    key={`${brief.package}-${brief.brief}`}
                    className={picked ? 'redo-brief-option is-picked' : 'redo-brief-option'}
                  >
                    <input
                      className="redo-brief-radio"
                      type="radio"
                      name="redo-brief"
                      value={brief.brief}
                      checked={picked}
                      onChange={() => pickBrief(brief)}
                    />
                    <span className="redo-brief-text">
                      <span className="redo-brief-package">{brief.package}</span>
                      <span className="redo-brief-title">{brief.title}</span>
                      <span className="redo-brief-path redo-path">{brief.brief}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="redo-note">
              {briefs
                ? t('redoDialog.noBriefsWithList')
                : t('redoDialog.noBriefsNoList')}
            </p>
          )}
          <label className="redo-field">
            <span className="redo-label">{t('redoDialog.customBriefLabel')}</span>
            <input
              className="redo-input redo-path"
              type="text"
              value={customBrief}
              placeholder={t('redoDialog.customBriefPlaceholder')}
              onChange={(event) => changeCustomBrief(event.target.value)}
            />
          </label>
          {fieldErrors.brief ? <p className="redo-field-error">{fieldErrors.brief}</p> : null}
        </div>

        <label className="redo-field">
          <span className="redo-label">{t('redoDialog.packageLabel')}</span>
          <input
            className="redo-input"
            type="text"
            value={packageId}
            placeholder={t('redoDialog.packagePlaceholder')}
            onChange={(event) => changePackage(event.target.value)}
          />
        </label>
        {fieldErrors.package ? <p className="redo-field-error">{fieldErrors.package}</p> : null}
        {existingRefusal ? <p className="redo-field-error">{existingRefusal}</p> : null}

        <div className="redo-preview">
          <h4 className="redo-subtitle">{t('redoDialog.previewTitle')}</h4>
          <div className="redo-row">
            <span className="redo-label">{t('redoDialog.packageLabel')}</span>
            <span className="redo-value">{packageId.trim() || t('redoDialog.notFilled')}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">{t('redo.field.brief')}</span>
            <span className="redo-value redo-path">{effectiveBrief || t('redoDialog.notSelected')}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">{t('redo.field.kind')}</span>
            <span className="redo-value">{t('redoDialog.kindValue')}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">{t('redoDialog.correspondingPage')}</span>
            <span className="redo-value">{pageId}</span>
          </div>
          {otherFieldErrors.length > 0 ? (
            <p className="redo-field-error">
              {otherFieldErrors.map(([key, value]) => t('redoDialog.otherErrorItem', { label: REDO_FIELD_LABELS[key], value })).join(t('common.statementSeparator'))}
            </p>
          ) : null}
        </div>

        {problem ? (
          <p className="redo-problem" role="alert">
            {problem}
          </p>
        ) : null}

        <div className="redo-actions">
          <button className="redo-cancel" type="button" onClick={onClose} disabled={submitting}>
            {t('redoDialog.cancel')}
          </button>
          <button className="redo-confirm" type="button" onClick={submit} disabled={!ready}>
            {submitting ? t('redoDialog.submitting') : t('redoDialog.confirm')}
          </button>
        </div>
      </form>
    </div>
  );
}
