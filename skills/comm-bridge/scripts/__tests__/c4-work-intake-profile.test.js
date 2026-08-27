import assert from 'node:assert/strict';
import test from 'node:test';

import { workIntakeProfileFromEnv } from '../c4-work-intake-profile.js';

test('resolves one shared Agent identity and natural-language aliases', () => {
  assert.deepEqual(workIntakeProfileFromEnv({
    ZYLOS_AGENT_ID: 'agent:yueran',
    ZYLOS_AGENT_PROFILE: 'yueran',
    ZYLOS_AGENT_LABEL: '玥然',
    ZYLOS_AGENT_ALIASES: '["悦然","玥然"]',
    C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: 'agent:yueran',
  }), {
    defaultAssigneeId: 'agent:yueran',
    agentId: 'agent:yueran',
    agentAliases: ['悦然', '玥然', 'yueran'],
  });
});

test('derives the logical identity from Agent Profile for managed runtimes', () => {
  assert.deepEqual(workIntakeProfileFromEnv({ ZYLOS_AGENT_PROFILE: 'mylos' }), {
    defaultAssigneeId: null,
    agentId: 'agent:mylos',
    agentAliases: ['mylos'],
  });
});

test('fails closed for conflicting identity or malformed aliases', () => {
  assert.throws(() => workIntakeProfileFromEnv({
    ZYLOS_AGENT_ID: 'agent:yueran',
    ZYLOS_AGENT_PROFILE: 'mylos',
  }), /conflicts/);
  assert.throws(() => workIntakeProfileFromEnv({
    ZYLOS_AGENT_ID: 'agent:yueran',
    ZYLOS_AGENT_ALIASES: '玥然',
  }), /JSON array/);
  assert.throws(() => workIntakeProfileFromEnv({
    ZYLOS_AGENT_LABEL: '玥然',
  }), /aliases require/);
});
