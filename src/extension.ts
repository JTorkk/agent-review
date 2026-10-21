import * as vscode from 'vscode';
import { formatForAgent, FileReview } from './agentFormat';
import { CommentStore } from './commentStore';
import { readHeadVersion } from './git';
import { ReviewPanel } from './reviewPanel';

/** Accepts a Uri (explorer, editor title) or a SourceControlResourceState (SCM view). */
function toUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  const resourceUri = (arg as { resourceUri?: unknown } | undefined)?.resourceUri;
  return resourceUri instanceof vscode.Uri ? resourceUri : undefined;
}

async function pickMarkdownFile(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    filters: { Markdown: ['md', 'markdown'] },
    openLabel: 'Review',
  });
  return picked?.[0];
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new CommentStore(context.workspaceState);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentReview.open', async (arg?: unknown) => {
      const uri = toUri(arg) ?? vscode.window.activeTextEditor?.document.uri ?? (await pickMarkdownFile());
      if (!uri) return;
      if (uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Agent Review can only open files on disk.');
        return;
      }
      if (!/\.(md|markdown)$/i.test(uri.fsPath)) {
        vscode.window.showWarningMessage('Agent Review only supports Markdown files for now.');
        return;
      }
      ReviewPanel.show(context, store, uri);
    }),

    vscode.commands.registerCommand('agentReview.copyAll', async () => {
      const files: FileReview[] = [];
      for (const key of store.keys()) {
        const uri = vscode.Uri.parse(key);
        files.push({
          path: vscode.workspace.asRelativePath(uri, false),
          base: await readHeadVersion(uri.fsPath),
          comments: store.get(key),
        });
      }
      const count = files.reduce((n, f) => n + f.comments.length, 0);
      if (!count) {
        vscode.window.showInformationMessage('No review comments to copy.');
        return;
      }
      await vscode.env.clipboard.writeText(formatForAgent(files));
      vscode.window.showInformationMessage(
        `Copied ${count} review comment${count === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}.`,
      );
    }),

    vscode.commands.registerCommand('agentReview.clearAll', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Delete all Agent Review comments in this workspace?',
        { modal: true },
        'Delete',
      );
      if (answer === 'Delete') await store.clearAll();
    }),
  );
}

export function deactivate(): void {}
