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
    return { persisted, routeDecision: null, replayed: true };
  }
  const routeDecision = await route();
  return { persisted, routeDecision, replayed: false };
}
