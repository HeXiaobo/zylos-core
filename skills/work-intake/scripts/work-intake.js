import {
  validateInboundEnvelope,
  workIntakeSourceKey,
} from './inbound-envelope.js';

const EXPLICIT_TASK_PREFIX = /^(?:\/zylos-task\s+create\b|任务\s*[：:]|待办\s*[：:]|创建任务\s*[：:]?|新建任务\s*[：:]?)/iu;
const YUERAN_ASSIGNMENT = /(?:交给|让|请|麻烦|安排)\s*@?玥然|@?玥然\s*(?:来|负责|处理|完成|跟进|整理|帮)/u;
const DURABLE_ACTION = /(?:整理|跟进|准备|完成|制作|更新|复盘|提交|联系|回访|安排|检查|核对|推进|撰写|汇总|发送|发布|删除|付款|转账|审批|部署|创建|修复|实现|测试|调查|监控|提醒|预约|对账|归档)/u;
const HIGH_RISK_ACTION = /(?:付款|转账|打款|退款|报销|签署|签约|盖章|删除|清空|注销|发布|群发|发送邮件|发邮件|发消息|联系客户|提交审批|审批通过|拒绝审批|部署到生产|上线生产|修改权限|开放权限|授权|移除成员|邀请外部|下单|购买|卖出|买入)/u;
const VAGUE_TIME = /(?:尽快|抓紧|有空(?:时)?|回头|晚点|稍后|抽空|这两天|过几天|改天|近期|下周找时间|月底左右|差不多|合适的时候)/u;
const DUE_TEXT = /(?:今天|明天|后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|(?:20\d{2}[年\-/])?\d{1,2}[月\-/]\d{1,2}日?)(?:\s*(?:上午|中午|下午|晚上|凌晨)?\s*\d{1,2}(?::|点)\d{0,2}分?)?(?:之前|以前|前|截止)?/u;
const QUESTION = /(?:[?？]\s*$|^(?:什么|为什么|怎么|如何|是否|能否|可以|有没有|哪里|谁|几点|多少|请问|我想(?:知道|了解)|想问(?:一下)?|能告诉我|可否告诉我))/u;
const ONE_SHOT_REQUEST = /(?:告诉我|解释一下|查一下|查询一下|搜一下|翻译一下|总结这段|看看这张|分析一下|回答一下|推荐一下|计算一下|改写一下|润色一下|生成一段|现在几点|天气怎么样)/u;
const AMBIGUOUS_REQUEST = /(?:看看(?:这个|这件事|这个事|一下)?|跟一下(?:这个|这件事|这个事)?|处理一下(?:这个|这件事|这个事)?|弄一下|关注一下|推进一下|安排一下|记一下|搞一下|留意一下|盯一下)/u;
const HUMAN_ASSIGNMENT = /(?:交给|让|请|安排)\s*@?([\p{L}\p{N}_-]{1,20}?)\s*(?:来|负责|处理|完成|跟进|整理|推进)/u;

function extractDueText(text) {
  return text.match(DUE_TEXT)?.[0]?.replace(/\s+/g, '') ?? null;
}

