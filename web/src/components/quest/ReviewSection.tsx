import { useState } from 'react';
import { api } from '../../api/client';
import type { AcceptanceEvidenceRef, Quest, Snapshot } from '../../api/types';
import { boardAcceptanceDetail, RAW_TAIL_LABEL, REPORT_SOURCE_LABEL, reviewVerdictOf, verdictLabel, VERDICT_LABEL } from '../../lib/evidence';
import { acceptanceBy, STATUS } from '../../lib/labels';
import { isArchived, reviewsOf } from '../../lib/questState';
import { formatClock } from '../../lib/board';
import { useT } from '../../lib/i18n';
import { AcceptancePanel } from './AcceptancePanel';
import { DrawerSection } from './DrawerSection';
import '../../styles/report-evidence.css';

// Item 12: the badge used to read a verdict only out of the reviewer's `lastDetail` tail with a web-only
// regex — wrong whenever that tail was truncated or the wording did not match. When the backend has already
// bound and verified this review's own final report (src/core/reportEvidence.js — the exact final `VERDICT:`
// line from the full read, never a truncated read or a `.out` transcript), that verdict is shown instead;
// the lastDetail-derived badge is kept only as an explicitly labelled fallback for a review with no captured
// report (legacy data, or one not yet terminal). Either way this is a display only — it never enables or
// triggers the accept/reject controls below.
function ReviewVerdictLine({ review }: { review: Quest }) {
  const t = useT();
  const info = reviewVerdictOf(review);
  const report = review.report;
  if (info.verified && report) {
    return (
      <span className={`review-verdict review-verdict-${info.verdict}`}>
        {t('reviewSection.verdictPrefix')}{verdictLabel(info)}
        {info.verdict === 'unknown' && info.reason ? t('reviewSection.verdictReason', { reason: info.reason }) : ''}
        <span className="review-report-verdict-meta">
          {t('reviewSection.recordedAt', { source: REPORT_SOURCE_LABEL[report.source], time: formatClock(report.capturedAt) })}
        </span>
      </span>
    );
  }
  return (
    <span className={`review-verdict review-verdict-${info.verdict} review-verdict-fallback`}>
      {t('reviewSection.fallbackVerdict', { verdict: VERDICT_LABEL[info.verdict] })}
      <span className="review-report-verdict-meta">{t('reviewSection.fallbackNote')}</span>
    </span>
  );
}

