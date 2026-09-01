import {
  assertContextSnapshotV1,
  canonicalContextSnapshotBytes,
} from './context-assembler.js';

/**
 * Compatibility renderer for the existing shared Runtime input seam. It only
 * renders data; it neither selects nor creates a Runtime session.
 */
export function renderContextSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('ContextSnapshot must be an object');
  }
  assertContextSnapshotV1(snapshot);
  return `Zylos Context Snapshot v1\n${canonicalContextSnapshotBytes(snapshot).toString('utf8')}\n`;
}
