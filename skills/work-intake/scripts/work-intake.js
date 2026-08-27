import {
  validateInboundEnvelope,
  workIntakeSourceKey,
} from './inbound-envelope.js';

const EXPLICIT_TASK_PREFIX = /^(?:\/zylos-task\s+create\b|(?:(?:请|麻烦|帮我|请帮我|麻烦帮我)\s*)?(?:任务\s*[：:]|待办\s*[：:]|创建任务\s*[：:]?|新建任务\s*[：:]?))/iu;
const AGENT_ID = /^agent:[a-z0-9][a-z0-9._-]{0,62}$/;
const DURABLE_ACTION = /(?:整理|跟进|准备|完成|制作|更新|复盘|提交|联系|回访|安排|检查|核对|推进|撰写|汇总|发送|发布|删除|付款|转账|审批|部署|创建|修复|实现|测试|调查|监控|提醒|预约|对账|归档)/u;
const HIGH_RISK_ACTION = /(?:付款|转账|打款|退款|报销|签署|签约|盖章|删除|清空|注销|发布(?!人)|群发|发送邮件|发邮件|发消息|联系客户|提交审批|审批通过|拒绝审批|部署到生产|上线生产|修改权限|开放权限|授权|移除成员|邀请外部|下单|购买|卖出|买入)/u;
const VAGUE_TIME = /(?:尽快|抓紧|有空(?:时)?|回头|晚点|稍后|抽空|这两天|过几天|改天|近期|下周找时间|月底左右|差不多|合适的时候)/u;
const DUE_TEXT = /(?:今天|明天|后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|(?:20\d{2}[年\-/])?\d{1,2}[月\-/]\d{1,2}日?)(?:\s*(?:上午|中午|下午|晚上|凌晨)?\s*\d{1,2}(?::|点)\d{0,2}分?)?\s*(?:之前|以前|前|截止)?/u;
const REMINDER_TEXT = /提前\s*(\d+)\s*(分钟|小时|天)(?:\s*(?:提醒|通知))?/u;
const QUESTION = /(?:[?？]\s*$|^(?:什么|为什么|怎么|如何|是否|能否|可以|有没有|哪里|谁|几点|多少|请问|我想(?:知道|了解)|想问(?:一下)?|能告诉我|可否告诉我))/u;
const ONE_SHOT_REQUEST = /(?:告诉我|解释一下|查一下|查询一下|搜一下|翻译一下|总结这段|看看这张|分析一下|回答一下|推荐一下|计算一下|改写一下|润色一下|生成一段|现在几点|天气怎么样)/u;
const ACKNOWLEDGEMENT_ONLY = /^(?:已?(?:确认|授权|同意|批准)|确认(?:添加|执行|继续|处理|发送|发布|安装|升级)?|同意(?:添加|执行|继续|处理|发送|发布|安装|升级)?|可以|行|好(?:的)?|收到|知道了|明白(?:了)?|继续|执行|开始|搞定|没问题|ok(?:ay)?|yes|confirm|approved?)[。！!，,\s]*$/iu;
const AMBIGUOUS_REQUEST = /(?:看看(?:这个|这件事|这个事|一下)?|跟一下(?:这个|这件事|这个事)?|处理一下(?:这个|这件事|这个事)?|弄一下|关注一下|推进一下|安排一下|记一下|搞一下|留意一下|盯一下)/u;
const HUMAN_ASSIGNMENT = /(?:交给|让|安排)\s*@?([\p{L}\p{N}_-]{1,20}?)\s*(?:来|负责|处理|完成|跟进|整理|推进)/u;
const POLITE_HUMAN_ASSIGNMENT = /(?:请|麻烦)\s*@?([\p{L}\p{N}_-]{1,20}?)(?=在|今天|明天|后天|本周|下周|周|来|负责)/u;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifierOptions(options) {
  if (options === undefined) {
    return { defaultAssigneeId: null, agentId: null, agentAliases: [] };
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('WorkIntake classifier options must be an object');
  }
  const supported = new Set(['defaultAssigneeId', 'agentId', 'agentAliases']);
  const unknown = Object.keys(options).find(key => !supported.has(key));
  if (unknown) throw new TypeError(`WorkIntake classifier options contain unsupported field: ${unknown}`);
  let defaultAssigneeId = null;
  if (options.defaultAssigneeId !== undefined && options.defaultAssigneeId !== null) {
    if (typeof options.defaultAssigneeId !== 'string' || options.defaultAssigneeId.trim() === '') {
      throw new TypeError('defaultAssigneeId must be a non-empty string');
    }
    defaultAssigneeId = options.defaultAssigneeId.trim();
  }
  let agentId = null;
  if (options.agentId !== undefined && options.agentId !== null) {
    if (typeof options.agentId !== 'string' || !AGENT_ID.test(options.agentId.trim())) {
      throw new TypeError('agentId must be a logical Agent identity');
    }
    agentId = options.agentId.trim();
  }
  const rawAliases = options.agentAliases ?? [];
  if (!Array.isArray(rawAliases)) {
    throw new TypeError('agentAliases must be an array');
  }
  if (rawAliases.length > 32) throw new TypeError('agentAliases exceeds 32 entries');
  const agentAliases = [...new Set(rawAliases.map((alias) => {
    if (typeof alias !== 'string' || alias.trim() === '' || Array.from(alias.trim()).length > 64) {
      throw new TypeError('agentAliases must contain non-empty strings');
    }
    return alias.trim();
  }))].sort((left, right) => right.length - left.length);
  if (agentAliases.length > 0 && agentId === null) {
    throw new TypeError('agentAliases require agentId');
  }
  if (defaultAssigneeId?.startsWith('agent:') && !AGENT_ID.test(defaultAssigneeId)) {
    throw new TypeError('defaultAssigneeId must be a non-empty string');
  }
  return { defaultAssigneeId, agentId, agentAliases };
}

