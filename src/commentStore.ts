import { randomUUID } from 'crypto';
import * as vscode from 'vscode';

export type CommentSide = 'current' | 'removed';

export interface ReviewComment {
  id: string;
  /** "current": lines in the file now. "removed": lines in HEAD that were deleted. */
  side: CommentSide;
  /** 1-based, inclusive, Markdown source lines on `side`. */
  startLine: number;
  endLine: number;
  /** Position in the current file, used for ordering removed-side comments. */
  sortLine: number;
  /** Exact text selected in the rendered view. */
  quote: string;
  body: string;
  createdAt: string;
  /** Set when the quote could no longer be found after the file changed. */
  stale?: boolean;
}

export type NewComment = Pick<ReviewComment, 'side' | 'startLine' | 'endLine' | 'sortLine' | 'quote' | 'body'>;
export type Reanchor = Pick<ReviewComment, 'id' | 'startLine' | 'endLine' | 'sortLine' | 'stale'>;

const STATE_KEY = 'agentReview.comments';

type StoreShape = Record<string, ReviewComment[]>;

export function sortComments(comments: ReviewComment[]): ReviewComment[] {
  return [...comments].sort(
    (a, b) =>
      a.sortLine - b.sortLine ||
      (a.side === b.side ? 0 : a.side === 'removed' ? -1 : 1) ||
      a.startLine - b.startLine ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/** Review comments per file, kept in the workspace's extension state. */
export class CommentStore {
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires with the file key whose comments changed. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  static keyFor(uri: vscode.Uri): string {
    return uri.toString();
  }

  get(key: string): ReviewComment[] {
    return sortComments(this.all()[key] ?? []);
  }

  keys(): string[] {
    return Object.entries(this.all())
      .filter(([, comments]) => comments.length > 0)
      .map(([key]) => key);
  }

  async add(key: string, input: NewComment): Promise<void> {
    const comment: ReviewComment = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.write(key, [...(this.all()[key] ?? []), comment]);
  }

  async update(key: string, id: string, body: string): Promise<void> {
    await this.write(key, (this.all()[key] ?? []).map((c) => (c.id === id ? { ...c, body } : c)));
  }

  async reanchor(key: string, updates: Reanchor[]): Promise<void> {
    const byId = new Map(updates.map((u) => [u.id, u]));
    await this.write(
      key,
      (this.all()[key] ?? []).map((c) => {
        const u = byId.get(c.id);
        return u ? { ...c, startLine: u.startLine, endLine: u.endLine, sortLine: u.sortLine, stale: u.stale } : c;
      }),
    );
  }

  async delete(key: string, id: string): Promise<void> {
    await this.write(key, (this.all()[key] ?? []).filter((c) => c.id !== id));
  }

  async clear(key: string): Promise<void> {
    await this.write(key, []);
  }

  async clearAll(): Promise<void> {
    const keys = this.keys();
    await this.state.update(STATE_KEY, {});
    keys.forEach((key) => this.changed.fire(key));
  }

  private all(): StoreShape {
    return this.state.get<StoreShape>(STATE_KEY, {});
  }

  private async write(key: string, comments: ReviewComment[]): Promise<void> {
    const all = { ...this.all() };
    if (comments.length) all[key] = comments;
    else delete all[key];
    await this.state.update(STATE_KEY, all);
    this.changed.fire(key);
  }
}
