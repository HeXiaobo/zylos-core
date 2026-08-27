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
    defaultAssigneeId: 'agent:mylos',
    agentId: 'agent:mylos',
    agentAliases: ['mylos'],
  });
});

test('defaults direct WorkIntake to the configured Agent identity', () => {
  assert.deepEqual(workIntakeProfileFromEnv({
    ZYLOS_AGENT_ID: 'agent:yueran',
    ZYLOS_AGENT_LABEL: '玥然',
  }), {
    defaultAssigneeId: 'agent:yueran',
    agentId: 'agent:yueran',
    agentAliases: ['玥然'],
  });
});

test('preserves an explicit WorkIntake default assignee override', () => {
  assert.deepEqual(workIntakeProfileFromEnv({
    ZYLOS_AGENT_ID: 'agent:yueran',
    C4_WORK_INTAKE_DEFAULT_ASSIGNEE_ID: 'agent:triage',
  }), {
    defaultAssigneeId: 'agent:triage',
    agentId: 'agent:yueran',
    agentAliases: [],
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
