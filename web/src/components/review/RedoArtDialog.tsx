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
        setProblem('服务器返回的数据不完整（缺少委托编号）。');
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
        setProblem('无法连接看板服务，请确认服务仍在运行后再试。');
      } else {
        setProblem('提交失败，请稍后再试。');
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
          <span className="redo-kicker">评审目录</span>
          <h3 className="redo-title" id="redo-title">
            发起重做委托
          </h3>
        </div>

        <div className="redo-target">
          <div className="redo-row">
            <span className="redo-label">页面编号</span>
            <span className="redo-value">{pageId}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">页面标题</span>
            <span className="redo-value">{page.title}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">页面地址</span>
            <span className="redo-value redo-path">{page.url}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">批注统计</span>
            <span className="redo-value">
              共 {page.total} 处，已批注 {page.answered} 处
            </span>
          </div>
          {sourcePath ? (
            <div className="redo-row">
              <span className="redo-label">绑定来源</span>
              <span className="redo-value redo-path">评审目录/{sourcePath}</span>
            </div>
          ) : null}
          {fieldErrors.reviewPage ? <p className="redo-field-error">{fieldErrors.reviewPage}</p> : null}
        </div>

        <div className="redo-section">
          <h4 className="redo-subtitle">选择重做简报</h4>
          {briefs && briefs.length > 0 ? (
            <div className="redo-brief-list" role="radiogroup" aria-label="未发布的简报">
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
                ? '当前没有未发布的简报，请直接输入简报路径。'
                : '当前看板没有提供未发布简报列表（可能是旧版本），请直接输入简报路径。'}
            </p>
          )}
          <label className="redo-field">
            <span className="redo-label">或输入简报路径</span>
            <input
              className="redo-input redo-path"
              type="text"
              value={customBrief}
              placeholder="例如 docs/briefs/art-redo.md"
              onChange={(event) => changeCustomBrief(event.target.value)}
            />
          </label>
          {fieldErrors.brief ? <p className="redo-field-error">{fieldErrors.brief}</p> : null}
        </div>

        <label className="redo-field">
          <span className="redo-label">委托包编号</span>
          <input
            className="redo-input"
            type="text"
            value={packageId}
            placeholder="例如 ART-REDO-1"
            onChange={(event) => changePackage(event.target.value)}
          />
        </label>
        {fieldErrors.package ? <p className="redo-field-error">{fieldErrors.package}</p> : null}
        {existingRefusal ? <p className="redo-field-error">{existingRefusal}</p> : null}

        <div className="redo-preview">
          <h4 className="redo-subtitle">将要提交的内容</h4>
          <div className="redo-row">
            <span className="redo-label">委托包</span>
            <span className="redo-value">{packageId.trim() || '未填写'}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">简报路径</span>
            <span className="redo-value redo-path">{effectiveBrief || '未选择'}</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">类型</span>
            <span className="redo-value">美术（art）</span>
          </div>
          <div className="redo-row">
            <span className="redo-label">绑定评审页</span>
            <span className="redo-value">{pageId}</span>
          </div>
          {otherFieldErrors.length > 0 ? (
            <p className="redo-field-error">
              {otherFieldErrors.map(([key, value]) => `${REDO_FIELD_LABELS[key]}：${value}`).join('；')}
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
            取消
          </button>
          <button className="redo-confirm" type="button" onClick={submit} disabled={!ready}>
            {submitting ? '正在提交…' : '确认发起重做'}
          </button>
        </div>
      </form>
    </div>
  );
}
