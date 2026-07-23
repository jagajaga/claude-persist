// Webview client for a single Claude Persist session, styled after the
// official Claude Code extension. Markdown via marked + DOMPurify (vendored),
// collapsible tool cards with IN/OUT, inline diffs for Edit/Write, clickable
// file paths, todo checklists, attachments, permission cards, and a context
// ring that compacts the conversation on click.
(function () {
  const vscode = acquireVsCodeApi();
  const sessionId = document.body.dataset.sessionId;
  vscode.setState({ sessionId });

  const messagesEl = document.getElementById('messages');
  const threadEl = document.getElementById('thread');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const statusLine = document.getElementById('status-line');
  const statusText = document.getElementById('status-text');
  const permToggle = document.getElementById('perm-toggle');
  const attachBtn = document.getElementById('attach');
  const chipsEl = document.getElementById('chips');
  const ringBtn = document.getElementById('context-ring');

  const RING_CIRCUMFERENCE = 47.1;
  let contextWindow = 1000000; // default 1M; overwritten by the SDK's reported window

  let streamingEl = null;
  let bypass = false;
  const toolCards = new Map(); // toolUseId -> { body, dot }

  // ---------- helpers -------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function pretty(value, max) {
    let text;
    if (typeof value === 'string') text = value;
    else {
      try { text = JSON.stringify(value, null, 2); } catch { text = String(value); }
    }
    if (max && text.length > max) text = text.slice(0, max) + '\n… [truncated]';
    return text;
  }

  function fileLink(pathText, display) {
    const link = el('a', 'file-link', display ?? pathText);
    link.href = '#';
    link.title = pathText;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'openFile', path: pathText });
    });
    return link;
  }

  // ---------- markdown (marked + DOMPurify, vendored) ------------------------

  let markedConfigured = false;
  function renderMarkdown(md) {
    const root = el('div', 'md');
    if (window.marked && window.DOMPurify) {
      if (!markedConfigured) {
        window.marked.use({ gfm: true, breaks: true });
        markedConfigured = true;
      }
      root.innerHTML = window.DOMPurify.sanitize(window.marked.parse(md));
      // Horizontal scroll containment for wide tables.
      for (const table of Array.from(root.querySelectorAll('table'))) {
        const wrap = el('div', 'table-wrap');
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
      }
    } else {
      const pre = el('pre');
      pre.appendChild(el('code', null, md));
      root.appendChild(pre);
    }
    return root;
  }

  // ---------- streaming / status --------------------------------------------

  function endStreaming() {
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      streamingEl = null;
    }
  }

  function setRunning(running, detail) {
    statusLine.hidden = !running;
    if (running) statusText.textContent = detail || 'Working…';
  }

  function updateRing(tokens, windowSize) {
    if (typeof windowSize === 'number' && windowSize > 0) contextWindow = windowSize;
    if (typeof tokens !== 'number' || tokens <= 0) return;
    const pct = Math.min(1, tokens / contextWindow);
    ringBtn.hidden = false;
    const fg = ringBtn.querySelector('.ring-fg');
    fg.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE * (1 - pct)));
    ringBtn.classList.toggle('warn', pct >= 0.7 && pct < 0.9);
    ringBtn.classList.toggle('hot', pct >= 0.9);
    const pctText = pct < 0.01 ? '<1' : String(Math.round(pct * 100));
    ringBtn.title = `Context: ~${pctText}% of ${Math.round(contextWindow / 1000)}k tokens — click to compact`;
  }

  // ---------- diff rendering --------------------------------------------------

  function diffBlock(oldText, newText) {
    const pre = el('pre', 'io-pre diff');
    const addLines = (text, cls, prefix) => {
      for (const line of String(text ?? '').split('\n')) {
        pre.appendChild(el('span', `diff-line ${cls}`, prefix + line));
      }
    };
    addLines(oldText, 'del', '- ');
    addLines(newText, 'add', '+ ');
    return pre;
  }

  function newFileBlock(content) {
    const pre = el('pre', 'io-pre diff');
    for (const line of String(content ?? '').split('\n')) {
      pre.appendChild(el('span', 'diff-line add', '+ ' + line));
    }
    return pre;
  }

  // ---------- tool cards -------------------------------------------------------

  function toolDescription(input) {
    if (!input || typeof input !== 'object') return { text: '', path: null };
    if (typeof input.file_path === 'string') return { text: input.file_path, path: input.file_path };
    if (typeof input.path === 'string') return { text: input.path, path: input.path };
    if (typeof input.description === 'string') return { text: input.description, path: null };
    if (typeof input.command === 'string') return { text: input.command.split('\n')[0], path: null };
    if (typeof input.pattern === 'string') return { text: input.pattern, path: null };
    if (typeof input.url === 'string') return { text: input.url, path: null };
    if (typeof input.query === 'string') return { text: input.query, path: null };
    if (typeof input.prompt === 'string') return { text: input.prompt.slice(0, 120), path: null };
    return { text: '', path: null };
  }

  function buildToolBody(name, input) {
    const body = el('div', 'tool-body');
    if (name === 'Edit' && input && typeof input.old_string === 'string') {
      const row = el('div', 'io-row');
      row.appendChild(el('span', 'io-label', 'DIFF'));
      row.appendChild(diffBlock(input.old_string, input.new_string));
      body.appendChild(row);
      return body;
    }
    if (name === 'Write' && input && typeof input.content === 'string') {
      const row = el('div', 'io-row');
      row.appendChild(el('span', 'io-label', 'NEW'));
      row.appendChild(newFileBlock(input.content));
      body.appendChild(row);
      return body;
    }
    const inText = input && typeof input === 'object' && typeof input.command === 'string'
      ? input.command
      : pretty(input, 3000);
    const row = el('div', 'io-row');
    row.appendChild(el('span', 'io-label', 'IN'));
    row.appendChild(el('pre', 'io-pre', inText));
    body.appendChild(row);
    return body;
  }

  function renderTodoCard(input) {
    const card = el('div', 'tool-card todo-card');
    card.appendChild(el('div', 'todo-title', 'Update Todos'));
    const todos = input && Array.isArray(input.todos) ? input.todos : [];
    for (const todo of todos) {
      const status = todo.status === 'completed' ? 'done'
        : todo.status === 'in_progress' ? 'active' : '';
      const item = el('div', `todo-item ${status}`);
      item.appendChild(el('span', 'todo-check'));
      item.appendChild(el('span', 'todo-text',
        status === 'active' && todo.activeForm ? todo.activeForm : String(todo.content ?? '')));
      card.appendChild(item);
    }
    threadEl.appendChild(card);
  }

  function renderToolUse(event) {
    endStreaming();
    if (event.toolName === 'TodoWrite') {
      renderTodoCard(event.input);
      return;
    }
    const card = el('div', 'tool-card');
    const head = el('div', 'tool-head');
    const dot = el('span', 'dot spin');
    head.appendChild(dot);
    head.appendChild(el('span', 'tool-name', event.toolName));
    const desc = toolDescription(event.input);
    if (desc.path) {
      const descWrap = el('span', 'tool-desc');
      descWrap.appendChild(fileLink(desc.path));
      head.appendChild(descWrap);
    } else {
      head.appendChild(el('span', 'tool-desc', desc.text));
    }
    head.appendChild(el('span', 'chevron', '▸'));
    card.appendChild(head);

    const body = buildToolBody(event.toolName, event.input);
    card.appendChild(body);
    head.addEventListener('click', () => card.classList.toggle('open'));
    threadEl.appendChild(card);
    if (event.toolUseId) toolCards.set(event.toolUseId, { body, dot });
  }

  function renderToolResult(event) {
    const entry = event.toolUseId ? toolCards.get(event.toolUseId) : undefined;
    if (entry) {
      const row = el('div', 'io-row' + (event.isError ? ' err' : ''));
      row.appendChild(el('span', 'io-label', 'OUT'));
      row.appendChild(el('pre', 'io-pre', event.summary));
      entry.body.appendChild(row);
      entry.dot.classList.remove('spin');
      entry.dot.classList.add(event.isError ? 'err' : 'ok');
      return;
    }
    const card = el('div', 'tool-card');
    const head = el('div', 'tool-head');
    head.appendChild(el('span', 'dot ' + (event.isError ? 'err' : 'ok')));
    head.appendChild(el('span', 'tool-name', event.isError ? 'tool error' : 'tool result'));
    head.appendChild(el('span', 'tool-desc', ''));
    head.appendChild(el('span', 'chevron', '▸'));
    const body = el('div', 'tool-body');
    const row = el('div', 'io-row' + (event.isError ? ' err' : ''));
    row.appendChild(el('span', 'io-label', 'OUT'));
    row.appendChild(el('pre', 'io-pre', event.summary));
    body.appendChild(row);
    card.appendChild(head);
    card.appendChild(body);
    head.addEventListener('click', () => card.classList.toggle('open'));
    threadEl.appendChild(card);
  }

  // ---------- events ------------------------------------------------------------

  function renderEvent(event) {
    switch (event.type) {
      case 'user_message': {
        endStreaming();
        const box = el('div', 'user-msg');
        box.appendChild(el('div', null, event.text));
        if (Array.isArray(event.attachments) && event.attachments.length) {
          const row = el('div', 'user-chips');
          for (const a of event.attachments) {
            if (a.kind === 'file') {
              const chip = el('span', 'chip');
              chip.appendChild(fileLink(a.label));
              row.appendChild(chip);
            } else {
              row.appendChild(el('span', 'chip', `🖼 ${a.label}`));
            }
          }
          box.appendChild(row);
        }
        threadEl.appendChild(box);
        break;
      }
      case 'assistant_text': {
        const rendered = renderMarkdown(event.text);
        if (streamingEl) {
          streamingEl.replaceChildren(rendered);
          endStreaming();
        } else {
          const wrap = el('div', 'assistant');
          wrap.appendChild(rendered);
          threadEl.appendChild(wrap);
        }
        break;
      }
      case 'tool_use':
        renderToolUse(event);
        break;
      case 'tool_result':
        renderToolResult(event);
        break;
      case 'permission_request': {
        endStreaming();
        const card = el('div', 'permission');
        card.dataset.requestId = event.requestId;
        card.appendChild(el('div', 'perm-title', `Allow ${event.toolName}?`));
        const body = buildToolBody(event.toolName, event.input);
        body.style.display = 'block';
        card.appendChild(body);
        const actions = el('div', 'perm-actions');
        const allow = el('button', null, 'Allow');
        const deny = el('button', 'secondary', 'Deny');
        allow.addEventListener('click', () =>
          vscode.postMessage({ type: 'permission', requestId: event.requestId, allow: true }));
        deny.addEventListener('click', () =>
          vscode.postMessage({ type: 'permission', requestId: event.requestId, allow: false }));
        actions.appendChild(allow);
        actions.appendChild(deny);
        card.appendChild(actions);
        card.appendChild(el('div', 'perm-note',
          'Waiting for you — this survives reloads; answer whenever.'));
        threadEl.appendChild(card);
        break;
      }
      case 'permission_resolved': {
        const card = threadEl.querySelector(`.permission[data-request-id="${event.requestId}"]`);
        if (card) {
          card.classList.add('resolved');
          const note = card.querySelector('.perm-note');
          if (note) note.textContent = event.allowed ? 'Allowed' : 'Denied';
        }
        break;
      }
      case 'status': {
        if (event.status === 'running') setRunning(true);
        else {
          endStreaming();
          setRunning(false);
          if (event.status === 'error') {
            threadEl.appendChild(el('div', 'meta error', `⚠ ${event.detail || 'error'}`));
          }
        }
        break;
      }
      case 'result': {
        endStreaming();
        const bits = [];
        if (typeof event.durationMs === 'number') bits.push(`${(event.durationMs / 1000).toFixed(1)}s`);
        if (typeof event.contextTokens === 'number') {
          bits.push(
            event.contextTokens >= 1000
              ? `${(event.contextTokens / 1000).toFixed(1)}k tokens`
              : `${event.contextTokens} tokens`,
          );
        }
        threadEl.appendChild(el('div', 'meta', bits.length ? bits.join(' · ') : 'done'));
        updateRing(event.contextTokens, event.contextWindow);
        setRunning(false);
        break;
      }
    }
    scrollToBottom();
  }

  function applyPermissionMode(mode) {
    bypass = mode === 'bypassPermissions';
    permToggle.classList.toggle('active', bypass);
  }

  function renderChips(items) {
    chipsEl.replaceChildren();
    chipsEl.hidden = items.length === 0;
    items.forEach((item, index) => {
      const chip = el('span', 'chip');
      chip.appendChild(el('span', null, `${item.kind === 'image' ? '🖼 ' : '📄 '}${item.label}`));
      const remove = el('button', 'chip-x', '×');
      remove.addEventListener('click', () =>
        vscode.postMessage({ type: 'removeAttachment', index }));
      chip.appendChild(remove);
      chipsEl.appendChild(chip);
    });
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'replay': {
        for (const persisted of msg.events) renderEvent(persisted.event);
        if (msg.info) {
          setRunning(msg.info.status === 'running');
          applyPermissionMode(msg.info.permissionMode);
        }
        scrollToBottom();
        break;
      }
      case 'event':
        renderEvent(msg.event.event);
        break;
      case 'delta': {
        if (!streamingEl) {
          streamingEl = el('div', 'assistant streaming', '');
          threadEl.appendChild(streamingEl);
          setRunning(true);
        }
        streamingEl.textContent += msg.text;
        scrollToBottom();
        break;
      }
      case 'attachments':
        renderChips(msg.items ?? []);
        break;
    }
  });

  // ---------- composer -----------------------------------------------------------

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    // Optimistic: show the working indicator immediately, before the daemon's
    // status event makes the round trip.
    setRunning(true);
    inputEl.value = '';
    autosize();
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.38)}px`;
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment' }));
  ringBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'compact' });
  });
  permToggle.addEventListener('click', () => {
    bypass = !bypass;
    permToggle.classList.toggle('active', bypass);
    vscode.postMessage({
      type: 'setPermissionMode',
      mode: bypass ? 'bypassPermissions' : 'default',
    });
  });
  inputEl.addEventListener('input', autosize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
