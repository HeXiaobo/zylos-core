export const SAFE_PROGRESS_STAGES = Object.freeze([
  'reading',
  'searching',
  'querying',
  'writing',
  'executing',
  'communicating',
  'organizing',
  'recovering',
]);

const PUBLIC_TOOL_PROGRESS = Object.freeze({
  reading: Object.freeze({
    action: 'read_sources',
    started: 'Reviewing source material',
    completed: 'Source review completed',
  }),
  searching: Object.freeze({
    action: 'search_sources',
    started: 'Searching relevant sources',
    completed: 'Relevant sources found',
  }),
  querying: Object.freeze({
    action: 'query_data',
    started: 'Checking relevant data',
    completed: 'Relevant data checked',
  }),
  writing: Object.freeze({
    action: 'update_content',
    started: 'Preparing content updates',
    completed: 'Content update completed',
  }),
  executing: Object.freeze({
    action: 'execute_operation',
    started: 'Running a required operation',
    completed: 'Required operation completed',
  }),
  communicating: Object.freeze({
    action: 'communicate',
    started: 'Handling communication',
    completed: 'Communication completed',
  }),
  organizing: Object.freeze({
    action: 'organize_result',
    started: 'Organizing the result',
    completed: 'Result organized',
  }),
});

const PUBLIC_SPECIAL_TOOL_PROGRESS = Object.freeze([
  Object.freeze({
    pattern: /(agent|delegate|subagent)/,
    stage: 'organizing',
    action: 'coordinate_work',
    started: 'Coordinating work',
    completed: 'Work coordination completed',
  }),
  Object.freeze({
    pattern: /skill/,
    stage: 'organizing',
    action: 'prepare_workflow',
    started: 'Preparing the required workflow',
    completed: 'Required workflow prepared',
  }),
]);

export const RUNTIME_ANALYSIS_PROGRESS = Object.freeze({
  stage: 'organizing',
  action: 'analyze_request',
  status: 'started',
  summary: 'Analyzing the request',
});

const TOOL_RECOVERY_PROGRESS = Object.freeze({
  stage: 'recovering',
  action: 'recover_tool',
  status: 'failed',
  summary: 'Adjusting after a tool issue',
});

function progressStageForTool(toolName, failed = false) {
  if (failed) return 'recovering';
  const normalized = String(toolName || '').toLowerCase();
  if (!normalized) return null;
  if (/(read|open|view|fetch)/.test(normalized)) return 'reading';
  if (/(grep|glob|find|search)/.test(normalized)) return 'searching';
  if (/(calendar|sheet|base|database|query|list|get)/.test(normalized)) return 'querying';
  if (/(write|edit|patch|create|update)/.test(normalized)) return 'writing';
  if (/(send|mail|message|notify)/.test(normalized)) return 'communicating';
  if (/(bash|shell|exec|command|computer|browser)/.test(normalized)) return 'executing';
  return 'organizing';
}

export function safeProgressStageForTool(toolName, { failed = false } = {}) {
  return progressStageForTool(toolName, failed);
}

/**
 * Convert runtime-owned tool identity into a fixed public progress fact.
 * Raw inputs, tool output, and model-authored text never cross this Interface;
 * tool names are classified here but never leave the returned public result or
 * enter the durable response ledger.
 */
export function publicProgressForRuntimeTool({ toolName, status } = {}) {
  if (typeof toolName !== 'string' || !toolName.trim()) {
    throw new TypeError('toolName must be a non-empty string');
  }
  const safeToolName = toolName.trim();
  if (Array.from(safeToolName).length > 256) throw new TypeError('toolName exceeds 256 characters');
  if (!['started', 'completed', 'failed'].includes(status)) {
    throw new TypeError('tool progress status is unsupported');
  }
  if (status === 'failed') return TOOL_RECOVERY_PROGRESS;
  const special = PUBLIC_SPECIAL_TOOL_PROGRESS.find(item => item.pattern.test(safeToolName.toLowerCase()));
  const stage = special?.stage || progressStageForTool(safeToolName, false);
  const descriptor = special || PUBLIC_TOOL_PROGRESS[stage];
  return Object.freeze({
    stage,
    action: descriptor.action,
    status,
    summary: descriptor[status],
  });
}
