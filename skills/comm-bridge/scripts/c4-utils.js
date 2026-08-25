import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  FILE_SIZE_THRESHOLD,
  ATTACHMENTS_DIR,
  CONTENT_PREVIEW_CHARS
} from './c4-config.js';
import { PUBLIC_REASONING_LINE_PREFIX } from './assistant-public-reasoning.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildReplyViaSuffix(channel, endpointId, assistantRequestId = null) {
  if (!channel || !endpointId) return '';
  const requestOption = assistantRequestId
    ? ` --request-id "${assistantRequestId}"`
    : '';
  return ` ---- reply via: node ${path.join(__dirname, 'c4-send.js')} "${channel}" "${endpointId}"${requestOption}`;
}

export function buildStreamedReplySuffix(assistantRequestId) {
  if (!assistantRequestId) return '';
  return [
    ' ---- streamed reply:',
    'Reply directly in this runtime turn.',
    'Do not call c4-send for this reply.',
    'Your displayed assistant text is delivered automatically.',
    `Before or after meaningful steps, you may write one concise user-facing work summary on its own line prefixed exactly ${PUBLIC_REASONING_LINE_PREFIX}.`,
    'These summaries must describe only safe progress and conclusions; never reveal hidden chain-of-thought, tool inputs, raw tool results, paths, credentials, or secrets.',
    'Write the final answer as normal unprefixed user-facing text.',
    `assistant request: "${assistantRequestId}"`,
  ].join(' ');
}

export function hasLegacyReplyViaSuffix(content = '') {
  return /---- reply via: node\b.*\bc4-send\.js\b/.test(content);
}

// Fallback counter for spills without a conversation id: two spills within
// the same millisecond (e.g. a renderer looping over several long messages)
// must never resolve to the same directory and silently overwrite each other.
let spillSeq = 0;

export function truncateForDelivery(content, replyViaSuffix = '', convId) {
  const fullMessage = content + replyViaSuffix;
  const byteLength = Buffer.byteLength(fullMessage, 'utf8');

  if (byteLength <= FILE_SIZE_THRESHOLD) {
    return fullMessage;
  }

  // Prefer the conversation id: globally unique (DB primary key), directly
  // traceable back to the row, and re-rendering the same message becomes an
  // idempotent overwrite of one directory instead of piling up copies.
  const msgId = (convId !== undefined && convId !== null)
    ? `conv-${convId}`
    : `${Date.now()}-${process.pid}-${spillSeq++}`;
  const messageDir = path.join(ATTACHMENTS_DIR, msgId);
  fs.mkdirSync(messageDir, { recursive: true });
  const filePath = path.join(messageDir, 'message.txt');
  fs.writeFileSync(filePath, fullMessage, 'utf8');

  const preview = content.substring(0, CONTENT_PREVIEW_CHARS);
  const ellipsis = preview.length < content.length ? '...' : '';
  const sizeKB = (byteLength / 1024).toFixed(1);
  const previewKB = (Buffer.byteLength(preview, 'utf8') / 1024).toFixed(1);
  // The notice must be an instruction, not metadata: weaker models otherwise
  // reply from the preview alone while claiming to have read everything (#748).
  return `${preview}${ellipsis}\n\n[C4] ⚠️ TRUNCATED — the text above is only a preview (${previewKB}KB of ${sizeKB}KB). Before acting or replying you MUST read the complete message file: ${filePath}${replyViaSuffix}`;
}
