function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function isAgentIdentity(recipientId) {
  return typeof recipientId === 'string' && recipientId.startsWith('agent:');
}

const SUBSCRIBER_ROLES = new Set(['owner', 'acceptor', 'assignee', 'subscriber']);

function isTaskSubscriber(audienceMember) {
  return audienceMember.roles.some((role) => SUBSCRIBER_ROLES.has(role));
}

function commentSummary(command) {
  if (command.type === 'DeleteComment') return '一条任务评论已被删除';
  return command.body;
}

/**
 * Coordinate canonical comment persistence and human-audience notification.
 * Agent identities are deliberately excluded here: the runtime wake seam owns
 * immediate execution and its exact reply context, while this Module owns
 * subscriber and exact-human-reply notification policy.
 */
export function createTaskCommentCoordinator({ core, publishNotification }) {
  const canonical = requireRecord(core, 'Commitment Core');
  requireFunction(canonical.conversation?.record, 'core.conversation.record');
  requireFunction(canonical.conversation?.query, 'core.conversation.query');
  requireFunction(canonical.audience?.resolve, 'core.audience.resolve');
  requireFunction(canonical.notifications?.decide, 'core.notifications.decide');
  requireFunction(canonical.notifications?.query, 'core.notifications.query');
  const publish = requireFunction(publishNotification, 'publishNotification');

  return Object.freeze({
    async record(rawCommand) {
      const command = requireRecord(rawCommand, 'conversation command');
      const result = canonical.conversation.record(command);
      const persistedDecision = canonical.notifications.query({ eventId: result.event.id });
      if (persistedDecision) {
        if (persistedDecision.deliveries.length > 0) {
          await publish({ decision: persistedDecision, summary: commentSummary(command) });
        }
        return result;
      }
      let targetIds;
      if (isAgentIdentity(command.actorId) && command.replyToCommentId) {
        const parent = canonical.conversation.query({
          taskId: command.taskId,
          commentId: command.replyToCommentId,
        });
        targetIds = parent?.authorId && !isAgentIdentity(parent.authorId)
          ? [parent.authorId]
          : [];
      } else {
        targetIds = canonical.audience.resolve({ taskId: command.taskId })
          .filter(isTaskSubscriber)
          .map(({ recipientId }) => recipientId)
          .filter((recipientId) => !isAgentIdentity(recipientId));
      }
      if (targetIds.length === 0) return result;
      const decision = canonical.notifications.decide({
        taskId: command.taskId,
        eventId: result.event.id,
        kind: 'action_required',
        actorId: command.actorId,
        targetIds,
      });
      if (decision.deliveries.length > 0) {
        await publish({ decision, summary: commentSummary(command) });
      }
      return result;
    },
  });
}