function agentAliasPattern(profile) {
  if (!profile.agentId || profile.agentAliases.length === 0) return null;
  return `(?:${profile.agentAliases.map(escapeRegex).join('|')})`;
}

function explicitAgentAssignment(text, profile) {
  const alias = agentAliasPattern(profile);
  if (!alias) return false;
  return new RegExp(
    `(?:交给|让|请|麻烦|安排)\\s*@?${alias}(?=\\s|\\p{Script=Han}|$)|`
      + `@?${alias}\\s*(?:来|负责|处理|完成|跟进|整理|帮)|`
      + `(?:执行人|负责人|处理人|承办人)\\s*(?:是|为|[：:])?\\s*@?${alias}(?=\\s|[，,。；;]|$)`,
    'iu',
  ).test(text);
}

function extractDueText(text) {
  return text.match(DUE_TEXT)?.[0]?.replace(/\s+/g, '') ?? null;
}

function extractReminderMinutes(text, dueText) {
  if (dueText === null) return null;
  const match = text.match(REMINDER_TEXT);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = match[2] === '天' ? 1_440 : (match[2] === '小时' ? 60 : 1);
  const minutes = amount * multiplier;
  if (!Number.isSafeInteger(minutes)) {
    throw new TypeError('reminder offset exceeds the safe integer range');
  }
  return minutes;
}

function taskDirectiveText(text, profile) {
  let directive = text
    .replace(/^(?:\s*(?:【[^】\r\n]{1,80}】|\[[^\]\r\n]{1,80}\])\s*)+/u, '');
  const alias = agentAliasPattern(profile);
  if (alias) {
    directive = directive.replace(new RegExp(`^@?${alias}\\s*[，,：:、]\\s*`, 'iu'), '');
  }
  return directive.trim();
}

export function hasExplicitAgentAssignment(text, options) {
  const profile = classifierOptions(options);
  return typeof text === 'string'
    && explicitAgentAssignment(taskDirectiveText(text, profile), profile);
}