function personResolution(envelope) {
  if (YUERAN_ASSIGNMENT.test(envelope.text)) {
    return { explicit: true, assigneeId: null, ambiguous: false };
  }
  const namedPeople = envelope.people.filter((person) => (
    new RegExp(`(?:交给|让|请|安排)\\s*@?${person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(envelope.text)
  ));
  if (namedPeople.length > 0) {
    const candidateIds = [...new Set(namedPeople.flatMap((person) => (
      person.id ? [person.id] : person.candidateIds
    )))];
    return {
      explicit: true,
      assigneeId: candidateIds.length === 1 ? candidateIds[0] : null,
      ambiguous: candidateIds.length !== 1,
    };
  }
  const match = envelope.text.match(HUMAN_ASSIGNMENT);
  if (!match) return { explicit: false, assigneeId: null, ambiguous: false };
  const name = match[1].replace(/^@/u, '');
  if (['玥然', '你', '我', '我们', '大家'].includes(name)) {
    return { explicit: name === '玥然', assigneeId: null, ambiguous: false };
  }
  const matches = envelope.people.filter((person) => person.name === name);
  const candidateIds = [...new Set(matches.flatMap((person) => (
    person.id ? [person.id] : person.candidateIds
  )))];
  return {
    explicit: true,
    assigneeId: candidateIds.length === 1 ? candidateIds[0] : null,
    ambiguous: candidateIds.length !== 1,
  };
}

function taskTitle(text, dueText) {
  let title = text
    .replace(EXPLICIT_TASK_PREFIX, '')
    .replace(/^(?:请|麻烦|帮我|请帮我|麻烦帮我)\s*/u, '')
    .replace(/^(?:交给|让|安排)\s*@?玥然\s*(?:来|负责|处理|完成)?\s*/u, '')
    .replace(/^@?玥然\s*(?:来|负责|处理|完成|帮我)?\s*/u, '')
    .trim();
  if (dueText) title = title.replace(dueText, '').replace(/^在\s*/u, '').trim();
  title = title.replace(/^[，,。；;：:\s]+|[。；;\s]+$/gu, '').trim();
  if (title.length < 2) title = text.trim();
  return Array.from(title).slice(0, 200).join('');
}

function buildTaskDraft(envelope, { riskLevel = 'normal', assigneeId = null } = {}) {
  const dueText = extractDueText(envelope.text);
  const title = taskTitle(envelope.text, dueText);
  const details = [];
  if (dueText) details.push(`期限：${dueText}`);
  if (title !== envelope.text) details.push(`原始交办：${envelope.text}`);
  return {
    title,
    description: details.length > 0 ? details.join('\n') : null,
    ownerId: envelope.sender.id,
    acceptorId: envelope.sender.id,
    assigneeId,
    dueText,
    riskLevel,
  };
}

function result(envelope, decision, reasonCode, taskDraft = null) {
  return Object.freeze({
    decision,
    reasonCode,
    intentRevision: envelope.intentRevision,
    sourceKey: workIntakeSourceKey(envelope),
    taskDraft: taskDraft ? Object.freeze(taskDraft) : null,
  });
}

/**
 * Channel-neutral WorkIntake Interface.
 *
 * This function is deliberately side-effect free. It never opens Commitment
 * Core, a database, a platform client, or a model session. A caller may replace
 * the internal implementation later, but every implementation must return one
 * of these three decisions through this same seam.
 */
export function classify(input) {
  const envelope = validateInboundEnvelope(input);
  const explicitTask = EXPLICIT_TASK_PREFIX.test(envelope.text);
  const yueranAssigned = YUERAN_ASSIGNMENT.test(envelope.text);
  const people = personResolution(envelope);
  const assigneeId = yueranAssigned ? 'agent:yueran' : people.assigneeId;

  // Questions and bounded one-shot help describe information needs, not an
  // instruction to perform the risky verb they happen to mention. An explicit
  // task prefix remains authoritative and still crosses the risk gate below.
  if (!explicitTask && (QUESTION.test(envelope.text) || ONE_SHOT_REQUEST.test(envelope.text))) {
    return result(envelope, 'chat_only', QUESTION.test(envelope.text)
      ? 'QUESTION_OR_INFORMATION_REQUEST'
      : 'ONE_SHOT_REQUEST');
  }

  if (HIGH_RISK_ACTION.test(envelope.text)) {
    return result(
      envelope,
      'confirm',
      'HIGH_RISK_EXTERNAL_ACTION',
      buildTaskDraft(envelope, { riskLevel: 'high', assigneeId }),
    );
  }

  if (people.ambiguous) {
    return result(
      envelope,
      'confirm',
      'PERSON_AMBIGUOUS',
      buildTaskDraft(envelope, { assigneeId: null }),
    );
  }

  if (VAGUE_TIME.test(envelope.text) && (explicitTask || yueranAssigned || DURABLE_ACTION.test(envelope.text))) {
    return result(
      envelope,
      'confirm',
      'TIME_AMBIGUOUS',
      buildTaskDraft(envelope, { assigneeId }),
    );
  }

  if (explicitTask) {
    return result(
      envelope,
      'create_task',
      'EXPLICIT_TASK_PREFIX',
      buildTaskDraft(envelope, { assigneeId }),
    );
  }

  const hasDue = DUE_TEXT.test(envelope.text);
  const durableAction = DURABLE_ACTION.test(envelope.text);
  if (yueranAssigned && durableAction && !ONE_SHOT_REQUEST.test(envelope.text)) {
    return result(
      envelope,
      'create_task',
      'EXPLICIT_ASSIGNMENT',
      buildTaskDraft(envelope, { assigneeId: 'agent:yueran' }),
    );
  }

  if (people.explicit && people.assigneeId && durableAction && !ONE_SHOT_REQUEST.test(envelope.text)) {
    return result(
      envelope,
      'create_task',
      'EXPLICIT_HUMAN_ASSIGNMENT',
      buildTaskDraft(envelope, { assigneeId: people.assigneeId }),
    );
  }

  if (hasDue && durableAction && !QUESTION.test(envelope.text)) {
    return result(
      envelope,
      'create_task',
      'ACTION_WITH_DEADLINE',
      buildTaskDraft(envelope, { assigneeId }),
    );
  }

  if (QUESTION.test(envelope.text)) {
    return result(envelope, 'chat_only', 'QUESTION_OR_INFORMATION_REQUEST');
  }
  if (ONE_SHOT_REQUEST.test(envelope.text)) {
    return result(envelope, 'chat_only', 'ONE_SHOT_REQUEST');
  }

  if (AMBIGUOUS_REQUEST.test(envelope.text)) {
    return result(
      envelope,
      'confirm',
      'INSUFFICIENT_TASK_DETAIL',
      buildTaskDraft(envelope, { assigneeId }),
    );
  }

  return result(envelope, 'chat_only', 'NO_TASK_COMMITMENT');
}
