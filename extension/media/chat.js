// Webview client for a single Claude Persist session, styled after the
// official Claude Code extension: document-flow markdown, collapsible tool
// cards with IN/OUT sections, todo checklists, permission cards, and a
// composer with a bypass-permissions toggle.
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

  let streamingEl = null;
  let bypass = false;
  const toolCards = new Map(); // toolUseId -> { card, body, dot }

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

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------- minimal markdown renderer -------------------------------------
  // Input is escaped before any tag insertion, so only tags we emit exist.

  function inlineMd(escaped) {
    return escaped
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  }

  function renderMarkdown(md) {
    const root = el('div', 'md');
    const segments = md.split(/```/);
    for (let i = 0; i < segments.length; i++) {
      if (i % 2 === 1) {
        // fenced code block; first line may name the language
        const lines = segments[i].split('\n');
        if (lines.length > 1 && /^[\w+.-]*$/.test(lines[0].trim())) lines.shift();
        const pre = el('pre');
        pre.appendChild(el('code', null, lines.join('\n').replace(/\n$/, '')));
        root.appendChild(pre);
        continue;
      }
      const html = [];
      let list = null; // 'ul' | 'ol'
      const closeList = () => { if (list) { html.push(`</${list}>`); list = null; } };
      for (const rawLine of segments[i].split('\n')) {
        const line = rawLine;
        const esc = escapeHtml(line);
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        const ul = /^\s*[-*]\s+(.*)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (h) {
          closeList();
          html.push(`<h${h[1].length}>${inlineMd(escapeHtml(h[2]))}</h${h[1].length}>`);
        } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
          closeList();
          html.push('<hr>');
        } else if (ul) {
          if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
          html.push(`<li>${inlineMd(escapeHtml(ul[1]))}</li>`);
        } else if (ol) {
          if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
          html.push(`<li>${inlineMd(escapeHtml(ol[1]))}</li>`);
        } else if (/^\s*>\s?/.test(line)) {
          closeList();
          html.push(`<blockquote>${inlineMd(esc.replace(/^\s*&gt;\s?/, ''))}</blockquote>`);
        } else if (line.trim() === '') {
          closeList();
        } else {
          closeList();
          html.push(`<p>${inlineMd(esc)}</p>`);
        }
      }
      closeList();
      const wrap = el('div');
      wrap.innerHTML = html.join('');
      while (wrap.firstChild) root.appendChild(wrap.firstChild);
    }
    return root;
  }

  // ---------- streaming ------------------------------------------------------

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

  // ---------- tool rendering -------------------------------------------------

  function toolDescription(name, input) {
    if (!input || typeof input !== 'object') return '';
    if (typeof input.description === 'string') return input.description;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    if (typeof input.pattern === 'string') return input.pattern;
    if (typeof input.command === 'string') return input.command.split('\n')[0];
    if (typeof input.url === 'string') return input.url;
    if (typeof input.query === 'string') return input.query;
    if (typeof input.prompt === 'string') return input.prompt.slice(0, 120);
    return '';
  }

  function toolInputPreview(name, input) {
    if (input && typeof input === 'object') {
      if (typeof input.command === 'string') return input.command;
      if (name === 'Edit' && typeof input.old_string === 'string') {
        return `--- old\n${input.old_string}\n+++ new\n${input.new_string ?? ''}`;
      }
      if (typeof input.content === 'string' && typeof input.file_path === 'string') {
        return input.content;
      }
    }
    return pretty(input, 3000);
  }

  function ioRow(label, text, isError) {
    const row = el('div', 'io-row' + (isError ? ' err' : ''));
    row.appendChild(el('span', 'io-label', label));
    row.appendChild(el('pre', 'io-pre', text));
    return row;
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
    const desc = toolDescription(event.toolName, event.input);
    if (desc) head.appendChild(el('span', 'tool-desc', desc));
    else head.appendChild(el('span', 'tool-desc', ''));
    head.appendChild(el('span', 'chevron', '▸'));
    card.appendChild(head);

    const body = el('div', 'tool-body');
    body.appendChild(ioRow('IN', toolInputPreview(event.toolName, event.input), false));
    card.appendChild(body);

    head.addEventListener('click', () => card.classList.toggle('open'));
    threadEl.appendChild(card);
    if (event.toolUseId) toolCards.set(event.toolUseId, { card, body, dot });
  }

  function renderToolResult(event) {
    const entry = event.toolUseId ? toolCards.get(event.toolUseId) : undefined;
    if (entry) {
      entry.body.appendChild(ioRow('OUT', event.summary, event.isError));
      entry.dot.classList.remove('spin');
      entry.dot.classList.add(event.isError ? 'err' : 'ok');
      return;
    }
    // Result with no matching card (old logs) — standalone collapsed card.
    const card = el('div', 'tool-card');
    const head = el('div', 'tool-head');
    const dot = el('span', 'dot ' + (event.isError ? 'err' : 'ok'));
    head.appendChild(dot);
    head.appendChild(el('span', 'tool-name', event.isError ? 'tool error' : 'tool result'));
    head.appendChild(el('span', 'tool-desc', ''));
    head.appendChild(el('span', 'chevron', '▸'));
    const body = el('div', 'tool-body');
    body.appendChild(ioRow('OUT', event.summary, event.isError));
    card.appendChild(head);
    card.appendChild(body);
    head.addEventListener('click', () => card.classList.toggle('open'));
    threadEl.appendChild(card);
  }

  // ---------- event rendering ------------------------------------------------

  function renderEvent(event) {
    switch (event.type) {
      case 'user_message': {
        endStreaming();
        threadEl.appendChild(el('div', 'user-msg', event.text));
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
        card.appendChild(ioRow('IN', toolInputPreview(event.toolName, event.input), false));
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
        if (typeof event.costUsd === 'number') bits.push(`$${event.costUsd.toFixed(4)}`);
        threadEl.appendChild(el('div', 'meta', bits.length ? bits.join(' · ') : 'done'));
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

  // ---------- inbound messages -----------------------------------------------

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
    }
  });

  // ---------- composer ---------------------------------------------------------

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    inputEl.value = '';
    autosize();
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.38)}px`;
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
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
