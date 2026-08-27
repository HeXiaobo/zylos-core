/**
 * Persist an explicit task intent before crossing the routing seam.
 *
 * A route timeout, crash, or exception is deliberately allowed to escape; the
 * durable conversation/intake pair has already committed and can be recovered.
 */
export async function persistTaskBeforeRoute({
  intake,
  conversation,
  envelope,
  route,
}) {
  const persisted = intake.recordInbound({ conversation, envelope });
  if (!persisted.created) {
    const status = persisted.intake.status;
    if (status === 'failed') {
      const error = new Error(
        `task intake previously failed and requires explicit operator retry: ${envelope.idempotencyKey}`,
      );
      error.code = 'TASK_INTAKE_FAILED';
      error.lastError = persisted.intake.lastError;
      throw error;
    }
    const replayAction = status === 'completed' ? 'replayed' : `already_${status}`;
    return {
      persisted,
      routeDecision: null,
      replayed: true,
      replayAction,
    };
  }
  const routeDecision = await route();
  return { persisted, routeDecision, replayed: false, replayAction: null };
}
