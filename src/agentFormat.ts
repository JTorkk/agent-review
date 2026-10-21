import type { ReviewComment } from './commentStore';
import type { BaseVersion } from './git';

export interface FileReview {
  /** Path relative to the workspace root. */
  path: string;
  base: BaseVersion;
  comments: ReviewComment[];
}

function lineSpec(c: ReviewComment): string {
  return c.startLine === c.endLine ? String(c.startLine) : `${c.startLine}-${c.endLine}`;
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function headRef(files: FileReview[]): string {
  const refs = new Set(files.flatMap((f) => (f.base.kind === 'nogit' ? [] : [f.base.ref])));
  return refs.size === 1 ? `HEAD (${[...refs][0]})` : 'HEAD';
}

/** Formats review comments as a prompt an AI agent can act on. */
export function formatForAgent(files: FileReview[]): string {
  const reviewed = files.filter((f) => f.comments.length > 0);
  const out: string[] = [
    'Please address my review comments below. Each <review_comment> points at a specific place in a file:',
    '- file: path relative to the workspace root.',
    '- lines: 1-based line numbers in the file SOURCE (for Markdown: lines in the .md source, not the rendered view).',
    `- side="current": lines in the file as it is now on disk. side="removed": lines that existed in ${headRef(reviewed)} but were deleted in the current version. Treat these as comments on the deletion; usually they mean the removed text should be restored or reconsidered.`,
    '- <quote> is the exact text I selected in the rendered view, so Markdown syntax (#, *, `, link targets) may be missing from it. If the line numbers no longer match (for example after your own edits), locate the place by the quote.',
    'Make the requested changes. When done, reply with a short summary of what you changed for each comment id.',
    '',
  ];

  let id = 1;
  for (const file of reviewed) {
    for (const c of file.comments) {
      const stale = c.stale ? ' stale="true"' : '';
      out.push(`<review_comment id="${id++}" file="${attr(file.path)}" lines="${lineSpec(c)}" side="${c.side}"${stale}>`);
      out.push('<quote>', c.quote, '</quote>');
      out.push('<comment>', c.body.trim(), '</comment>');
      out.push('</review_comment>', '');
    }
  }
  if (reviewed.some((f) => f.comments.some((c) => c.stale))) {
    out.push('Comments marked stale="true" could not be matched to the current file; their line numbers may be outdated, so rely on the quote.');
  }
  return out.join('\n').trimEnd() + '\n';
}
