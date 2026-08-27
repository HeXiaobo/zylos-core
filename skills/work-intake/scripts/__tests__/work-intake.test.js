import assert from 'node:assert/strict';
import test from 'node:test';

import { classify } from '../../index.js';
import { toCommitmentEnvelope } from '../commitment-adapter.js';

const YUERAN_OPTIONS = Object.freeze({
  agentId: 'agent:yueran',
  agentAliases: ['玥然'],
});

function inbound(text, overrides = {}) {
  return {
    source: {
      channel: overrides.channel ?? 'feishu',
      messageId: overrides.messageId ?? 'om_regression',
      conversationId: 'oc_regression',
      conversationType: overrides.conversationType ?? 'direct',
      threadId: overrides.threadId ?? null,
    },
    sender: { id: overrides.senderId ?? 'ou_sender', kind: 'human' },
    text,
    intentRevision: overrides.intentRevision ?? 1,
    receivedAt: '2026-08-25T02:00:00.000Z',
    timeZone: 'Asia/Shanghai',
    people: overrides.people ?? [],
  };
}

const REGRESSION_CASES = [
  // create_task: explicit prefixes, explicit assignments, and clear deadlines.
  ['任务：整理 A 客户的跟进记录', 'create_task'],
  ['待办：完成八月客户复盘', 'create_task'],
  ['创建任务 跟进供应商报价', 'create_task'],
  ['新建任务：准备季度经营报告', 'create_task'],
  ['/zylos-task create {"title":"完成测试"}', 'create_task'],
  ['请玥然在周五前整理 A 客户的跟进记录', 'create_task'],
  ['让玥然负责完成新员工手册', 'create_task'],
  ['@玥然来跟进合同归档进度', 'create_task'],
  ['麻烦玥然修复导出报错', 'create_task'],
  ['安排玥然测试新版本兼容性', 'create_task'],
  ['周五前完成重点客户回访记录', 'create_task'],
  ['明天下午3点整理销售数据', 'create_task'],
  ['后天提交客户调研报告', 'create_task'],
  ['本周五前更新渠道名单', 'create_task'],
  ['8月28日前完成 CRM 数据核对', 'create_task'],
  ['2026-09-01前准备董事会材料', 'create_task'],

  // confirm: vague work, ambiguous time/person, or risky external effects.
  ['看看 A 客户', 'confirm'],
  ['跟一下这个事', 'confirm'],
  ['处理一下这个事', 'confirm'],
  ['弄一下', 'confirm'],
  ['关注一下竞品动态', 'confirm'],
  ['推进一下续约', 'confirm'],
  ['安排一下后续', 'confirm'],
  ['记一下这件事', 'confirm'],
  ['盯一下项目进度', 'confirm'],
  ['任务：尽快整理客户档案', 'confirm'],
  ['请玥然有空更新项目计划', 'confirm'],
  ['这两天完成渠道对账', 'confirm'],
  ['任务：联系客户确认报价', 'confirm'],
  ['任务：发送邮件给全部供应商', 'confirm'],
  ['任务：删除过期客户数据', 'confirm'],
  ['让小王负责整理销售报告', 'confirm'],

  // chat_only: questions, one-shot help, and ordinary conversation.
  ['今天上海天气怎么样？', 'chat_only'],
  ['这个客户的负责人是谁？', 'chat_only'],
  ['为什么这个指标下降了', 'chat_only'],
  ['如何导出飞书表格？', 'chat_only'],
  ['能否解释一下这段代码？', 'chat_only'],
  ['帮我查一下今天的汇率', 'chat_only'],
  ['翻译一下这句话', 'chat_only'],
  ['总结这段会议记录', 'chat_only'],
  ['分析一下这张截图', 'chat_only'],
  ['推荐一下附近的餐厅', 'chat_only'],
  ['计算一下 123 乘 456', 'chat_only'],
  ['润色一下这段文案', 'chat_only'],
  ['帮我看看这张截图', 'chat_only'],
  ['看看这个客户怎么处理？', 'chat_only'],
  ['你好玥然', 'chat_only'],
  ['谢谢，已经解决了', 'chat_only'],
  ['已授权', 'chat_only'],
  ['确认添加', 'chat_only'],
  ['同意继续', 'chat_only'],
  ['收到', 'chat_only'],
  ['我刚刚完成了客户回访', 'chat_only'],
  ['这是本周的销售数据', 'chat_only'],
];

