// @ts-check
// Review viewer webview: shows the rendered file, lets the user paint a
// selection and comment on it, and lists the comments in the sidebar.
(function () {
  // @ts-ignore acquireVsCodeApi is injected by VS Code
  const vscode = acquireVsCodeApi();

  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const content = $('content');
  const docPane = $('doc-pane');
  const list = $('comment-list');
  const addBtn = $('add-btn');
  const composer = $('composer');
  const composerInput = /** @type {HTMLTextAreaElement} */ ($('composer-input'));

  /**
   * @typedef {{ id: string, side: 'current' | 'removed', startLine: number, endLine: number,
   *   sortLine: number, quote: string, body: string, stale?: boolean }} ReviewComment
   * @typedef {{ side: 'current' | 'removed', startLine: number, endLine: number, sortLine: number,
   *   quote: string, range: Range, parts: Range[] }} PendingSelection
   */

  /** @type {ReviewComment[]} */
  let comments = [];
  /** @type {PendingSelection | null} */
  let pending = null;
  /** True after a render until comments have been re-anchored against it. */
  let needsReanchor = false;

  const hasHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS;

  // ---------- helpers ----------

  /** @param {Element} el */
  const sideOf = (el) => (/** @type {HTMLElement} */ (el).dataset.side === 'removed' ? 'removed' : 'current');

  /** All commentable blocks in document order. */
  const allLeaves = () => /** @type {HTMLElement[]} */ ([...content.querySelectorAll('[data-ls]')]);

  /** @param {'current'|'removed'} side @param {number} start @param {number} end */
  const leavesFor = (side, start, end) =>
    allLeaves().filter((el) => sideOf(el) === side && +(el.dataset.le ?? 0) >= start && +(el.dataset.ls ?? 0) <= end);

  /** @param {number} start @param {number} end */
  const lineLabel = (start, end) => (start === end ? `L${start}` : `L${start}–${end}`);

  /** @param {string} text @param {number} max */
  const truncate = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);

  /**
   * Finds `quote` inside the given blocks, ignoring whitespace differences.
   * @param {HTMLElement[]} leaves @param {string} quote
   * Returns one range per block so highlights skip anything rendered between
   * the blocks (removed hunks, comment cards).
   * @returns {{ ranges: Range[], leaves: HTMLElement[] } | null}
   */
  function findQuote(leaves, quote) {
    const needle = quote.replace(/\s+/g, '');
    if (!needle) return null;
    /** @type {{ node: Text, offset: number, leaf: HTMLElement }[]} */
    const chars = [];
    let haystack = '';
    for (const leaf of leaves) {
      const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = /** @type {Text} */ (node);
        for (let i = 0; i < text.data.length; i++) {
          if (/\s/.test(text.data[i])) continue;
          chars.push({ node: text, offset: i, leaf });
          haystack += text.data[i];
        }
      }
    }
    const idx = haystack.indexOf(needle);
    if (idx < 0) return null;
    const matched = chars.slice(idx, idx + needle.length);
    /** @type {Range[]} */
    const ranges = [];
    /** @type {HTMLElement[]} */
    const hitLeaves = [];
    let start = 0;
    for (let i = 1; i <= matched.length; i++) {
      if (i < matched.length && matched[i].leaf === matched[start].leaf) continue;
      const range = document.createRange();
      range.setStart(matched[start].node, matched[start].offset);
      range.setEnd(matched[i - 1].node, matched[i - 1].offset + 1);
      ranges.push(range);
      hitLeaves.push(matched[start].leaf);
      start = i;
    }
    return { ranges, leaves: hitLeaves };
  }

  /**
   * The part of `el` covered by the selection.
   * @param {Range} range @param {Element} el
   * @returns {{ text: string, range: Range } | null}
   */
  function selectedPartOf(range, el) {
    if (!range.intersectsNode(el)) return null;
    const r = document.createRange();
    r.selectNodeContents(el);
    if (range.compareBoundaryPoints(Range.START_TO_START, r) > 0) r.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) < 0) r.setEnd(range.endContainer, range.endOffset);
    const text = r.toString().trim();
    return text ? { text, range: r } : null;
  }

  /** The `data-anchor` of the removed hunk containing `el`, if any. @param {Element} el */
  function ghostAnchor(el) {
    const ghost = /** @type {HTMLElement | null} */ (el.closest('.ar-ghost'));
    return ghost ? +(ghost.dataset.anchor ?? 0) : null;
  }

  /** The first commentable block inside `container`. @param {Element} container */
  const firstLeafIn = (container) => container.querySelector('[data-ls]');

  /** Inserts `el` before a block, keeping list and table markup valid. @param {HTMLElement} leaf @param {HTMLElement} el */
  function insertBefore(leaf, el) {
    if (leaf.tagName === 'TR') {
      const tr = document.createElement('tr');
      tr.className = 'ar-row-wrap';
      const td = document.createElement('td');
      td.colSpan = 100;
      td.append(el);
      tr.append(td);
      leaf.before(tr);
      return;
    }
    const li = leaf.closest('li');
    if (li && content.contains(li) && firstLeafIn(li) === leaf) {
      const wrap = document.createElement('li');
      wrap.className = 'ar-li-wrap';
      wrap.append(el);
      li.before(wrap);
      return;
    }
    leaf.before(el);
  }

  /**
   * Inserts `el` after a block. Cards go after whole code blocks and tables;
   * removed-line hunks may sit between code lines.
   * @param {HTMLElement} leaf @param {HTMLElement} el @param {boolean} isCard
   */
  function insertAfter(leaf, el, isCard) {
    /** @type {Element} */
    let anchor = leaf;
    if (leaf.tagName === 'TR') anchor = /** @type {Element} */ (leaf.closest('table'));
    else if (isCard && leaf.closest('pre')) anchor = /** @type {Element} */ (leaf.closest('pre'));
    else if (isCard && leaf.closest('.ar-ghost')) anchor = /** @type {Element} */ (leaf.closest('.ar-ghost'));
    while (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('ar-card')) {
      anchor = anchor.nextElementSibling;
    }
    anchor.after(el);
  }

  // ---------- rendering ----------

  /**
   * @param {{ anchor: number, oldStart: number, lines: string[] }[]} removed
   */
  function insertRemovedHunks(removed) {
    const current = allLeaves();
    for (const hunk of removed) {
      const ghost = document.createElement('div');
      ghost.className = 'ar-ghost';
      ghost.dataset.anchor = String(hunk.anchor);
      const label = document.createElement('div');
      label.className = 'ar-ghost-label';
      const oldEnd = hunk.oldStart + hunk.lines.length - 1;
      label.textContent = `Removed · HEAD ${lineLabel(hunk.oldStart, oldEnd)}`;
      ghost.append(label);
      hunk.lines.forEach((text, i) => {
        const line = document.createElement('div');
        line.className = 'ar-line';
        line.dataset.side = 'removed';
        line.dataset.ls = line.dataset.le = String(hunk.oldStart + i);
        line.textContent = text;
        ghost.append(line);
      });

      const inside = current.find((el) => +(el.dataset.ls ?? 0) < hunk.anchor && +(el.dataset.le ?? 0) >= hunk.anchor);
      const next = current.find((el) => +(el.dataset.ls ?? 0) >= hunk.anchor);
      if (inside) insertAfter(inside, ghost, false);
      else if (next) insertBefore(next, ghost);
      else content.append(ghost);
    }
  }

  /** @param {{ html: string, removed: any[], meta: any }} msg */
  function renderDocument(msg) {
    const scrollTop = docPane.scrollTop;
    $('error').hidden = true;
    content.innerHTML = msg.html;
    insertRemovedHunks(msg.removed);
    $('file-name').textContent = msg.meta.file;
    $('base-label').textContent = `Diff vs ${msg.meta.base}`;
    const stats = $('diff-stats');
    stats.innerHTML = '';
    if (msg.meta.added || msg.meta.removed) {
      const add = document.createElement('span');
      add.className = 'stat-add';
      add.textContent = `+${msg.meta.added}`;
      const rem = document.createElement('span');
      rem.className = 'stat-rem';
      rem.textContent = `−${msg.meta.removed}`;
      stats.append(add, ' ', rem);
    } else {
      stats.textContent = 'no changes';
    }
    docPane.scrollTop = scrollTop;
    cancelComposer();
    needsReanchor = true;
    decorate();
  }

  /**
   * After the file changed, move comments to wherever their quote now is.
   * Runs once per render, after the comments for that render are known.
   */
  function reanchor() {
    /** @type {{ id: string, startLine: number, endLine: number, sortLine: number, stale: boolean }[]} */
    const updates = [];
    for (const c of comments) {
      const own = leavesFor(c.side, c.startLine, c.endLine);
      const inPlace = own.length ? findQuote(own, c.quote) : null;
      if (inPlace) {
        const sortLine = ghostAnchor(inPlace.leaves[0]) ?? c.startLine;
        if (c.stale || sortLine !== c.sortLine) {
          updates.push({ id: c.id, startLine: c.startLine, endLine: c.endLine, sortLine, stale: false });
        }
        continue;
      }
      const found = findQuote(
        allLeaves().filter((el) => sideOf(el) === c.side),
        c.quote,
      );
      if (found) {
        const startLine = Math.min(...found.leaves.map((el) => +(el.dataset.ls ?? 0)));
        const endLine = Math.max(...found.leaves.map((el) => +(el.dataset.le ?? 0)));
        const sortLine = ghostAnchor(found.leaves[0]) ?? startLine;
        updates.push({ id: c.id, startLine, endLine, sortLine, stale: false });
      } else if (!c.stale) {
        updates.push({ id: c.id, startLine: c.startLine, endLine: c.endLine, sortLine: c.sortLine, stale: true });
      }
    }
    if (updates.length) vscode.postMessage({ type: 'reanchor', updates });
  }

  /** Draws inline comment cards and highlights for the current comments. */
  function decorate() {
    content.querySelectorAll('.ar-card').forEach((el) => el.remove());
    content.querySelectorAll('.ar-has-comment').forEach((el) => el.classList.remove('ar-has-comment'));
    /** @type {Range[]} */
    const ranges = [];

    comments.forEach((c, i) => {
      const leaves = leavesFor(c.side, c.startLine, c.endLine);
      if (!leaves.length) return;
      leaves.forEach((el) => el.classList.add('ar-has-comment'));
      const found = findQuote(leaves, c.quote);
      if (found) ranges.push(...found.ranges);

      const card = document.createElement('div');
      card.className = 'ar-card';
      card.dataset.id = c.id;
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(i + 1);
      const body = document.createElement('span');
      body.className = 'ar-card-body';
      body.textContent = c.body;
      card.append(badge, body);
      card.addEventListener('click', () => focusListItem(c.id));
      insertAfter(leaves[leaves.length - 1], card, true);
    });

    if (hasHighlights) {
      // @ts-ignore Highlight is available in VS Code's Chromium
      CSS.highlights.set('ar-comment', new Highlight(...ranges));
    }
  }

  function setPendingHighlight() {
    if (!hasHighlights) return;
    // @ts-ignore
    if (pending) CSS.highlights.set('ar-pending', new Highlight(...pending.parts));
    // @ts-ignore
    else CSS.highlights.delete('ar-pending');
  }

  // ---------- sidebar ----------

  function renderList() {
    list.innerHTML = '';
    $('comment-count').textContent = String(comments.length);
    $('empty-hint').hidden = comments.length > 0;
    /** @type {HTMLButtonElement} */ ($('copy-btn')).disabled = comments.length === 0;
    /** @type {HTMLButtonElement} */ ($('clear-btn')).disabled = comments.length === 0;
    $('copy-btn').textContent = comments.length ? `Copy ${comments.length} for agent` : 'Copy for agent';

    comments.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'item' + (c.stale ? ' stale' : '');
      item.dataset.id = c.id;

      const head = document.createElement('div');
      head.className = 'item-head';
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(i + 1);
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = (c.side === 'removed' ? 'removed · HEAD ' : '') + lineLabel(c.startLine, c.endLine);
      const actions = document.createElement('span');
      actions.className = 'actions';
      const edit = document.createElement('button');
      edit.className = 'link-btn';
      edit.textContent = 'Edit';
      const del = document.createElement('button');
      del.className = 'link-btn danger';
      del.textContent = 'Delete';
      actions.append(edit, del);
      head.append(badge, where, actions);

      const quote = document.createElement('div');
      quote.className = 'quote';
      quote.textContent = truncate(c.quote, 160);

      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = c.body;

      item.append(head, quote, body);
      if (c.stale) {
        const warn = document.createElement('div');
        warn.className = 'stale-note';
        warn.textContent = 'Quoted text not found in the current file. Line numbers may be outdated.';
        item.append(warn);
      }

      item.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest('button, textarea')) return;
        scrollToComment(c.id);
      });
      del.addEventListener('click', () => vscode.postMessage({ type: 'delete', id: c.id }));
      edit.addEventListener('click', () => editInPlace(item, body, c));
      list.append(item);
    });
  }

  /** @param {HTMLElement} item @param {HTMLElement} body @param {ReviewComment} c */
  function editInPlace(item, body, c) {
    const textarea = document.createElement('textarea');
    textarea.value = c.body;
    textarea.rows = 4;
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    const row = document.createElement('div');
    row.className = 'composer-actions';
    row.append(cancel, save);
    body.replaceWith(textarea);
    item.append(row);
    textarea.focus();
    const commit = () => {
      const value = textarea.value.trim();
      if (value && value !== c.body) vscode.postMessage({ type: 'update', id: c.id, body: value });
      else renderList();
    };
    save.addEventListener('click', commit);
    cancel.addEventListener('click', () => renderList());
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
      if (e.key === 'Escape') renderList();
    });
  }

  /** @param {string} id */
  function scrollToComment(id) {
    const card = /** @type {HTMLElement | null} */ (content.querySelector(`.ar-card[data-id="${id}"]`));
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(card);
  }

  /** @param {string} id */
  function focusListItem(id) {
    const item = /** @type {HTMLElement | null} */ (list.querySelector(`.item[data-id="${id}"]`));
    if (!item) return;
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    flash(item);
  }

  /** @param {HTMLElement} el */
  function flash(el) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  // ---------- selecting and commenting ----------

  function hideAddButton() {
    addBtn.hidden = true;
  }

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hideAddButton();
    const range = sel.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) return hideAddButton();

    const selected = allLeaves().flatMap((el) => {
      const part = selectedPartOf(range, el);
      return part ? [{ el, ...part }] : [];
    });
    if (!selected.length) return hideAddButton();
    // A selection crossing a removed hunk comments on the current text around it.
    const side = selected.some((s) => sideOf(s.el) === 'current') ? 'current' : 'removed';
    const hit = selected.filter((s) => sideOf(s.el) === side);
    const startLine = Math.min(...hit.map((s) => +(s.el.dataset.ls ?? 0)));
    const endLine = Math.max(...hit.map((s) => +(s.el.dataset.le ?? 0)));
    const sortLine = ghostAnchor(hit[0].el) ?? startLine;
    const quote = hit.map((s) => s.text).join('\n');
    pending = { side, startLine, endLine, sortLine, quote, range: range.cloneRange(), parts: hit.map((s) => s.range) };

    addBtn.textContent = `💬 Comment ${lineLabel(startLine, endLine)}`;
    addBtn.hidden = false;
    positionNear(addBtn, range.getBoundingClientRect());
  }

  /** @param {HTMLElement} el @param {DOMRect} rect */
  function positionNear(el, rect) {
    const width = el.offsetWidth || 160;
    const maxLeft = docPane.getBoundingClientRect().right - width - 8;
    el.style.left = `${Math.max(8, Math.min(rect.right - width / 2, maxLeft))}px`;
    el.style.top = `${rect.bottom + 6}px`;
  }

  function openComposer() {
    if (!pending) return;
    hideAddButton();
    const rect = pending.range.getBoundingClientRect();
    const where = (pending.side === 'removed' ? 'Removed text · HEAD ' : '') + lineLabel(pending.startLine, pending.endLine);
    $('composer-target').textContent = `${where} · “${truncate(pending.quote.replace(/\s+/g, ' '), 80)}”`;
    composer.hidden = false;
    composerInput.value = '';
    const paneRect = docPane.getBoundingClientRect();
    const width = Math.min(420, paneRect.width - 16);
    composer.style.width = `${width}px`;
    composer.style.left = `${Math.max(paneRect.left + 8, Math.min(rect.left, paneRect.right - width - 8))}px`;
    const top = rect.bottom + 8;
    composer.style.top = `${Math.min(top, window.innerHeight - 200)}px`;
    setPendingHighlight();
    window.getSelection()?.removeAllRanges();
    composerInput.focus();
  }

  function cancelComposer() {
    composer.hidden = true;
    pending = null;
    setPendingHighlight();
  }

  function saveComposer() {
    const body = composerInput.value.trim();
    if (!pending || !body) return;
    const { side, startLine, endLine, sortLine, quote } = pending;
    vscode.postMessage({ type: 'add', comment: { side, startLine, endLine, sortLine, quote, body } });
    cancelComposer();
  }

  document.addEventListener('mouseup', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.closest('#sidebar, #composer, #add-btn')) return;
    setTimeout(readSelection, 0);
  });
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey && e.key.startsWith('Arrow')) readSelection();
  });
  docPane.addEventListener('scroll', () => {
    hideAddButton();
    if (!composer.hidden && pending) {
      const rect = pending.range.getBoundingClientRect();
      composer.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 200)}px`;
    }
  });
  // Keep the selection alive when the button is pressed.
  addBtn.addEventListener('mousedown', (e) => e.preventDefault());
  addBtn.addEventListener('click', () => {
    if (pending) openComposer();
    else hideAddButton();
  });
  $('composer-save').addEventListener('click', saveComposer);
  $('composer-cancel').addEventListener('click', cancelComposer);
  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComposer();
    if (e.key === 'Escape') cancelComposer();
  });
  document.addEventListener('keydown', (e) => {
    // ⌘/Ctrl+Shift+M opens the composer for the current selection.
    if (e.key.toLowerCase() === 'm' && e.shiftKey && (e.metaKey || e.ctrlKey) && pending && composer.hidden) {
      e.preventDefault();
      openComposer();
    }
  });

  $('copy-btn').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  $('clear-btn').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  $('refresh-btn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  content.addEventListener('click', (e) => {
    const link = /** @type {HTMLElement} */ (e.target).closest('a[href]');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    vscode.postMessage({ type: 'openLink', href });
  });

  // ---------- messages from the extension ----------

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'render':
        renderDocument(msg);
        break;
      case 'comments':
        comments = msg.comments;
        decorate();
        renderList();
        if (needsReanchor) {
          needsReanchor = false;
          reanchor();
        }
        break;
      case 'error':
        $('error').textContent = msg.message;
        $('error').hidden = false;
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
