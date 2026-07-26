// Webview client for a single Claude Persist session, styled after the
// official Claude Code extension. Markdown via marked + DOMPurify (vendored),
// collapsible tool cards with IN/OUT, inline diffs for Edit/Write, clickable
// file paths, todo checklists, attachments, permission cards, and a context
// ring that compacts the conversation on click.
(function () {
  const vscode = acquireVsCodeApi();
  const sessionId = document.body.dataset.sessionId;
  vscode.setState({ sessionId });

  // Surface webview crashes as a VS Code notification instead of a silently
  // blank panel (see the duplicated-declaration incident, v0.5.1).
  window.addEventListener('error', (e) => {
    vscode.postMessage({ type: 'clientError', message: `${e.message} (${e.filename}:${e.lineno})` });
  });

  const messagesEl = document.getElementById('messages');
  const threadEl = document.getElementById('thread');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const permToggle = document.getElementById('perm-toggle');
  const attachBtn = document.getElementById('attach');
  const chipsEl = document.getElementById('chips');
  const ringBtn = document.getElementById('context-ring');
  const modelSelect = document.getElementById('model-select');
  const effortSelect = document.getElementById('effort-select');
  const promptBar = document.getElementById('prompt-bar');

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

  // "Pinned" scrolling: while the user is at (or near) the bottom, keep them
  // there through input growth, viewport resizes (mobile keyboard!), and new
  // content. If they scrolled up to read, leave them alone.
  let pinned = true;
  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  }
  messagesEl.addEventListener('scroll', () => {
    pinned = isNearBottom();
  });
  window.addEventListener('resize', () => {
    if (pinned) scrollToBottom();
  });

  // Sticky bar showing the last user prompt whenever it has scrolled out of
  // view; clicking jumps back to where the current exchange started.
  let lastUserEl = null;
  const promptObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) promptBar.hidden = entry.isIntersecting;
    },
    { root: messagesEl },
  );
  function trackUserMessage(box, text) {
    lastUserEl = box;
    promptBar.textContent = text.length > 160 ? `${text.slice(0, 160)}…` : text;
    promptObserver.disconnect();
    promptObserver.observe(box);
  }
  promptBar.addEventListener('click', () => {
    if (!lastUserEl) return;
    pinned = false;
    lastUserEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

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

  let workingRow = null;
  function setRunning(running, detail) {
    // Single inline indicator riding at the bottom of the conversation:
    // spinner + label + Stop.
    if (running) {
      if (!workingRow) {
        workingRow = el('div', 'working-row');
        workingRow.appendChild(el('span', 'spinner'));
        workingRow.appendChild(el('span', 'working-text', ''));
        const stop = el('button', 'pill', 'Stop');
        stop.addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
        workingRow.appendChild(stop);
      }
      workingRow.querySelector('.working-text').textContent = detail || 'Working…';
      threadEl.appendChild(workingRow); // appending moves it to the end
    } else if (workingRow) {
      workingRow.remove();
    }
  }

  /** Keep the inline working indicator below the newest content. */
  function keepWorkingLast() {
    if (workingRow && workingRow.parentNode === threadEl) threadEl.appendChild(workingRow);
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

  // ---------- question cards (AskUserQuestion) ---------------------------------

  function renderQuestionCard(event) {
    const card = el('div', 'permission question');
    card.dataset.requestId = event.requestId;
    const answers = {}; // question -> label(s)
    const picked = {}; // question -> Set for multiSelect

    const submit = el('button', null, 'Answer');
    submit.disabled = true;

    const refresh = () => {
      submit.disabled = event.questions.some((q) => {
        const value = q.multiSelect ? (picked[q.question] || new Set()).size === 0 : !answers[q.question];
        return value;
      });
      // Single question, single select: answer immediately on click.
      if (!submit.disabled && event.questions.length === 1 && !event.questions[0].multiSelect) {
        send();
      }
    };

    const send = () => {
      for (const q of event.questions) {
        if (q.multiSelect) answers[q.question] = [...(picked[q.question] || [])].join(', ');
      }
      vscode.postMessage({ type: 'permission', requestId: event.requestId, allow: true, answers });
      submit.disabled = true;
    };

    for (const q of event.questions) {
      const block = el('div', 'q-block');
      const head = el('div', 'q-head');
      head.appendChild(el('span', 'q-chip', q.header || 'Question'));
      block.appendChild(head);
      block.appendChild(el('div', 'q-text', q.question));
      const opts = el('div', 'q-options');
      for (const option of q.options || []) {
        const btn = el('button', 'opt-btn', option.label);
        if (option.description) btn.title = option.description;
        btn.addEventListener('click', () => {
          if (q.multiSelect) {
            const set = (picked[q.question] ||= new Set());
            if (set.has(option.label)) {
              set.delete(option.label);
              btn.classList.remove('selected');
            } else {
              set.add(option.label);
              btn.classList.add('selected');
            }
          } else {
            answers[q.question] = option.label;
            for (const other of opts.querySelectorAll('.opt-btn')) other.classList.remove('selected');
            btn.classList.add('selected');
          }
          refresh();
        });
        opts.appendChild(btn);
      }
      // Free-text "Other" answer, provided automatically per the tool contract.
      const otherBtn = el('button', 'opt-btn other', 'Other…');
      const otherInput = el('input', 'other-input');
      otherInput.placeholder = 'Type your own answer, Enter to set';
      otherInput.hidden = true;
      otherBtn.addEventListener('click', () => {
        otherInput.hidden = false;
        otherInput.focus();
      });
      otherInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && otherInput.value.trim()) {
          const text = otherInput.value.trim();
          if (q.multiSelect) (picked[q.question] ||= new Set()).add(text);
          else answers[q.question] = text;
          for (const other of opts.querySelectorAll('.opt-btn')) other.classList.remove('selected');
          otherBtn.classList.add('selected');
          otherBtn.textContent = text;
          refresh();
        }
      });
      opts.appendChild(otherBtn);
      block.appendChild(opts);
      block.appendChild(otherInput);
      card.appendChild(block);
    }

    const actions = el('div', 'perm-actions');
    if (!(event.questions.length === 1 && !event.questions[0].multiSelect)) {
      actions.appendChild(submit);
    }
    submit.addEventListener('click', send);
    card.appendChild(actions);
    card.appendChild(el('div', 'perm-note', 'Claude is waiting for your answer — survives reloads.'));
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
        trackUserMessage(box, event.text);
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
      case 'question_request': {
        endStreaming();
        renderQuestionCard(event);
        break;
      }
      case 'permission_resolved': {
        const card = threadEl.querySelector(`.permission[data-request-id="${event.requestId}"]`);
        if (card) {
          card.classList.add('resolved');
          const note = card.querySelector('.perm-note');
          if (note) {
            note.textContent = event.answers
              ? Object.entries(event.answers).map(([, v]) => v).join(' · ')
              : event.allowed ? 'Allowed' : 'Denied';
          }
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
        if (typeof event.turnTokens === 'number') {
          bits.push(
            event.turnTokens >= 1000
              ? `${(event.turnTokens / 1000).toFixed(1)}k tokens`
              : `${event.turnTokens} tokens`,
          );
        }
        threadEl.appendChild(el('div', 'meta', bits.length ? bits.join(' · ') : 'done'));
        updateRing(event.contextTokens, event.contextWindow);
        setRunning(false);
        break;
      }
    }
    keepWorkingLast();
    if (pinned) scrollToBottom();
  }

  function applyPermissionMode(mode) {
    bypass = mode === 'bypassPermissions';
    permToggle.classList.toggle('active', bypass);
  }

  // ---------- dynamic model / effort options (from the SDK, never hardcoded) --

  const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  let modelInfos = [];

  function setOptionList(select, defaultLabel, entries, current) {
    select.replaceChildren();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = defaultLabel;
    select.appendChild(def);
    for (const entry of entries) {
      const opt = document.createElement('option');
      opt.value = entry.value;
      opt.textContent = entry.label;
      if (entry.title) opt.title = entry.title;
      select.appendChild(opt);
    }
    // Keep a persisted value visible even if it's not in the reported list.
    if (current && ![...select.options].some((o) => o.value === current)) {
      const opt = document.createElement('option');
      opt.value = current;
      opt.textContent = current;
      select.appendChild(opt);
    }
    select.value = current || '';
  }

  function rebuildModelOptions(current) {
    setOptionList(
      modelSelect,
      'model: default',
      modelInfos
        .filter((m) => m.value !== 'default') // our '' option already means default
        .map((m) => ({
          value: m.value,
          label: m.displayName || m.value,
          title: m.description,
        })),
      current !== undefined ? current : modelSelect.value,
    );
  }

  function rebuildEffortOptions(current) {
    const selected = modelInfos.find((m) => m.value === modelSelect.value);
    const levels =
      selected && Array.isArray(selected.effortLevels) && selected.effortLevels.length
        ? selected.effortLevels
        : ALL_EFFORTS;
    setOptionList(
      effortSelect,
      'effort: default',
      levels.map((l) => ({ value: l, label: l })),
      current !== undefined ? current : effortSelect.value,
    );
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
        for (const persisted of msg.events) {
          // One malformed event must never blank the whole transcript.
          try {
            renderEvent(persisted.event);
          } catch (err) {
            console.error('render failed for event', persisted.seq, err);
          }
        }
        if (msg.info) {
          setRunning(msg.info.status === 'running');
          applyPermissionMode(msg.info.permissionMode);
          rebuildModelOptions(msg.info.model || '');
          rebuildEffortOptions(msg.info.effort || '');
        }
        pinned = true;
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
        keepWorkingLast();
        if (pinned) scrollToBottom();
        break;
      }
      case 'attachments':
        renderChips(msg.items ?? []);
        break;
      case 'models':
        modelInfos = msg.models ?? [];
        rebuildModelOptions();
        rebuildEffortOptions();
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
    // The growing composer shrinks the messages area; keep the conversation
    // pinned to the bottom so the last lines stay visible while typing.
    if (pinned) scrollToBottom();
  }

  // ---------- attachments from this device (browser) --------------------------

  const MAX_UPLOAD = 10 * 1024 * 1024;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  const attachMenu = el('div', 'attach-menu');
  attachMenu.hidden = true;
  const ICON_DEVICE =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 1.5 4.7 4.8l1 1L7.3 4.2V10h1.4V4.2l1.6 1.6 1-1L8 1.5zM3 9v4.5h10V9h-1.4v3.1H4.4V9H3z"/></svg>';
  const ICON_SERVER =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M1.5 3.2 2.7 2h3.1l1.2 1.2H14a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V3.2zm1.4.3v8.9h10.2V4.6H6.4L5.2 3.5H2.9z"/></svg>';
  const deviceBtn = el('button', 'menu-item');
  deviceBtn.innerHTML = `${ICON_DEVICE}<span>Upload from this device</span>`;
  const serverBtn = el('button', 'menu-item');
  serverBtn.innerHTML = `${ICON_SERVER}<span>Browse server files</span>`;
  attachMenu.appendChild(deviceBtn);
  attachMenu.appendChild(serverBtn);
  document.getElementById('composer').appendChild(attachMenu);

  function hideMenu() {
    attachMenu.hidden = true;
  }

  function sendFiles(files) {
    for (const file of files) {
      if (file.size > MAX_UPLOAD) {
        vscode.postMessage({
          type: 'notify',
          message: `${file.name} is over 10 MB — too large to upload from the browser`,
        });
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = String(reader.result).split(',')[1] || '';
        vscode.postMessage({
          type: 'uploadAttachment',
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          data: base64,
        });
      };
      reader.readAsDataURL(file);
    }
  }

  fileInput.addEventListener('change', () => {
    sendFiles([...fileInput.files]);
    fileInput.value = '';
  });
  deviceBtn.addEventListener('click', () => {
    hideMenu();
    fileInput.click();
  });
  serverBtn.addEventListener('click', () => {
    hideMenu();
    vscode.postMessage({ type: 'pickAttachment' });
  });
  document.addEventListener('click', (e) => {
    if (!attachMenu.hidden && !attachMenu.contains(e.target) && e.target !== attachBtn) hideMenu();
  });

  // Paste an image/file straight into the input.
  inputEl.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      sendFiles(files);
    }
  });
  // Drag & drop anywhere onto the chat.
  document.body.addEventListener('dragover', (e) => e.preventDefault());
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) sendFiles(files);
  });

  sendBtn.addEventListener('click', send);
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachMenu.hidden = !attachMenu.hidden;
  });
  ringBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'compact' });
  });
  modelSelect.addEventListener('change', () => {
    vscode.postMessage({ type: 'setOptions', model: modelSelect.value });
    // Effort choices depend on the selected model.
    rebuildEffortOptions();
  });
  effortSelect.addEventListener('change', () =>
    vscode.postMessage({ type: 'setOptions', effort: effortSelect.value }));
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