test(`Chinese classification regression corpus (${REGRESSION_CASES.length} cases)`, () => {
  for (const [text, expected] of REGRESSION_CASES) {
    assert.equal(classify(inbound(text), YUERAN_OPTIONS).decision, expected, text);
  }
});

test('information questions stay chat-only even when they mention high-risk actions', () => {
  for (const text of [
    '怎么部署到生产？',
    '如何付款？',
    '我想知道怎么部署到生产',
    '请解释一下如何删除任务',
    '告诉我怎么给客户发邮件',
  ]) {
    assert.equal(classify(inbound(text)).decision, 'chat_only', text);
  }
});

test('standalone acknowledgements never become new high-risk tasks', () => {
  for (const text of ['已授权', '确认', '确认添加', '同意继续', '好的', 'OK']) {
    const decision = classify(inbound(text), {
      defaultAssigneeId: 'agent:yueran',
    });
    assert.equal(decision.decision, 'chat_only', text);
    assert.equal(decision.reasonCode, 'ACKNOWLEDGEMENT_ONLY', text);
    assert.equal(decision.taskDraft, null, text);
  }

  assert.equal(
    classify(inbound('任务：授权小王访问项目'), {
      defaultAssigneeId: 'agent:yueran',
    }).decision,
    'confirm',
  );
});

test('recognizes an explicit task behind a chat label and polite wrapper', () => {
  const decision = classify(inbound(
    '【上线验收·自然语言任务】请创建任务：明天 18:00 前完成“Zylos 自然语言任务创建验收”，执行人是玥然，发布人和验收人是我。创建后告诉我任务链接。',
  ), YUERAN_OPTIONS);

  assert.equal(decision.decision, 'create_task');
  assert.equal(decision.reasonCode, 'EXPLICIT_TASK_PREFIX');
  assert.equal(decision.taskDraft.title, 'Zylos 自然语言任务创建验收');
  assert.equal(decision.taskDraft.assigneeId, 'agent:yueran');
  assert.equal(decision.taskDraft.dueText, '明天18:00前');
});

test('extracts a one-hour reminder from a natural-language task with a deadline', () => {
  const decision = classify(inbound(
    '【Mylos】请创建任务：2026-08-27 18:00 前完成 Fleet A–E 现场验收，负责人 Mylos，提前1小时提醒',
  ), { agentId: 'agent:mylos', agentAliases: ['Mylos'] });

  assert.equal(decision.decision, 'create_task');
  assert.equal(decision.taskDraft.dueText, '2026-08-2718:00前');
  assert.equal(decision.taskDraft.reminderMinutesBeforeDue, 60);
  assert.equal(toCommitmentEnvelope({
    envelope: inbound(
      '【Mylos】请创建任务：2026-08-27 18:00 前完成 Fleet A–E 现场验收，负责人 Mylos，提前1小时提醒',
    ),
    decision,
  }, {
    agentId: 'agent:mylos',
    agentAliases: ['Mylos'],
  }).task.reminderMinutesBeforeDue, 60);
});

test('does not create a degraded reminder task without a deadline', () => {
  const decision = classify(inbound(
    '请 Mylos 整理 Fleet A–E 现场验收，提前1小时提醒',
  ), { agentId: 'agent:mylos', agentAliases: ['Mylos'] });

  assert.equal(decision.decision, 'confirm');
  assert.equal(decision.reasonCode, 'TIME_AMBIGUOUS');
});

test('keeps wrapped risky tasks behind confirmation and task questions in chat', () => {
  assert.equal(
    classify(inbound('【CRM】请创建任务：明天 18:00 前完成客户复盘')).decision,
    'create_task',
  );
  assert.equal(
    classify(inbound('【财务】请创建任务：明天付款给供应商')).decision,
    'confirm',
  );
  assert.equal(classify(inbound('玥然，怎么创建任务？'), YUERAN_OPTIONS).decision, 'chat_only');
});

test('does not mistake ordinary response instructions for a human assignment', () => {
  assert.equal(
    classify(inbound('【上线验收·流式复测】玥然，请先显示处理状态，再只回复：流式复测通过。'), YUERAN_OPTIONS).decision,
    'chat_only',
  );
});

