# Agent Review

Review what an AI agent changed in a Markdown file, comment on it the way you would on a GitHub PR, and copy the comments back to the agent as a prompt.

## Using it

1. Open a Markdown file's review viewer in one of these ways:
   - right-click it in the Explorer or in Source Control
   - use the comment icon in the editor title bar
   - run **Agent Review: Open in Review Viewer**
2. The file is rendered and compared with its `HEAD` version:
   - green bar: added block
   - blue bar: changed block
   - red block: removed text, shown as source lines
3. Select any text, one word or several blocks, and press **💬 Comment**. You can also press ⌘/Ctrl+Shift+M. Write the comment and save it with ⌘/Ctrl+Enter.
4. Comments appear inline under the text and in the list on the right. Click a comment to jump to it; you can edit or delete it from the list.
5. **Copy for agent** puts every comment for the file on the clipboard in a format an agent can act on.

The viewer re-renders when the file changes on disk or in an editor. If the quoted text moved, its comment moves with it. If the quote can't be found any more, the comment is marked *stale*.

Other commands:
- **Agent Review: Copy All Comments for Agent** copies comments from every file.
- **Agent Review: Clear All Comments** deletes all comments in the workspace.

Comments are stored in VS Code's workspace state, not in the repo.

## Comment format

```
<review_comment id="1" file="docs/plan.md" lines="12-18" side="current">
<quote>
exact text that was selected
</quote>
<comment>
what to change
</comment>
</review_comment>
```

- `lines` are 1-based **source** lines.
- `side="removed"` means the lines exist only in `HEAD`, because the change deleted them.
- The quote lets the agent find the spot even after line numbers shift.

The copied text starts with a short explanation of these rules for the agent.

## Development

```sh
npm install
npm run check      # typecheck
npm run build      # bundle to dist/
```

Press F5 in VS Code to start an Extension Development Host with the extension loaded.

## Install from a .vsix

```sh
npm run package                                  # → agent-review-0.0.1.vsix
code --install-extension agent-review-0.0.1.vsix
```

For Antigravity, use its CLI with the same flag, or run **Extensions: Install from VSIX…** from its command palette.

## Layout

| Path | Purpose |
|---|---|
| `src/extension.ts` | Commands |
| `src/reviewPanel.ts` | Webview panel: loads the file, diffs it against HEAD, relays comments |
| `src/markdown.ts` | markdown-it rendering; tags every block with `data-ls`/`data-le` source lines and diff status |
| `src/diff.ts` | Line diff and removed hunks |
| `src/git.ts` | Reads the HEAD version with the git CLI |
| `src/commentStore.ts` | Comment persistence (workspace state) |
| `src/agentFormat.ts` | Copy-for-agent prompt format |
| `media/viewer.js` | Webview: selection → source lines, comment UI, sidebar, re-anchoring |
| `media/viewer.css` | Webview styles (VS Code theme variables) |
