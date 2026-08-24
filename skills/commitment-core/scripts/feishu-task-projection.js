import { ProjectionAdapterError } from './projection-worker.js';

const PROJECTION = 'feishu';
const FEISHU_OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const TARGET_ID_TYPES = new Set(['open_id', 'chat_id']);
const PERMANENT_LINK_ERRORS = new Set([
  'EXTERNAL_LINK_CONFLICT',
  'FORBIDDEN',
  'IDEMPOTENCY_CONFLICT',
  'TASK_NOT_FOUND',
]);

function requireFunction(value, field) {
  if (typeof value !== 'function') throw new TypeError(`${field} must be a function`);
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectionAdapterError(`${field} must be a non-empty string`, { retryable: false });
  }
  return value.trim();
}

function requireDeliveries(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('deliveries must be a non-empty array');
  }
  for (const [index, delivery] of value.entries()) {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      throw new TypeError(`deliveries[${index}] must be an object`);
    }
    if (delivery.projection !== PROJECTION) {
      throw new TypeError(`deliveries[${index}].projection must be ${PROJECTION}`);
    }
  }
  return value;
}

function requireTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectionAdapterError('Feishu target is not configured', { retryable: false });
  }
  const receiveIdType = requireText(value.receiveIdType, 'target.receiveIdType');
  if (!TARGET_ID_TYPES.has(receiveIdType)) {
    throw new ProjectionAdapterError(
      'target.receiveIdType must be open_id or chat_id',
      { retryable: false },
    );
  }
  return Object.freeze({
    receiveId: requireText(value.receiveId, 'target.receiveId'),
    receiveIdType,
  });
}

async function callPublisher(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProjectionAdapterError) throw error;
    if (error?.retryable === false) {
      throw new ProjectionAdapterError(error.message || 'Feishu publisher rejected operation', {
        retryable: false,
        cause: error,
      });
    }
    throw error;
  }
}

function resolveAcceptorDmTarget({ task }) {
  if (!FEISHU_OPEN_ID_PATTERN.test(task?.acceptorId ?? '')) return null;
  return { receiveId: task.acceptorId, receiveIdType: 'open_id' };
}

/**
 * Core-to-Feishu projection Module.
 *
 * Its public Interface is the generic projection Adapter's single
 * `publishBatch({ deliveries })` operation. Current Task snapshot reads,
 * target resolution, create/update choice, stable remote idempotency, and
 * durable ExternalLink ownership stay inside this Module.
 */
export function createFeishuTaskProjectionAdapter({
  core,
  publisher,
  resolveTarget = resolveAcceptorDmTarget,
} = {}) {
  if (!core || typeof core.query !== 'function'
      || typeof core.externalLinks?.query !== 'function'
      || typeof core.externalLinks?.link !== 'function') {
    throw new TypeError('core must provide query and externalLinks Interfaces');
  }
  if (!publisher || typeof publisher !== 'object' || Array.isArray(publisher)) {
    throw new TypeError('publisher must be an object');
  }
  requireFunction(publisher.createTask, 'publisher.createTask');
  requireFunction(publisher.updateTask, 'publisher.updateTask');
  requireFunction(resolveTarget, 'resolveTarget');

  async function publishOne(delivery) {
    const taskId = requireText(delivery.event?.taskId, 'delivery.event.taskId');
    const task = core.query({ taskId });
    if (!task) {
      throw new ProjectionAdapterError(`Core task not found: ${taskId}`, { retryable: false });
    }
    const target = requireTarget(await resolveTarget({ task }));
    const links = core.externalLinks.query({ taskId, backend: PROJECTION });
    if (links.length > 1) {
      throw new ProjectionAdapterError(`multiple Feishu links found for ${taskId}`, {
        retryable: false,
      });
    }

    if (links.length === 1) {
      await callPublisher(() => publisher.updateTask({
        target,
        externalId: links[0].externalId,
        task,
        idempotencyKey: `zylos:feishu:update:${taskId}:v${task.version}`,
      }));
      return;
    }

    const created = await callPublisher(() => publisher.createTask({
      target,
      task,
      idempotencyKey: `zylos:feishu:create:${taskId}`,
    }));
    const externalId = requireText(created?.externalId, 'publisher.createTask externalId');
    try {
      core.externalLinks.link({
        taskId,
        actorId: task.ownerId,
        backend: PROJECTION,
        externalId,
        idempotencyKey: `zylos:feishu:link:${taskId}:${externalId}`,
      });
    } catch (error) {
      if (error instanceof TypeError || PERMANENT_LINK_ERRORS.has(error?.code)) {
        const code = error?.code ? `${error.code}: ` : '';
        throw new ProjectionAdapterError(
          `ExternalLink rejected Feishu identity for ${taskId}: ${code}${error.message}`,
          { retryable: false, cause: error },
        );
      }
      throw error;
    }
  }

  return Object.freeze({
    async publishBatch({ deliveries } = {}) {
      for (const delivery of requireDeliveries(deliveries)) {
        await publishOne(delivery);
      }
    },
  });
}