test('keeps release canary response instructions out of high-risk task intake', () => {
  for (const [channel, canaryText] of [
    ['feishu', 'ZYL-P0-FEISHU-f09908ea-6c4b-4073-87e0-4add88c141f0：这是 yueran 发布前通信 canary，请只回复“ACK FEISHU-f09908ea-6c4b-4073-87e0-4add88c141f0”。'],
    ['hxa-connect', 'ZYL-P0-HXA-c50a9f94-93a4-49f3-bf68-1dda66a87f04：这是 yueran 发布前通信 canary，请只回复“ACK HXA-c50a9f94-93a4-49f3-bf68-1dda66a87f04”。'],
  ]) {
    const decision = classify(inbound(canaryText, { channel }), YUERAN_OPTIONS);
    assert.equal(decision.decision, 'chat_only', canaryText);
    assert.equal(decision.reasonCode, 'RESPONSE_ONLY_INSTRUCTION', canaryText);
    assert.equal(decision.taskDraft, null, canaryText);
  }

  for (const riskyText of [
    '任务：发布公告，只回复“已完成”',
    '请只回复客户并发布公告',
    '请删除所有数据，只回复“完成”',
    '请付款给供应商，只回复“已完成”',
    '请授权小王访问项目；只回复“确认”',
    'ZYL-P0-FEISHU-f09908ea-6c4b-4073-87e0-4add88c141f0：这是 yueran 发布前通信 canary，请只回复“ACK HXA-f09908ea-6c4b-4073-87e0-4add88c141f0”。',
    'ZYL-P0-FEISHU-f09908ea-6c4b-4073-87e0-4add88c141f0：这是 yueran 发布前通信 canary，请只回复“ACK FEISHU-c50a9f94-93a4-49f3-bf68-1dda66a87f04”。',
  ]) {
    assert.equal(
      classify(inbound(riskyText), YUERAN_OPTIONS).reasonCode,
      'HIGH_RISK_EXTERNAL_ACTION',
      riskyText,
    );
  }

  assert.equal(
    classify(inbound(
      'ZYL-P0-FEISHU-f09908ea-6c4b-4073-87e0-4add88c141f0：这是 yueran 发布前通信 canary，请只回复“ACK FEISHU-f09908ea-6c4b-4073-87e0-4add88c141f0”。',
      { channel: 'telegram' },
    ), YUERAN_OPTIONS).reasonCode,
    'HIGH_RISK_EXTERNAL_ACTION',
  );
  assert.equal(
    classify(inbound(
      'ZYL-P0-HXA-c50a9f94-93a4-49f3-bf68-1dda66a87f04：这是 yueran 发布前通信 canary，请只回复“ACK HXA-c50a9f94-93a4-49f3-bf68-1dda66a87f04”。',
      { channel: 'hxa' },
    ), YUERAN_OPTIONS).reasonCode,
    'HIGH_RISK_EXTERNAL_ACTION',
  );
});

test('does not parse UUID fragments as task deadlines', () => {
  const decision = classify(inbound(
    '任务：发布 canary f09908ea-6c4b-4073-87e0-4add88c141f0',
  ));

  assert.equal(decision.decision, 'confirm');
  assert.equal(decision.reasonCode, 'HIGH_RISK_EXTERNAL_ACTION');
  assert.equal(decision.taskDraft.dueText, null);

  for (const [text, dueText] of [
    ['8月28日前完成复盘', '8月28日前'],
    ['8-28前完成复盘', '8-28前'],
    ['8/28前完成复盘', '8/28前'],
    ['2026-09-01前完成复盘', '2026-09-01前'],
    ['8月1日-8月2日完成复盘', '8月1日'],
    ['2026-08-01-2026-08-02完成复盘', '2026-08-01'],
    ['2026/08/01-2026/08/02完成复盘', '2026/08/01'],
    ['2026-08-01日下午3点前完成复盘', '2026-08-01日下午3点前'],
    ['8/1日下午3点前完成复盘', '8/1日下午3点前'],
    ['2026年8-1日下午3点前完成复盘', '2026年8-1日下午3点前'],
    ['2026-08-01日13:00前完成复盘', '2026-08-01日13:00前'],
    ['8/1日3点前完成复盘', '8/1日3点前'],
    ['2026年8-1日13:00前完成复盘', '2026年8-1日13:00前'],
  ]) {
    assert.equal(
      classify(inbound(text)).taskDraft.dueText,
      dueText,
      text,
    );
  }

  for (const invalidDate of [
    '13月1日前完成复盘',
    '1月32日前完成复盘',
    '2026-13-01前完成复盘',
    '2026-01-32前完成复盘',
    '2026/13/01前完成复盘',
    '2026/01/32前完成复盘',
  ]) {
    const invalidDecision = classify(inbound(invalidDate));
    assert.equal(invalidDecision.decision, 'chat_only', invalidDate);
    assert.equal(invalidDecision.taskDraft, null, invalidDate);
  }
});