function personResolution(envelope, text, profile) {
  if (explicitAgentAssignment(text, profile)) {
    return { explicit: true, assigneeId: null, ambiguous: false };
  }
  const namedPeople = envelope.people.filter((person) => (
    new RegExp(`(?:交给|让|请|安排)\\s*@?${person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text)
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
  const match = text.match(HUMAN_ASSIGNMENT) ?? text.match(POLITE_HUMAN_ASSIGNMENT);
  if (!match) return { explicit: false, assigneeId: null, ambiguous: false };
  const name = match[1].replace(/^@/u, '');
  if (['你', '我', '我们', '大家'].includes(name)) {
    return { explicit: false, assigneeId: null, ambiguous: false };
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

function taskTitle(text, dueText, profile) {
  const quotedTitle = text.match(/[“"]([^”"\r\n]{2,200})[”"]/u)?.[1]?.trim();
  if (quotedTitle) return quotedTitle;

  let title = text
    .replace(EXPLICIT_TASK_PREFIX, '')
    .replace(/^(?:请|麻烦|帮我|请帮我|麻烦帮我)\s*/u, '')
    .trim();
  const alias = agentAliasPattern(profile);
  if (alias) {
    title = title
      .replace(new RegExp(`^(?:交给|让|安排)\\s*@?${alias}\\s*(?:来|负责|处理|完成)?\\s*`, 'iu'), '')
      .replace(new RegExp(`^@?${alias}\\s*(?:来|负责|处理|完成|帮我)?\\s*`, 'iu'), '');
  }
  if (dueText) title = title.replace(dueText, '').replace(/^在\s*/u, '').trim();
  title = title.replace(/^[，,。；;：:\s]+|[。；;\s]+$/gu, '').trim();
  if (title.length < 2) title = text.trim();
  return Array.from(title).slice(0, 200).join('');
}

function buildTaskDraft(envelope, {
  riskLevel = 'normal',
  assigneeId = null,
  directiveText = envelope.text,
  profile = classifierOptions(),
} = {}) {
  const dueText = extractDueText(directiveText);
  const reminderMinutesBeforeDue = extractReminderMinutes(directiveText, dueText);
  const title = taskTitle(directiveText, dueText, profile);
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
    reminderMinutesBeforeDue,
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
export function classify(input, options) {
  const envelope = validateInboundEnvelope(input);
  const profile = classifierOptions(options);
  const directiveText = taskDirectiveText(envelope.text, profile);
  const explicitTask = EXPLICIT_TASK_PREFIX.test(directiveText);
  const agentAssigned = explicitAgentAssignment(directiveText, profile);
  const people = personResolution(envelope, directiveText, profile);
  const assigneeId = agentAssigned
    ? profile.agentId
    : (people.assigneeId ?? (people.explicit ? null : profile.defaultAssigneeId));
  const taskDraft = (overrides = {}) => buildTaskDraft(envelope, {
    assigneeId,
    directiveText,
    profile,
    ...overrides,
  });

  // Questions and bounded one-shot help describe information needs, not an
  // instruction to perform the risky verb they happen to mention. An explicit
  // task prefix remains authoritative and still crosses the risk gate below.
  if (!explicitTask && (QUESTION.test(directiveText) || ONE_SHOT_REQUEST.test(directiveText))) {
    return result(envelope, 'chat_only', QUESTION.test(directiveText)
      ? 'QUESTION_OR_INFORMATION_REQUEST'
      : 'ONE_SHOT_REQUEST');
  }

  // Acknowledgements authorize or confirm an already established interaction;
  // they are never a new unit of work on their own. This must run before the
  // high-risk verb gate because short replies such as “已授权” contain a risky
  // action word without expressing a fresh task.
  if (!explicitTask && ACKNOWLEDGEMENT_ONLY.test(directiveText)) {
    return result(envelope, 'chat_only', 'ACKNOWLEDGEMENT_ONLY');
  }

  if (HIGH_RISK_ACTION.test(directiveText)) {
    return result(
      envelope,
      'confirm',
      'HIGH_RISK_EXTERNAL_ACTION',
      taskDraft({ riskLevel: 'high' }),
    );
  }

  if (people.ambiguous) {
    return result(
      envelope,
      'confirm',
      'PERSON_AMBIGUOUS',
      taskDraft({ assigneeId: null }),
    );
  }

  if (REMINDER_TEXT.test(directiveText) && !DUE_TEXT.test(directiveText)) {
    return result(
      envelope,
      'confirm',
      'TIME_AMBIGUOUS',
      taskDraft(),
    );
  }

  if (VAGUE_TIME.test(directiveText) && (explicitTask || agentAssigned || DURABLE_ACTION.test(directiveText))) {
    return result(
      envelope,
      'confirm',
      'TIME_AMBIGUOUS',
      taskDraft(),
    );
  }

  if (explicitTask) {
    return result(
      envelope,
      'create_task',
      'EXPLICIT_TASK_PREFIX',
      taskDraft(),
    );
  }

  const hasDue = DUE_TEXT.test(directiveText);
  const durableAction = DURABLE_ACTION.test(directiveText);
  if (agentAssigned && durableAction && !ONE_SHOT_REQUEST.test(directiveText)) {
    return result(
      envelope,
      'create_task',
      'EXPLICIT_ASSIGNMENT',
      taskDraft({ assigneeId: profile.agentId }),
    );
  }

  if (people.explicit && people.assigneeId && durableAction && !ONE_SHOT_REQUEST.test(directiveText)) {
    return result(
      envelope,
      'create_task',
      'EXPLICIT_HUMAN_ASSIGNMENT',
      taskDraft({ assigneeId: people.assigneeId }),
    );
  }

  if (hasDue && durableAction && !QUESTION.test(directiveText)) {
    return result(
      envelope,
      'create_task',
      'ACTION_WITH_DEADLINE',
      taskDraft(),
    );
  }

  if (QUESTION.test(directiveText)) {
    return result(envelope, 'chat_only', 'QUESTION_OR_INFORMATION_REQUEST');
  }
  if (ONE_SHOT_REQUEST.test(directiveText)) {
    return result(envelope, 'chat_only', 'ONE_SHOT_REQUEST');
  }

  if (AMBIGUOUS_REQUEST.test(directiveText)) {
    return result(
      envelope,
      'confirm',
      'INSUFFICIENT_TASK_DETAIL',
      taskDraft(),
    );
  }

  return result(envelope, 'chat_only', 'NO_TASK_COMMITMENT');
}
