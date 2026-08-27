export const PUBLIC_REASONING_LINE_PREFIX = '[PUBLIC_REASONING]';
const MAX_PUBLIC_REASONING_CHARS = 4_096;

export function sanitizePublicReasoningDelta(value) {
  if (typeof value !== 'string') return '';
  let safe = value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\/(?:Users|home|private|tmp|var|etc|opt|workspace|root)\/[^\s)\]>'"`]+/g, '[local path]')
    .replace(/\b[A-Za-z]:\\[^\s)\]>'"`]+/g, '[local path]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})\b/gi, '[redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .trim();
  if (!safe) return '';
  safe = Array.from(safe).slice(0, MAX_PUBLIC_REASONING_CHARS).join('');
  return `${safe}\n`;
}

/**
 * Separate explicitly public work notes from the user-facing answer.
 *
 * The marker is an output protocol, not permission to expose hidden model
 * reasoning. Runtime prompts require concise summaries that are safe for the
 * requester to read. Unmarked text always remains part of the answer.
 */
export function splitPublicReasoningText(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { publicReasoningDeltas: [], answer: '' };
  }

  const publicReasoningDeltas = [];
  const answerParts = [];
  const lines = value.match(/[^\n]*(?:\n|$)/g) || [];

  for (const line of lines) {
    if (line.length === 0) continue;
    const hasNewline = line.endsWith('\n');
    const content = hasNewline ? line.slice(0, -1) : line;
    if (
      content === PUBLIC_REASONING_LINE_PREFIX
      || content.startsWith(`${PUBLIC_REASONING_LINE_PREFIX} `)
      || content.startsWith(`${PUBLIC_REASONING_LINE_PREFIX}\t`)
    ) {
      const summary = content
        .slice(PUBLIC_REASONING_LINE_PREFIX.length)
        .replace(/^[ \t]+/, '');
      if (summary) publicReasoningDeltas.push(`${summary}${hasNewline ? '\n' : ''}`);
      continue;
    }
    answerParts.push(line);
  }

  return {
    publicReasoningDeltas,
    answer: answerParts.join(''),
  };
}

export function stripPublicReasoningLines(value) {
  return splitPublicReasoningText(value).answer;
}