test('applies a configured default assignee only when no person was assigned', () => {
  const defaulted = classify(
    inbound('明天 18:00 前完成客户复盘'),
    { defaultAssigneeId: 'agent:yueran' },
  );
  assert.equal(defaulted.decision, 'create_task');
  assert.equal(defaulted.taskDraft.assigneeId, 'agent:yueran');

  const explicitHuman = classify(inbound('让小王负责整理销售报告', {
    people: [{ name: '小王', id: 'ou_wang_1', candidateIds: ['ou_wang_1'], kind: 'human' }],
  }), { defaultAssigneeId: 'agent:yueran' });
  assert.equal(explicitHuman.taskDraft.assigneeId, 'ou_wang_1');

  assert.equal(
    classify(inbound('怎么创建任务？'), { defaultAssigneeId: 'agent:yueran' }).decision,
    'chat_only',
  );
});

test('returns a structured TaskDraft with human owner/acceptor and explicit yueran assignment', () => {
  const decision = classify(inbound('请玥然在周五前整理 A 客户的跟进记录'), YUERAN_OPTIONS);

  assert.equal(decision.reasonCode, 'EXPLICIT_ASSIGNMENT');
  assert.equal(decision.sourceKey, 'feishu:om_regression:work-intake:r1');
  assert.deepEqual(decision.taskDraft, {
    title: '整理 A 客户的跟进记录',
    description: '期限：周五前\n原始交办：请玥然在周五前整理 A 客户的跟进记录',
    ownerId: 'ou_sender',
    acceptorId: 'ou_sender',
    assigneeId: 'agent:yueran',
    dueText: '周五前',
    reminderMinutesBeforeDue: null,
    riskLevel: 'normal',
  });
});

test('does not recognize a branded Agent name without an explicit Agent Profile', () => {
  const decision = classify(inbound('请玥然在周五前整理 A 客户的跟进记录'));

  assert.equal(decision.decision, 'confirm');
  assert.equal(decision.reasonCode, 'PERSON_AMBIGUOUS');
  assert.equal(decision.taskDraft.assigneeId, null);
});

test('uses the configured Agent identity and aliases without changing WorkIntake semantics', () => {
  const options = {
    agentId: 'agent:mylos',
    agentAliases: ['Mylos', '麦洛斯'],
  };
  const englishAlias = classify(inbound('请 Mylos 明天整理客户回访记录'), options);
  const chineseAlias = classify(inbound('让麦洛斯负责完成新员工手册'), options);

  assert.equal(englishAlias.decision, 'create_task');
  assert.equal(englishAlias.reasonCode, 'EXPLICIT_ASSIGNMENT');
  assert.equal(englishAlias.taskDraft.assigneeId, 'agent:mylos');
  assert.equal(chineseAlias.decision, 'create_task');
  assert.equal(chineseAlias.taskDraft.assigneeId, 'agent:mylos');
  assert.equal(toCommitmentEnvelope({
    envelope: inbound('请 Mylos 明天整理客户回访记录'),
    decision: englishAlias,
  }, options).task.assigneeId, 'agent:mylos');
});

test('does not infer yueran as assignee without an explicit assignment', () => {
  const decision = classify(inbound('周五前完成重点客户回访记录'));
  assert.equal(decision.decision, 'create_task');
  assert.equal(decision.taskDraft.assigneeId, null);
  assert.equal(decision.taskDraft.ownerId, 'ou_sender');
  assert.equal(decision.taskDraft.acceptorId, 'ou_sender');
});

test('resolves one explicit human and confirms a non-unique display name', () => {
  const unique = classify(inbound('让小王负责整理销售报告', {
    people: [{ name: '小王', id: 'ou_wang_1', candidateIds: ['ou_wang_1'], kind: 'human' }],
  }));
  assert.equal(unique.decision, 'create_task');
  assert.equal(unique.reasonCode, 'EXPLICIT_HUMAN_ASSIGNMENT');
  assert.equal(unique.taskDraft.assigneeId, 'ou_wang_1');

  const mentionedWithDeadline = classify(inbound('请小王明天整理销售报告', {
    people: [{ name: '小王', id: 'ou_wang_1', candidateIds: ['ou_wang_1'], kind: 'human' }],
  }));
  assert.equal(mentionedWithDeadline.decision, 'create_task');
  assert.equal(mentionedWithDeadline.taskDraft.assigneeId, 'ou_wang_1');

  const ambiguous = classify(inbound('让小王负责整理销售报告', {
    people: [{
      name: '小王',
      id: null,
      candidateIds: ['ou_wang_1', 'ou_wang_2'],
      kind: 'human',
    }],
  }));
  assert.equal(ambiguous.decision, 'confirm');
  assert.equal(ambiguous.reasonCode, 'PERSON_AMBIGUOUS');
  assert.equal(ambiguous.taskDraft.assigneeId, null);
});

