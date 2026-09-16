// Shared cancellation and manual-resolution vocabulary.  These values are deliberately small and
// non-secret: a request may be replayed in the board, while the control token remains process-local.
export const CANCELLATION_SOURCES = new Set(['ui', 'cli', 'mcp']);
export const CANCELLATION_RESULTS = new Set(['pending', 'never_started', 'stopped_by_wrapper', 'manual_required', 'unknown']);

export function cancellationSource(value) {
  const source = String(value || '').trim();
  return CANCELLATION_SOURCES.has(source) ? source : null;
}

export function cancellationReason(value) {
  const reason = String(value || '').trim().slice(0, 2000);
  return reason || null;
}

// Manual resolution is also reachable from an unlabelled legacy HTTP caller. That caller is
// intentionally not promoted to a trusted role: it is recorded as `unknown` and still has to
// provide the same acknowledgement and reason as every other manual free.
export function resolutionSource(value) {
  return cancellationSource(value) || 'unknown';
}

export function attemptEvidence(assignee) {
  if (!assignee) return null;
  return {
    attemptId: assignee.attemptId || null,
    name: assignee.name || null,
    lane: assignee.lane || null,
    at: assignee.at || null,
  };
}

export function cancellationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function manualResolution(source, assignee, reason, scope = 'manual') {
  return {
    actorSource: resolutionSource(source),
    attempt: attemptEvidence(assignee),
    time: new Date().toISOString(),
    reason: cancellationReason(reason),
    scope,
  };
}
