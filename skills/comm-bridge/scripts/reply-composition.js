import { createContextAssembler } from './context-assembler.js';
import { openEventSubscriptions } from './event-subscription.js';
import { openReplyIntentOutbox } from './reply-intent-outbox.js';
import { openReplyOutcomeTransactions } from './reply-outcome.js';
import { openRunLedger } from './run-ledger.js';

export const REPLY_REFACTOR_FLAG = 'C4_REPLY_REFACTOR_V1';

/**
 * The C4 cutover seam.  It deliberately owns orchestration only: the durable
 * modules remain their respective owners of acceptance, context, task effects,
 * outcomes, delivery and event fan-out.
 */
export function replyRefactorEnabled(env = process.env) {
  const value = String(env?.[REPLY_REFACTOR_FLAG] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'enabled';
}

export function requireIdleForRequest({ requestClass = 'ordinary', requireIdle } = {}) {
  if (requestClass === 'ordinary') return false;
  if (requestClass !== 'maintenance' && requestClass !== 'control') {
    throw new TypeError('requestClass must be ordinary, maintenance, or control');
  }
  return requireIdle ?? true;
}

export function createReplyComposition({
  dbPath,
  enabled = replyRefactorEnabled(),
  legacy,
  ledger = null,
  contextAssembler = null,
  taskApplication = null,
  outcomes = null,
  outbox = null,
  subscriptions = null,
  context = null,
  clock,
} = {}) {
  if (!enabled) {
    if (!legacy || typeof legacy.accept !== 'function') {
      throw new TypeError('legacy.accept is required while the reply refactor is disabled');
    }
    return Object.freeze({
      enabled: false,
      accept(command) { return legacy.accept(command); },
      close() { legacy.close?.(); },
    });
  }
  if (!dbPath) throw new TypeError('dbPath is required while the reply refactor is enabled');
  const owned = {
    ledger: ledger || openRunLedger({ dbPath, ...(clock ? { clock } : {}) }),
    outcomes: outcomes || openReplyOutcomeTransactions({ dbPath, ...(clock ? { clock } : {}) }),
    outbox: outbox || openReplyIntentOutbox({ dbPath, ...(clock ? { clock } : {}) }),
    subscriptions: subscriptions || openEventSubscriptions({ dbPath, ...(clock ? { clock } : {}) }),
  };
  const assembler = contextAssembler || (context ? createContextAssembler(context) : null);

  return Object.freeze({
    enabled: true,
    accept(command) {
      const normalized = {
        ...command,
        policy: {
          ...command.policy,
          requireIdle: requireIdleForRequest({
            requestClass: command.requestClass,
            requireIdle: command.policy?.requireIdle,
          }),
        },
      };
      return owned.ledger.accept(normalized);
    },
    assembleContext(identity, options) {
      if (!assembler) throw new Error('ContextAssembler is not configured');
      return assembler.assemble(identity, options);
    },
    applyTaskIntent(...args) {
      if (!taskApplication || typeof taskApplication.acceptIntent !== 'function') {
        throw new Error('TaskCommand application is not configured');
      }
      return taskApplication.acceptIntent(...args);
    },
    commitOutcome(command) { return owned.outcomes.commitRunOutcome(command); },
    subscribe(command) { return owned.subscriptions.subscribe(command); },
    claimEvent(command) { return owned.subscriptions.claimNext(command); },
    ackEvent(command) { return owned.subscriptions.ack(command); },
    claimReply(command) { return owned.outbox.claimNext(command); },
    recordReplyReceipt(command) { return owned.outbox.recordReceipt(command); },
    close() {
      for (const module of Object.values(owned)) module.close?.();
    },
  });
}