interface ReviewSectionProps {
  quest: Quest;
  snap: Snapshot;
  draft: string;
  onDraftChange: (text: string) => void;
  onSelectQuest: (questId: string) => void;
  onAssignCard: (questId: string, cardId: string) => void;
  refresh: () => void;
  pushToast: (message: string) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const REPORTED = new Set<Quest['status']>(['delivered', 'reviewing']);

// The controls for closing out returned work: accept, send back with a reason, or send a model to review it
// first (drag its card onto the quest, or pick one below — both open the same order). Code and tool work is
// the coordinator's to verify — but a board click is recorded as by=owner (src/server/questRoutes.js), so
// the accept note names the owner, never an assumed coordinator. Who *should* verify stays in the hints and
// column labels: expectation is not evidence. This is labelling, not access control — a local board has no
// login to fake.
export function ReviewSection({ quest, snap, draft, onDraftChange, onSelectQuest, onAssignCard, refresh, pushToast }: ReviewSectionProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // Feedback 15: the evidence AcceptancePanel's checkboxes currently name — read into the acceptance record
  // sent on accept, never on 退回 (a rejection carries no acceptance).
  const [evidenceRefs, setEvidenceRefs] = useState<AcceptanceEvidenceRef[]>([]);
  const [needsCoordinator, setNeedsCoordinator] = useState(false);
  const technical = acceptanceBy(quest.kind) === 'coordinator';
  const reviews = reviewsOf(snap, quest.id);
  const openReview = reviews.find((review) => !isArchived(review));
  const reviewers = openReview ? [] : snap.roster.filter((card) => snap.reviewEligibility?.[quest.id]?.[card.id]?.ok);

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      pushToast(t('common.actionFailed', { action: failure, error: errorText(err) }));
    } finally {
      setBusy(false);
    }
  };

  // A decision on the work ends this round's reviews too, or they sit in 待验收 forever. A running review is
  // left alone. The report stays as the detail so its verdict remains readable afterwards.
  const closeReviews = async () => {
    for (const review of reviews) {
      if (isArchived(review) || review.status === 'dispatched') continue;
      await api.setQuestStatus(review.id, 'done', review.lastDetail ?? '');
    }
  };

  const accept = () => {
    if (!window.confirm(t('reviewSection.confirmAccept', { id: quest.id }))) return;
    void run(async () => {
      const note = draft.trim();
      if (note) await api.rule(quest.id, `验收：${note}`);
      // Feedback 15: an additive acceptance record alongside the existing owner-验收 detail text — actor is
      // always 'owner' here, since a board click can never claim coordinator (src/core/acceptance.js).
      await api.setQuestStatus(quest.id, 'done', boardAcceptanceDetail(note), false, { actor: 'owner', evidenceRefs, ...(note ? { note } : {}) });
      await closeReviews();
      onDraftChange('');
      pushToast(
        technical
          ? t('reviewSection.acceptedTechnical', { id: quest.id })
          : t('reviewSection.acceptedOwner', { id: quest.id }),
      );
      refresh();
    }, t('reviewSection.acceptFailed'));
  };

  const sendBack = () => {
    const reason = draft.trim();
    if (!reason) {
      pushToast(t('reviewSection.sendBackReasonRequired'));
      return;
    }
    if (!window.confirm(t('reviewSection.confirmSendBack', { id: quest.id }))) return;
    void run(async () => {
      // FB2-02 item 2: one decision route — the server reads the review page's annotations and parks the
      // quest in needs_coordinator when a note names the coordinator or the owner ticked the box.
      const result = await api.sendBack(quest.id, reason, needsCoordinator);
      await closeReviews();
      onDraftChange('');
      setNeedsCoordinator(false);
      pushToast(
        result.routed === 'needs_coordinator'
          ? t('reviewSection.routedCoordinator', { id: quest.id })
          : t('reviewSection.sentBack', { id: quest.id }),
      );
      refresh();
    }, t('reviewSection.sendBackFailed'));
  };

  // FB2-02 item 4: 交给 coordinator 重写简报 — a question thread naming the card, nothing else moves.
  const handToCoordinator = () => {
    void run(async () => {
      await api.handToCoordinator(quest.id, draft.trim());
      onDraftChange('');
      pushToast(t('reviewSection.handedToCoordinator', { id: quest.id }));
      refresh();
    }, t('reviewSection.handFailed'));
  };

  return (
    <DrawerSection en={technical ? 'TECHNICAL REVIEW' : 'SIGN-OFF'} zh={technical ? t('reviewSection.technicalTitle') : t('reviewSection.signOffTitle')}>
      <p className="hint owner-task-hint">
        {technical
          ? t('reviewSection.technicalHint')
          : t('reviewSection.signOffHint')}
      </p>
      {reviews.length > 0 ? (
        <div className="review-links">
          {reviews.map((review) => {
            const reported = REPORTED.has(review.status) || isArchived(review);
            return (
              <div key={review.id} className="review-link">
                <div className="review-link-main">
                  <strong>{review.id}</strong>
                  <span className="review-link-status">{STATUS[review.status] ?? review.status}</span>
                  {reported ? <ReviewVerdictLine review={review} /> : null}
                  {/* N1/item 2 & 6: a raw lastDetail tail — possibly an echoed review template, possibly cut
                      mid-word — must never sit next to a verdict (verified or guessed) unlabelled, or it
                      reads as if it were evidence for that verdict. Always labelled, with the same wording
                      QuestReceipt's own tail block uses, so this can never drift into "labelled sometimes". */}
                  {reported && review.lastDetail ? (
                    <>
                      <div className="review-link-none">{RAW_TAIL_LABEL()}</div>
                      <pre className="review-link-detail">{review.lastDetail}</pre>
                    </>
                  ) : (
                    <div className="review-link-none">{reported ? t('reviewSection.noReport') : t('reviewSection.noVerdict')}</div>
                  )}
                </div>
                <button className="btn" type="button" onClick={() => onSelectQuest(review.id)}>
                  {t('reviewSection.open')}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {openReview ? null : (
        <details className="assign-details">
          <summary>
            {reviewers.length > 0 ? t('reviewSection.pickReviewer', { count: reviewers.length }) : t('reviewSection.noReviewer')}
          </summary>
          {reviewers.map((card) => (
            <div key={card.id} className="pick ok">
              <div>
                <strong>{card.name}</strong>
                <span className="a-model">{t('reviewSection.modelLabel', { model: card.model, lane: card.lane })}</span>
              </div>
              <button className="btn" type="button" onClick={() => onAssignCard(quest.id, card.id)}>
                {t('reviewSection.sendToReview')}
              </button>
            </div>
          ))}
        </details>
      )}
      <AcceptancePanel quest={quest} onChange={setEvidenceRefs} />
      <textarea
        rows={3}
        placeholder={t('reviewSection.draftPlaceholder')}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      {/* .check-line (board.css) sizes the box itself: without it the app-wide input rule stretched this
          checkbox across the whole row (measured 448px wide) and pushed its caption to the far right. The
          6px gap stays inline because .row's own gap would otherwise win over .check-line's. */}
      <label className="row check-line" style={{ gap: 6 }}>
        <input
          type="checkbox"
          checked={needsCoordinator}
          onChange={(e) => setNeedsCoordinator(e.target.checked)}
        />
        <span>{t('reviewSection.needsCoordinator')}</span>
      </label>
      <div className="row end">
        <button className="btn" type="button" disabled={busy} onClick={handToCoordinator}>
          {t('reviewSection.handToCoordinator')}
        </button>
        <button className="btn danger" type="button" disabled={busy} onClick={sendBack}>
          {t('reviewSection.sendBack')}
        </button>
        <button className="btn primary" type="button" disabled={busy} onClick={accept}>
          {t('reviewSection.accept')}
        </button>
      </div>
    </DrawerSection>
  );
}
