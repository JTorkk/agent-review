import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatForAgent } from './agentFormat';
import { CommentStore, NewComment, Reanchor } from './commentStore';
import { computeLineDiff, EMPTY_DIFF } from './diff';
import { describeBase, readHeadVersion } from './git';
import { renderMarkdown } from './markdown';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'add'; comment: NewComment }
  | { type: 'update'; id: string; body: string }
  | { type: 'delete'; id: string }
  | { type: 'reanchor'; updates: Reanchor[] }
  | { type: 'copy' }
  | { type: 'clear' }
  | { type: 'openLink'; href: string };

/** One review viewer per file: rendered Markdown, diff against HEAD and comments. */
export class ReviewPanel {
  private static readonly panels = new Map<string, ReviewPanel>();

  static show(context: vscode.ExtensionContext, store: CommentStore, uri: vscode.Uri): void {
    const key = CommentStore.keyFor(uri);
    const existing = ReviewPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    ReviewPanel.panels.set(key, new ReviewPanel(context, store, uri));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly key: string;
  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CommentStore,
    private readonly uri: vscode.Uri,
  ) {
    this.key = CommentStore.keyFor(uri);
    const fileDir = vscode.Uri.file(path.dirname(uri.fsPath));
    this.panel = vscode.window.createWebviewPanel(
      'agentReview.viewer',
      `Review: ${path.basename(uri.fsPath)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          fileDir,
          ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
        ],
      },
    );
    this.panel.webview.html = this.shellHtml();

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(fileDir, path.basename(uri.fsPath)));
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.scheduleRender()),
      watcher.onDidCreate(() => this.scheduleRender()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === uri.toString()) this.scheduleRender();
      }),
      this.store.onDidChange((changedKey) => {
        if (changedKey === this.key) this.postComments();
      }),
      this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private get relativePath(): string {
    return vscode.workspace.asRelativePath(this.uri, false);
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        await this.render();
        break;
      case 'add':
        await this.store.add(this.key, msg.comment);
        break;
      case 'update':
        await this.store.update(this.key, msg.id, msg.body);
        break;
      case 'delete':
        await this.store.delete(this.key, msg.id);
        break;
      case 'reanchor':
        await this.store.reanchor(this.key, msg.updates);
        break;
      case 'copy':
        await this.copyForAgent();
        break;
      case 'clear': {
        const answer = await vscode.window.showWarningMessage(
          `Delete all review comments on ${this.relativePath}?`,
          { modal: true },
          'Delete',
        );
        if (answer === 'Delete') await this.store.clear(this.key);
        break;
      }
      case 'openLink':
        await this.openLink(msg.href);
        break;
    }
  }

  private async copyForAgent(): Promise<void> {
    const comments = this.store.get(this.key);
    if (!comments.length) {
      vscode.window.showInformationMessage('No review comments to copy.');
      return;
    }
    const base = await readHeadVersion(this.uri.fsPath);
    await vscode.env.clipboard.writeText(formatForAgent([{ path: this.relativePath, base, comments }]));
    vscode.window.showInformationMessage(
      `Copied ${comments.length} review comment${comments.length === 1 ? '' : 's'} for your agent.`,
    );
  }

  private async openLink(href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const target = decodeURIComponent(href.split('#')[0]);
    if (!target) return;
    const uri = path.isAbsolute(target)
      ? vscode.Uri.file(target)
      : vscode.Uri.file(path.resolve(path.dirname(this.uri.fsPath), target));
    await vscode.commands.executeCommand('vscode.open', uri);
  }

  private scheduleRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.render(), 250);
  }

  private async render(): Promise<void> {
    let source: string;
    try {
      source = (await vscode.workspace.openTextDocument(this.uri)).getText();
    } catch (err) {
      this.panel.webview.postMessage({ type: 'error', message: `Could not read ${this.relativePath}: ${err}` });
      return;
    }
    const base = await readHeadVersion(this.uri.fsPath);
    const diff =
      base.kind === 'tracked' ? computeLineDiff(base.text, source) : base.kind === 'untracked' ? computeLineDiff('', source) : EMPTY_DIFF;
    const fileDir = path.dirname(this.uri.fsPath);
    const html = renderMarkdown(source, {
      diff,
      resolveImage: (src) => {
        if (/^([a-z]+:|\/\/)/i.test(src)) return undefined;
        const file = path.isAbsolute(src) ? src : path.resolve(fileDir, decodeURIComponent(src));
        return this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
      },
    });
    await this.panel.webview.postMessage({
      type: 'render',
      html,
      removed: diff.removed,
      meta: {
        file: this.relativePath,
        base: describeBase(base),
        added: diff.addedCount,
        removed: diff.removedCount,
      },
    });
    this.postComments();
  }

  private postComments(): void {
    void this.panel.webview.postMessage({ type: 'comments', comments: this.store.get(this.key) });
  }

  private shellHtml(): string {
    const webview = this.panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', file));
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('viewer.css')}">
</head>
<body>
  <main id="doc-pane">
    <header id="doc-header">
      <div class="doc-title">
        <span id="file-name"></span>
        <span id="diff-stats"></span>
      </div>
      <div class="doc-meta">
        <span id="base-label"></span>
        <span class="legend"><i class="sw sw-added"></i>added <i class="sw sw-modified"></i>changed <i class="sw sw-removed"></i>removed</span>
        <button id="refresh-btn" class="link-btn" title="Re-read the file and HEAD">Refresh</button>
      </div>
    </header>
    <div id="error" hidden></div>
    <article id="content" class="markdown-body"></article>
  </main>
  <aside id="sidebar">
    <div id="sidebar-header">Comments <span id="comment-count" class="count">0</span></div>
    <div id="comment-list"></div>
    <div id="empty-hint">Select text in the document and press <b>Comment</b> to add a review comment.</div>
    <footer id="sidebar-footer">
      <button id="copy-btn" class="primary" disabled>Copy for agent</button>
      <button id="clear-btn" class="secondary" disabled>Clear</button>
    </footer>
  </aside>
  <button id="add-btn" hidden>💬 Comment</button>
  <div id="composer" hidden>
    <div id="composer-target"></div>
    <textarea id="composer-input" rows="4" placeholder="Leave a comment for the agent… (⌘/Ctrl+Enter to save, Esc to cancel)"></textarea>
    <div class="composer-actions">
      <button id="composer-cancel" class="secondary">Cancel</button>
      <button id="composer-save" class="primary">Add comment</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${media('viewer.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    clearTimeout(this.renderTimer);
    ReviewPanel.panels.delete(this.key);
    this.disposables.forEach((d) => d.dispose());
  }
}
