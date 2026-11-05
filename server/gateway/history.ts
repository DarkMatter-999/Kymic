import { visibleMessages } from './protocol.js';

interface SessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: unknown;
}

/**
 * Pi's authoritative history for the active branch: walk from the leaf back
 * through parentId, keep user/assistant/toolResult messages, and attach each
 * entry's stable ID so edits and regenerations can fork from it. Abandoned
 * branches and non-message entries are skipped; compaction does not hide
 * earlier messages because they remain on the path.
 */
export function activeBranchMessages(
  entries: readonly SessionEntry[],
  leafId: string | null | undefined
): Record<string, unknown>[] {
  if (!leafId) return [];
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry);
  }
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(leafId);
  while (cursor && typeof cursor.id === 'string' && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  path.reverse();

  const out: Record<string, unknown>[] = [];
  for (const entry of path) {
    if (entry.type !== 'message' || !entry.message) continue;
    if (visibleMessages([entry.message]).length === 0) continue;
    out.push({ ...(entry.message as object), entryId: entry.id });
  }
  return out;
}