test('high-risk and ambiguous-time policies take precedence over explicit task syntax', () => {
  const highRisk = classify(inbound('任务：付款 5000 元给供应商'));
  assert.equal(highRisk.decision, 'confirm');
  assert.equal(highRisk.reasonCode, 'HIGH_RISK_EXTERNAL_ACTION');
  assert.equal(highRisk.taskDraft.riskLevel, 'high');

  const vagueTime = classify(inbound('任务：有空时更新客户名单'));
  assert.equal(vagueTime.decision, 'confirm');
  assert.equal(vagueTime.reasonCode, 'TIME_AMBIGUOUS');
});

test('message_id plus intent_revision is the stable source key', () => {
  const revisionOne = classify(inbound('任务：整理客户记录', {
    messageId: 'om_stable',
    intentRevision: 1,
  }));
  const replay = classify(inbound('任务：整理客户记录', {
    messageId: 'om_stable',
    intentRevision: 1,
  }));
  const revisionTwo = classify(inbound('任务：整理客户记录（已编辑）', {
    messageId: 'om_stable',
    intentRevision: 2,
  }));

  assert.equal(revisionOne.sourceKey, replay.sourceKey);
  assert.notEqual(revisionOne.sourceKey, revisionTwo.sourceKey);
  assert.equal(revisionTwo.sourceKey, 'feishu:om_stable:work-intake:r2');
});

test('rejects platform SDK fields, non-human senders, and malformed envelopes', () => {
  const valid = inbound('任务：整理客户记录');
  assert.throws(() => classify({ ...valid, cardKitSequence: 7 }), /unsupported field/);
  assert.throws(() => classify({ ...valid, sender: { id: 'bot', kind: 'agent' } }), /must be human/);
  assert.throws(() => classify({ ...valid, intentRevision: 0 }), /positive integer/);
  assert.throws(() => classify({ ...valid, source: { ...valid.source, conversationType: 'topic' } }), /unsupported/);
});

test('the Commitment adapter accepts automatic create and explicit confirmation only', () => {
  const envelope = inbound('任务：整理客户记录');
  const automatic = classify(envelope);
  assert.deepEqual(toCommitmentEnvelope({ envelope, decision: automatic }), {
    idempotencyKey: 'feishu:om_regression:work-intake:r1',
    source: {
      channel: 'feishu',
      externalId: 'om_regression',
      senderId: 'ou_sender',
    },
    task: {
      title: '整理客户记录',
      description: '原始交办：任务：整理客户记录',
      ownerId: 'ou_sender',
      acceptorId: 'ou_sender',
      assigneeId: null,
    },
  });

  const riskyEnvelope = inbound('任务：发送邮件给供应商');
  const confirmation = classify(riskyEnvelope);
  assert.throws(() => toCommitmentEnvelope({
    envelope: riskyEnvelope,
    decision: confirmation,
  }), /cannot create/);
  assert.equal(toCommitmentEnvelope({
    envelope: riskyEnvelope,
    decision: confirmation,
  }, { confirmed: true }).idempotencyKey, confirmation.sourceKey);

  assert.throws(() => toCommitmentEnvelope({
    envelope,
    decision: {
      ...automatic,
      taskDraft: { ...automatic.taskDraft, ownerId: 'ou_spoofed' },
    },
  }), /human sender/);
  assert.throws(() => toCommitmentEnvelope({
    envelope,
    decision: {
      ...automatic,
      taskDraft: { ...automatic.taskDraft, assigneeId: 'agent:yueran' },
    },
  }), /explicit assignment/);
});

test('the Commitment adapter accepts a persisted pre-reminder TaskDraft', () => {
  const envelope = inbound('任务：整理客户记录');
  const decision = classify(envelope);
  const { reminderMinutesBeforeDue: _reminder, ...legacyTaskDraft } = decision.taskDraft;

  const adapted = toCommitmentEnvelope({
    envelope,
    decision: { ...decision, taskDraft: legacyTaskDraft },
  });

  assert.equal(Object.hasOwn(adapted.task, 'reminderMinutesBeforeDue'), false);
});
