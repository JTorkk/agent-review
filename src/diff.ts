import { diffLines } from 'diff';

/** A run of HEAD lines that no longer exist in the current file. */
export interface RemovedHunk {
  /** 1-based line in the current file that the removed text sat before. */
  anchor: number;
  /** 1-based line in the HEAD version where the removed text started. */
  oldStart: number;
  lines: string[];
}

export interface LineDiff {
  /** 1-based line numbers in the current file that are new or changed. */
  added: Set<number>;
  removed: RemovedHunk[];
  addedCount: number;
  removedCount: number;
}

export const EMPTY_DIFF: LineDiff = { added: new Set(), removed: [], addedCount: 0, removedCount: 0 };

function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function computeLineDiff(base: string, current: string): LineDiff {
  const parts = diffLines(base.replace(/\r\n/g, '\n'), current.replace(/\r\n/g, '\n'));
  const added = new Set<number>();
  const removed: RemovedHunk[] = [];
  let newLine = 1;
  let oldLine = 1;
  let addedCount = 0;
  let removedCount = 0;
  for (const part of parts) {
    const lines = splitLines(part.value);
    if (part.added) {
      for (let i = 0; i < lines.length; i++) added.add(newLine + i);
      newLine += lines.length;
      addedCount += lines.length;
    } else if (part.removed) {
      removed.push({ anchor: newLine, oldStart: oldLine, lines });
      oldLine += lines.length;
      removedCount += lines.length;
    } else {
      newLine += lines.length;
      oldLine += lines.length;
    }
  }
  return { added, removed, addedCount, removedCount };
}
