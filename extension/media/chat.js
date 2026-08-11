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
  const agentsChip = document.getElementById('agents-chip');
  const agentsCount = document.getElementById('agents-count');
  const attachBtn = document.getElementById('attach');
  const chipsEl = document.getElementById('chips');
  const ringBtn = document.getElementById('context-ring');
  const modelPill = document.getElementById('model-pill');
  const modelPillLabel = document.getElementById('model-pill-label');
  const promptBar = document.getElementById('prompt-bar');
  const branchChip = document.getElementById('branch-chip');

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

  // Mobile keyboards shrink the visual viewport without changing layout height,
  // which leaves the composer hidden behind the keyboard. Constrain the body to
  // the actually-visible height so the input stays above the keyboard.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fitViewport = () => {
      document.body.style.height = `${vv.height}px`;
      if (pinned) scrollToBottom();
    };
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
    fitViewport();
  }
  // When the field gains focus (keyboard opening), force the composer into
  // view. The webview is an iframe inside code-server's page, so we rely on
  // scrollIntoView propagating to the top-level viewport — and mobile keyboard
  // animations settle late, so repeat until they do.
  function revealComposer() {
    for (const delay of [50, 250, 600, 1100]) {
      setTimeout(() => {
        if (document.activeElement !== inputEl) return;
        if (pinned) scrollToBottom();
        document.getElementById('composer').scrollIntoView({ block: 'end' });
      }, delay);
    }
  }
  inputEl.addEventListener('focus', revealComposer);
  inputEl.addEventListener('input', () => {
    // Keep the composer revealed while typing grows the box.
    if (document.activeElement === inputEl) {
      document.getElementById('composer').scrollIntoView({ block: 'end' });
    }
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

  /**
   * Voice/AI keyboards on mobile sometimes insert literal "\n" sequences
   * instead of newlines. Unescape for display ONLY when the message looks
   * dictated (no real newlines, several literal \n) — a message genuinely
   * discussing "\n" (this is a coding tool) stays untouched, and the stored
   * text is never modified.
   */
  function displayUserText(text) {
    const t = String(text ?? '');
    if (!t.includes('\n') && (t.match(/\\n/g) || []).length >= 2) {
      return t.replace(/\\n/g, '\n');
    }
    return t;
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

  /**
   * path -> webview URI for previewable images, sent by the host alongside any
   * message that mentions one. Only paths that exist and sit under a permitted
   * resource root appear here, so presence in this map means "safe to render".
   */
  const imageUris = new Map();
  function absorbImageUris(msg) {
    if (!msg || !msg.imageUris) return;
    for (const [p, uri] of Object.entries(msg.imageUris)) imageUris.set(p, uri);
  }

  /** Full-size overlay. Click anywhere (or Escape) to dismiss. */
  function openLightbox(uri, caption) {
    const overlay = el('div', 'lightbox');
    const img = el('img');
    img.src = uri;
    img.alt = caption || '';
    overlay.appendChild(img);
    if (caption) overlay.appendChild(el('div', 'lightbox-caption', caption));
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }

  /**
   * A clickable thumbnail, or null when this path has no preview available
   * (not an image, missing, too large, or outside a permitted root).
   */
  function imageThumb(pathText, label) {
    const uri = imageUris.get(pathText);
    if (!uri) return null;
    const wrap = el('span', 'img-thumb');
    const img = el('img');
    img.src = uri;
    img.alt = label || pathText;
    img.title = `${pathText} — click to view`;
    // A file that disappears between send and render shouldn't leave a broken
    // icon; fall back to the plain link.
    img.addEventListener('error', () => {
      wrap.replaceWith(rawFileLink(pathText, label));
    });
    wrap.appendChild(img);
    wrap.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(uri, label || pathText);
    });
    return wrap;
  }

  function rawFileLink(pathText, display) {
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

  /**
   * A path in the chat: a thumbnail when it is a previewable image, else the
   * usual open-in-editor link. Single entry point so chips, tool results and
   * attachments all behave the same.
   */
  function fileLink(pathText, display) {
    return imageThumb(pathText, display) ?? rawFileLink(pathText, display);
  }

  // ---------- markdown (marked + DOMPurify, vendored) ------------------------

  let markedConfigured = false;
  /**
   * Turn any linkified image path in a rendered block into a thumbnail.
   *
   * Runs after markdown/DOMPurify so it only ever touches anchors the renderer
   * already produced, and only paths the host vouched for via imageUris.
   */
  function upgradeImageLinks(root) {
    for (const link of Array.from(root.querySelectorAll('a.file-link'))) {
      const p = link.getAttribute('title') || link.textContent || '';
      const thumb = imageThumb(p, p.split('/').pop());
      if (thumb) link.replaceWith(thumb);
    }
    if (imageUris.size) upgradeImagePathsInText(root);
  }

  /**
   * Replace bare image paths in rendered text with thumbnails.
   *
   * Markdown leaves a path like /tmp/shot.png as plain text, so there is no
   * anchor to upgrade — yet "saved to /tmp/shot.png" is exactly where a preview
   * is wanted. Only exact matches against paths the host vouched for are
   * touched, so this can never mangle unrelated prose, and <pre> blocks are left
   * alone: a path quoted in a code listing is being shown as text on purpose.
   */
  function upgradeImagePathsInText(root) {
    const paths = Array.from(imageUris.keys()).sort((a, b) => b.length - a.length);
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1) {
          if (child.tagName === 'PRE' || child.classList.contains('img-thumb')) continue;
          walk(child);
          continue;
        }
        if (child.nodeType !== 3) continue;
        const text = child.nodeValue;
        const hit = paths.find((p) => text.includes(p));
        if (!hit) continue;
        const thumb = imageThumb(hit, hit.split('/').pop());
        if (!thumb) continue;
        const at = text.indexOf(hit);
        const frag = document.createDocumentFragment();
        if (at > 0) frag.appendChild(document.createTextNode(text.slice(0, at)));
        frag.appendChild(thumb);
        const rest = text.slice(at + hit.length);
        if (rest) frag.appendChild(document.createTextNode(rest));
        child.replaceWith(frag);
        // The remainder may hold further paths; re-walk the parent to catch them.
        walk(node);
        return;
      }
    };
    walk(root);
  }

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
    upgradeImageLinks(root);
    return root;
  }

  // ---------- streaming / status --------------------------------------------

  // Live delta text is a PREVIEW: raw textContent, no markdown. The complete
  // block always arrives afterwards as an 'assistant_text' event, which is
  // what gets markdown-rendered. So a preview must never be left behind as
  // permanent DOM — releasing the reference without clearing it is what used
  // to strand raw '##'/'**' fragments, split mid-word at every tool call.
  let previewEls = [];
  // The raw buffer is the source of truth: once part of a preview is rendered
  // HTML, its textContent no longer round-trips. A WeakMap keeps a growing
  // multi-KB string out of the DOM.
  const previewRaw = new WeakMap();  // node -> accumulated raw text
  const previewStable = new WeakMap(); // node -> length of prefix already rendered
  let renderFrame = 0;

  function makePreview() {
    const node = el('div', 'assistant streaming');
    node.appendChild(el('div', 'stable'));
    node.appendChild(el('div', 'tail'));
    previewRaw.set(node, '');
    previewStable.set(node, -1);
    return node;
  }

  function appendPreviewText(node, text) {
    previewRaw.set(node, (previewRaw.get(node) || '') + text);
    scheduleRender();
  }

  function scheduleRender() {
    // Coalesce a burst of deltas into one parse — this is what keeps the
    // markdown re-render off the critical path on phones.
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(renderPreviews);
  }

  function cancelRender() {
    if (renderFrame) {
      cancelAnimationFrame(renderFrame);
      renderFrame = 0;
    }
  }

  function renderPreviews() {
    renderFrame = 0;
    for (const node of previewEls) {
      const raw = previewRaw.get(node) || '';
      const split = splitStreamingMarkdown(raw);
      const stableEl = node.firstChild;
      const tailEl = node.lastChild;
      // The stable prefix only ever grows, so equal length means equal text —
      // and re-parsing settled markdown is exactly the flicker we're avoiding.
      if (previewStable.get(node) !== split.stable.length) {
        if (split.stable) stableEl.replaceChildren(renderMarkdown(split.stable));
        else stableEl.replaceChildren();
        previewStable.set(node, split.stable.length);
      }
      tailEl.textContent = split.tail;
    }
    keepWorkingLast();
    if (pinned) scrollToBottom();
  }

  function endStreaming() {
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
      streamingEl = null;
    }
  }

  /** Drop preview fragments superseded by an authoritative assistant_text. */
  function dropPreviews() {
    cancelRender();
    for (const node of previewEls) node.remove();
    previewEls = [];
    streamingEl = null;
  }

  /**
   * Turn ended without an authoritative assistant_text (interrupt, error).
   * Render what streamed rather than discarding the user's text.
   */
  function settlePreviews() {
    cancelRender();
    for (const node of previewEls) {
      const raw = previewRaw.get(node) || '';
      if (raw.trim()) {
        node.classList.remove('streaming');
        node.replaceChildren(renderMarkdown(raw));
      } else {
        node.remove();
      }
    }
    previewEls = [];
    streamingEl = null;
  }

  let workingRow = null;
  /** When the turn now running began, so a stuck turn is obvious. */
  let runningSince = null;
  let elapsedTimer = null;

  /** "12s", "4m 12s", "1h 3m" — coarse enough to read at a glance. */
  function elapsedSince(startedAt) {
    const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  function paintElapsed() {
    if (!workingRow || runningSince === null) return;
    const label = workingRow.querySelector('.working-since');
    if (!label) return;
    const started = clockTime(runningSince);
    // Start time answers "when", elapsed answers "how long" — a turn that is
    // stuck needs both without doing arithmetic against the wall clock.
    label.textContent = started
      ? `${started} · ${elapsedSince(runningSince)}`
      : elapsedSince(runningSince);
  }

  function setRunning(running, detail, startedAt) {
    // Single inline indicator riding at the bottom of the conversation:
    // spinner + label + elapsed + Stop.
    if (running) {
      if (!workingRow) {
        workingRow = el('div', 'working-row');
        workingRow.appendChild(el('span', 'spinner'));
        workingRow.appendChild(el('span', 'working-text', ''));
        workingRow.appendChild(el('span', 'meta working-since', ''));
        const stop = el('button', 'pill', 'Stop');
        stop.addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
        workingRow.appendChild(stop);
      }
      // Only the first call starts the clock; later status events during the
      // same turn must not reset it.
      if (runningSince === null) runningSince = Number(startedAt) || Date.now();
      if (!elapsedTimer) elapsedTimer = setInterval(paintElapsed, 1000);
      workingRow.querySelector('.working-text').textContent = detail || 'Working…';
      paintElapsed();
      threadEl.appendChild(workingRow); // appending moves it to the end
    } else {
      runningSince = null;
      if (elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
      }
      if (workingRow) workingRow.remove();
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
    return card;
  }

  // ---------- events ------------------------------------------------------------

  /** HH:mm in local time — what "when was this sent" means to a reader. */
  function clockTime(ts) {
    const ms = Number(ts);
    // Guard falsy as well as NaN: a missing stamp coerces to 0, which would
    // render 1970 rather than nothing.
    if (!ms || Number.isNaN(ms)) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderEvent(event, ts) {
    switch (event.type) {
      case 'user_message': {
        endStreaming();
        const box = el('div', 'user-msg');
        const textEl = el('div', null, displayUserText(event.text));
        // User text is plain, not markdown, so it never passes through
        // renderMarkdown — upgrade it here or a path the user typed never previews.
        if (imageUris.size) upgradeImagePathsInText(textEl);
        box.appendChild(textEl);
        if (Array.isArray(event.attachments) && event.attachments.length) {
          const row = el('div', 'user-chips');
          for (const a of event.attachments) {
            const thumb = a.path ? imageThumb(a.path, a.label) : null;
            if (thumb) {
              row.appendChild(thumb);
            } else if (a.kind === 'file') {
              const chip = el('span', 'chip');
              chip.appendChild(fileLink(a.label));
              row.appendChild(chip);
            } else {
              row.appendChild(el('span', 'chip', `▣ ${a.label}`));
            }
          }
          box.appendChild(row);
        }
        threadEl.appendChild(box);
        trackUserMessage(box, displayUserText(event.text));
        break;
      }
      case 'assistant_text': {
        // Authoritative text for this block — supersedes every preview
        // fragment, including ones stranded above tool cards.
        dropPreviews();
        const wrap = el('div', 'assistant');
        wrap.appendChild(renderMarkdown(event.text));
        threadEl.appendChild(wrap);
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
        pinWaiting(event.requestId, `Allow ${event.toolName}?`, card);
        break;
      }
      case 'question_request': {
        endStreaming();
        const card = renderQuestionCard(event);
        const first = event.questions && event.questions[0];
        pinWaiting(event.requestId, first ? first.question : 'Claude asked a question', card);
        break;
      }
      case 'permission_resolved': {
        unpinWaiting(event.requestId);
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
        if (event.status === 'running') setRunning(true, event.detail, ts);
        else {
          settlePreviews();
          setRunning(false);
          if (event.status === 'error') {
            threadEl.appendChild(el('div', 'meta error', `⚠︎ ${event.detail || 'error'}`));
          }
        }
        break;
      }
      case 'result': {
        settlePreviews();
        const bits = [];
        // Sent-at time leads the line: it is the one part that answers "when",
        // and it reads naturally before the cost of the turn.
        const time = clockTime(ts);
        if (time) bits.push(time);
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
  let currentModel = '';
  let currentEffort = '';
  let accountInfos = [];

  const modelMenu = el('div', 'attach-menu model-menu');
  modelMenu.hidden = true;
  document.getElementById('composer').appendChild(modelMenu);

  function modelLabel(value) {
    if (!value) return 'default';
    const info = modelInfos.find((m) => m.value === value);
    return (info && info.displayName) || value;
  }

  /** Effort levels the selected model supports; the full set when unknown. */
  function effortLevels() {
    const info = modelInfos.find((m) => m.value === currentModel);
    return info && Array.isArray(info.effortLevels) && info.effortLevels.length
      ? info.effortLevels
      : ALL_EFFORTS;
  }

  function renderPill() {
    modelPillLabel.replaceChildren();
    modelPillLabel.appendChild(el('span', 'pill-model', modelLabel(currentModel)));
    // Separate span so narrow viewports can drop the effort and keep the model
    // name whole, rather than ellipsizing mid-token.
    if (currentEffort) {
      modelPillLabel.appendChild(el('span', 'pill-effort', ` · ${currentEffort}`));
    }
    modelPill.title = `Model: ${modelLabel(currentModel)} — Effort: ${currentEffort || 'default'}`;
  }

  function menuChoice(label, selected, onPick) {
    const btn = el('button', 'menu-item');
    btn.appendChild(el('span', 'menu-check', selected ? '✓' : ''));
    btn.appendChild(el('span', null, label));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick();
    });
    return btn;
  }

  function renderModelMenu() {
    modelMenu.replaceChildren();
    modelMenu.appendChild(el('div', 'menu-title', 'Model'));
    const models = [{ value: '', label: 'default' }].concat(
      modelInfos
        .filter((m) => m.value !== 'default') // our '' entry already means default
        .map((m) => ({ value: m.value, label: m.displayName || m.value })),
    );
    // A persisted model the SDK doesn't list must stay visible and selected.
    if (currentModel && !models.some((m) => m.value === currentModel)) {
      models.push({ value: currentModel, label: currentModel });
    }
    for (const entry of models) {
      modelMenu.appendChild(
        menuChoice(entry.label, entry.value === currentModel, () => {
          currentModel = entry.value;
          vscode.postMessage({ type: 'setOptions', model: currentModel });
          renderPill();
          // Effort levels depend on the model, so redraw and stay open: model
          // then effort is the common two-step.
          renderModelMenu();
        }),
      );
    }
    modelMenu.appendChild(el('div', 'menu-title', 'Effort'));
    const levels = effortLevels().slice();
    if (currentEffort && !levels.includes(currentEffort)) levels.push(currentEffort);
    const efforts = [{ value: '', label: 'default' }].concat(
      levels.map((l) => ({ value: l, label: l })),
    );
    for (const entry of efforts) {
      modelMenu.appendChild(
        menuChoice(entry.label, entry.value === currentEffort, () => {
          currentEffort = entry.value;
          vscode.postMessage({ type: 'setOptions', effort: currentEffort });
          renderPill();
          modelMenu.hidden = true;
        }),
      );
    }
    modelMenu.appendChild(el('div', 'menu-title', 'Account'));
    for (const account of accountInfos) {
      modelMenu.appendChild(
        menuChoice(account.name, account.active, () => {
          vscode.postMessage({ type: 'setAccount', configDir: account.configDir });
          modelMenu.hidden = true;
        }),
      );
    }
    modelMenu.appendChild(
      menuChoice('Log in to another account…', false, () => {
        vscode.postMessage({ type: 'addAccount' });
        modelMenu.hidden = true;
      }),
    );
  }

  // Where this conversation is working — not the window's repo, and not
  // necessarily the directory the session started in.
  function renderBranch(name, worktree, dir, held) {
    if (!name) {
      branchChip.hidden = true;
      return;
    }
    // The host already decided what this chip says: a worktree name when one is
    // in play, otherwise the branch. Distinct glyph for a worktree — a line
    // splitting off the main one.
    branchChip.textContent = `${worktree ? '⋔' : '⎇'} ${name}`;
    branchChip.classList.toggle('wt', !!worktree);
    const agents = Array.isArray(held) ? held : [];
    branchChip.title = agents.length
      ? `${dir}\nagent worktrees: ${agents.join(', ')}`
      : dir;
    branchChip.hidden = false;
  }

  // A long transcript is replayed in a window, newest first, because sending
  // and rendering tens of thousands of events blocks the webview outright.
  let loadEarlierRow = null;
  /** Seq of the oldest event currently rendered — the anchor when widening. */
  let firstRenderedSeq = null;
  /** Set while a "load earlier" round-trip is in flight. */
  let anchorSeq = null;
  function showLoadEarlier() {
    if (!loadEarlierRow) {
      loadEarlierRow = el('div', 'load-earlier');
      const btn = el('button', 'pill', 'Load earlier messages');
      btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Loading…';
        // Stay on the message being read: the widened replay re-renders the
        // whole thread, so remember where the current window began and scroll
        // back to it instead of landing at the bottom.
        anchorSeq = firstRenderedSeq;
        vscode.postMessage({ type: 'loadEarlier' });
      });
      loadEarlierRow.appendChild(btn);
    }
    threadEl.insertBefore(loadEarlierRow, threadEl.firstChild);
  }

  /** Drop every rendered event so a re-replay cannot duplicate the thread. */
  /**
   * Anything Claude is waiting on, pinned just above the composer.
   *
   * A permission or question card lives in the thread in chronological order,
   * but the conversation keeps scrolling while it waits — so the thing that
   * actually blocks progress scrolls out of sight and gets missed. The pin keeps
   * it next to the input until it is answered; the card itself stays where it is
   * so the transcript still reads in order.
   */
  const pinnedEl = document.getElementById('pinned');
  const waiting = new Map();

  function pinWaiting(requestId, label, card) {
    if (!requestId) return;
    waiting.set(requestId, { label, card });
    renderPinned();
  }

  function unpinWaiting(requestId) {
    if (!waiting.delete(requestId)) return;
    renderPinned();
  }

  function renderPinned() {
    pinnedEl.replaceChildren();
    // Only the oldest outstanding item: answering it usually unblocks the rest,
    // and a stack of pinned cards would eat the whole panel.
    const next = waiting.values().next();
    if (next.done) {
      pinnedEl.hidden = true;
      return;
    }
    const { label, card } = next.value;
    pinnedEl.hidden = false;
    const bar = el('div', 'pinned-bar');
    bar.appendChild(el('span', 'pinned-icon', '?'));
    bar.appendChild(el('span', 'pinned-label', label));
    if (waiting.size > 1) {
      bar.appendChild(el('span', 'pinned-more', `+${waiting.size - 1} more`));
    }
    const show = el('button', 'pinned-show', 'Show');
    show.addEventListener('click', () => {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1200);
    });
    bar.appendChild(show);
    pinnedEl.appendChild(bar);
  }

  function resetThread() {
    waiting.clear();
    renderPinned();
    dropPreviews();
    // Also stops the elapsed timer; nulling workingRow alone would leak it.
    setRunning(false);
    threadEl.replaceChildren();
    toolCards.clear();
    loadEarlierRow = null;
    firstRenderedSeq = null;
    lastUserEl = null;
    promptBar.hidden = true;
    workingRow = null;
  }

  function renderChips(items) {
    chipsEl.replaceChildren();
    items.forEach((item, index) => {
      const chip = el('span', 'chip');
      chip.appendChild(el('span', null, `${item.kind === 'image' ? '▣ ' : '▤ '}${item.label}`));
      const remove = el('button', 'chip-x', '×');
      remove.addEventListener('click', () =>
        vscode.postMessage({ type: 'removeAttachment', index }));
      chip.appendChild(remove);
      chipsEl.appendChild(chip);
    });
    // Keep in-flight upload chips visible alongside confirmed attachments.
    for (const up of pendingUploads.values()) chipsEl.appendChild(up.chip);
    chipsEl.hidden = chipsEl.childElementCount === 0;
  }

  /**
   * The sign-in card: a link and a box for the code.
   *
   * Lives here rather than in a VS Code input box because Ctrl+V does not work
   * in those under code-server — VS Code binds it to a command that reads the
   * clipboard via navigator.clipboard.readText(), which Firefox refuses, so only
   * Ctrl+Shift+V pasted. Inside the webview the browser handles the keystroke
   * itself, the same way pasting an image into the composer already does.
   */
  let loginCard = null;
  function showLoginPrompt(msg) {
    dismissLoginPrompt();
    const card = el('div', 'login-card');
    card.appendChild(el('div', 'login-title', `Finish signing in to "${msg.name}"`));
    const hint = el('div', 'login-hint');
    hint.appendChild(document.createTextNode('Approve the sign-in in your browser, then paste the code below. '));
    const again = el('a', null, 'Open the link again');
    again.href = '#';
    again.addEventListener('click', (ev) => {
      ev.preventDefault();
      vscode.postMessage({ type: 'openExternal', url: msg.url });
    });
    hint.appendChild(again);
    card.appendChild(hint);

    const row = el('div', 'login-row');
    const input = el('input', 'login-input');
    input.type = 'password';
    input.placeholder = 'Paste the authorization code';
    input.autocomplete = 'off';
    const submit = el('button', 'login-submit', 'Sign in');
    const cancel = el('button', 'login-cancel', 'Cancel');
    row.appendChild(input);
    row.appendChild(submit);
    row.appendChild(cancel);
    card.appendChild(row);
    const status = el('div', 'login-status');
    card.appendChild(status);

    const send = () => {
      const code = input.value.trim();
      if (!code) {
        status.textContent = 'Enter the code first.';
        return;
      }
      submit.disabled = true;
      input.disabled = true;
      status.textContent = 'Signing in…';
      vscode.postMessage({ type: 'loginCode', loginId: msg.loginId, code });
    };
    submit.addEventListener('click', send);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') send();
    });
    cancel.addEventListener('click', () => {
      vscode.postMessage({ type: 'loginCancel', loginId: msg.loginId });
      dismissLoginPrompt();
    });

    loginCard = { card, input, submit, status };
    threadEl.appendChild(card);
    card.scrollIntoView({ block: 'nearest' });
    input.focus();
  }

  function dismissLoginPrompt() {
    if (!loginCard) return;
    loginCard.card.remove();
    loginCard = null;
  }

  function showLoginResult(msg) {
    if (!loginCard) return;
    if (msg.ok) {
      loginCard.card.replaceChildren(
        el('div', 'login-title', 'Signed in — pick the account from the model menu.'),
      );
      setTimeout(dismissLoginPrompt, 6000);
      return;
    }
    loginCard.submit.disabled = false;
    loginCard.input.disabled = false;
    loginCard.input.value = '';
    loginCard.input.focus();
    loginCard.status.textContent = msg.error || 'Sign-in did not complete.';
  }

  /**
   * How many subagents this session has working, beside the shield.
   *
   * Derived from recent activity rather than from a finish event: every Agent
   * dispatch returns "launched successfully" in 0.0s, so counting outstanding
   * tool calls would always show zero. Hidden entirely at zero, so a session
   * that never fans out looks exactly as it did before.
   */
  function showAgents(agents) {
    const list = Array.isArray(agents) ? agents : [];
    if (list.length === 0) {
      agentsChip.hidden = true;
      return;
    }
    agentsChip.hidden = false;
    agentsCount.textContent = String(list.length);
    agentsChip.title =
      `${list.length} subagent${list.length === 1 ? '' : 's'} working\n` +
      list.map((a) => `• ${a.description}`).join('\n');
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'agents') {
      showAgents(msg.agents);
      return;
    }
    if (msg.type === 'loginPrompt') {
      showLoginPrompt(msg);
      return;
    }
    if (msg.type === 'loginResult') {
      showLoginResult(msg);
      return;
    }
    // Must run before any rendering below: the renderer looks paths up in this
    // map, and replay delivers events in the same message that carries it.
    absorbImageUris(msg);
    switch (msg.type) {
      case 'replay': {
        // A widened window re-sends from the top, so clear what is there.
        if (msg.reset) resetThread();
        if (msg.hasEarlier) showLoadEarlier();
        // Suppress per-event auto-scroll while a bulk replay renders; where to
        // land is decided once, at the end.
        pinned = false;
        // Note where the anchor event lands rather than injecting a marker
        // node, which would add a stray gap to the thread's flex layout.
        let anchorIndex = -1;
        for (const persisted of msg.events) {
          if (anchorSeq !== null && persisted.seq === anchorSeq) {
            anchorIndex = threadEl.childElementCount;
          }
          // One malformed event must never blank the whole transcript.
          try {
            renderEvent(persisted.event, persisted.ts);
          } catch (err) {
            console.error('render failed for event', persisted.seq, err);
          }
        }
        firstRenderedSeq = msg.events.length ? msg.events[0].seq : firstRenderedSeq;
        if (msg.info) {
          setRunning(msg.info.status === 'running');
          applyPermissionMode(msg.info.permissionMode);
          currentModel = msg.info.model || '';
          currentEffort = msg.info.effort || '';
          renderPill();
        }
        const anchorEl = anchorIndex >= 0 ? threadEl.children[anchorIndex] : null;
        if (anchorEl) {
          // Land on the message that was at the top before, with the newly
          // loaded history above it.
          anchorEl.scrollIntoView({ block: 'start' });
        } else {
          pinned = true;
          scrollToBottom();
        }
        anchorSeq = null;
        break;
      }
      case 'event':
        renderEvent(msg.event.event, msg.event.ts);
        break;
      case 'delta': {
        if (!streamingEl) {
          streamingEl = makePreview();
          threadEl.appendChild(streamingEl);
          previewEls.push(streamingEl);
          setRunning(true);
        }
        // Scrolling and the working-row reorder happen in renderPreviews, on
        // the animation frame, so they run once per frame rather than per chunk.
        appendPreviewText(streamingEl, msg.text);
        break;
      }
      case 'attachments':
        renderChips(msg.items ?? []);
        break;
      case 'uploadAck': {
        const up = pendingUploads.get(msg.uploadId);
        if (!up) break;
        const pct = Math.round((msg.received / msg.total) * 100);
        up.pctEl.textContent = `${pct}%`;
        if (msg.received >= msg.total) {
          // Complete: the confirmed chip arrives via the next 'attachments'.
          pendingUploads.delete(msg.uploadId);
          up.chip.remove();
        } else if (up.next < up.chunks.length) {
          const index = up.next++;
          vscode.postMessage({ type: 'uploadChunk', uploadId: msg.uploadId, index, data: up.chunks[index] });
        }
        break;
      }
      case 'pong':
        lastPongAt = Date.now();
        daemonUp = msg.daemon !== false;
        if (typeof msg.indicator === 'boolean') indicatorEnabled = msg.indicator;
        paintConnection();
        break;
      case 'connectionIndicator':
        indicatorEnabled = msg.enabled !== false;
        paintConnection();
        break;
      case 'models':
        modelInfos = msg.models ?? [];
        renderPill(); // display names may only now be known
        if (!modelMenu.hidden) renderModelMenu();
        break;
      case 'accounts':
        accountInfos = msg.accounts ?? [];
        if (!modelMenu.hidden) renderModelMenu();
        break;
      case 'branch':
        renderBranch(msg.name, msg.worktree, msg.path, msg.held);
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
  const ICON_PASTE =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M6 1.5h4l.5 1H13a.5.5 0 0 1 .5.5v10.5a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h2.5l.5-1zm.9 1.4-.5 1H4v9.2h8V3.9h-2.4l-.5-1H6.9zM5.5 6.5h5v1.2h-5V6.5zm0 2.6h5v1.2h-5V9.1z"/></svg>';
  const pasteBtn = el('button', 'menu-item');
  pasteBtn.innerHTML = `${ICON_PASTE}<span>Paste from clipboard</span>`;
  attachMenu.appendChild(deviceBtn);
  attachMenu.appendChild(pasteBtn);
  attachMenu.appendChild(serverBtn);
  document.getElementById('composer').appendChild(attachMenu);

  // Mobile long-press paste is unreliable inside webview iframes; this reads
  // the clipboard explicitly via the async API (permission prompt on first use).
  async function pasteFromClipboard() {
    try {
      let attached = false;
      if (navigator.clipboard.read) {
        for (const item of await navigator.clipboard.read()) {
          const imageType = item.types.find((t) => t.startsWith('image/'));
          if (imageType) {
            const blob = await item.getType(imageType);
            const ext = imageType.split('/')[1] || 'png';
            sendFiles([new File([blob], `clipboard.${ext}`, { type: imageType })]);
            attached = true;
          }
        }
      }
      if (!attached && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          const start = inputEl.selectionStart ?? inputEl.value.length;
          inputEl.value =
            inputEl.value.slice(0, start) + text + inputEl.value.slice(inputEl.selectionEnd ?? start);
          inputEl.dispatchEvent(new Event('input'));
          inputEl.focus();
          attached = true;
        }
      }
      if (!attached) {
        vscode.postMessage({ type: 'notify', message: 'Clipboard is empty or unreadable.' });
      }
    } catch {
      vscode.postMessage({
        type: 'notify',
        message: 'Clipboard access was blocked — allow clipboard permission for this site and retry.',
      });
    }
  }

  function hideMenu() {
    attachMenu.hidden = true;
  }

  // Chunked upload with per-chunk acks: on slow connections the transfer to
  // the server takes real time, so chips show actual delivery progress.
  const UPLOAD_CHUNK = 176 * 1024; // base64 chars (~128KB binary) per message
  const pendingUploads = new Map(); // uploadId -> {name, chunks, chip, pctEl}

  function makeUploadChip(uploadId, name) {
    const chip = el('span', 'chip uploading');
    chip.appendChild(el('span', 'spinner'));
    chip.appendChild(el('span', null, name));
    const pctEl = el('span', 'chip-pct', '0%');
    chip.appendChild(pctEl);
    chipsEl.hidden = false;
    chipsEl.appendChild(chip);
    return { chip, pctEl };
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
        const chunks = [];
        for (let i = 0; i < base64.length; i += UPLOAD_CHUNK) {
          chunks.push(base64.slice(i, i + UPLOAD_CHUNK));
        }
        if (chunks.length === 0) chunks.push('');
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const ui = makeUploadChip(uploadId, file.name);
        pendingUploads.set(uploadId, { name: file.name, chunks, next: 1, ...ui });
        vscode.postMessage({
          type: 'uploadBegin',
          uploadId,
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          chunks: chunks.length,
        });
        // First chunk goes immediately; the rest flow on acks.
        vscode.postMessage({ type: 'uploadChunk', uploadId, index: 0, data: chunks[0] });
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
  pasteBtn.addEventListener('click', () => {
    hideMenu();
    void pasteFromClipboard();
  });
  document.addEventListener('click', (e) => {
    if (!attachMenu.hidden && !attachMenu.contains(e.target) && e.target !== attachBtn) hideMenu();
    if (!modelMenu.hidden && !modelMenu.contains(e.target) && !modelPill.contains(e.target)) {
      modelMenu.hidden = true;
    }
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
    modelMenu.hidden = true; // one popover at a time — both share a position
    attachMenu.hidden = !attachMenu.hidden;
  });
  ringBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'compact' });
  });
  modelPill.addEventListener('click', (e) => {
    e.stopPropagation();
    hideMenu(); // one popover at a time — both share a position
    if (modelMenu.hidden) renderModelMenu();
    modelMenu.hidden = !modelMenu.hidden;
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

  // ---------- swipe between tabs (touch) --------------------------------------

  // The webview is an iframe and cannot switch VS Code tabs itself, so the
  // gesture is detected here and the host runs the editor command.
  const SWIPE_MIN_X = 60;      // px before it counts as intent
  const SWIPE_MAX_MS = 600;    // slower than this is a scroll, not a swipe
  let touch = null;

  /** True when the gesture began inside something that scrolls sideways. */
  function startedInScroller(target) {
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 4) return true;
    }
    return false;
  }

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) {
      touch = null; // pinch/zoom is never a tab switch
      return;
    }
    const t = e.touches[0];
    touch = startedInScroller(e.target)
      ? null
      : { x: t.clientX, y: t.clientY, at: Date.now() };
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const start = touch;
    touch = null;
    if (!start) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Date.now() - start.at > SWIPE_MAX_MS) return;
    // Must be decisively horizontal, or every diagonal scroll flips a tab.
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 2) return;
    // Selecting text drags horizontally too; that is not a swipe.
    const selection = window.getSelection();
    if (selection && String(selection).length > 0) return;
    vscode.postMessage({ type: 'switchTab', direction: dx < 0 ? 'next' : 'previous' });
  }, { passive: true });

  // ---------- connection health ----------------------------------------------

  // Two hops can break: browser -> code-server (the flaky one on mobile) and
  // extension host -> daemon. If the first breaks the webview receives nothing
  // at all, so the host cannot tell us — we have to probe. A round-trip ping
  // whose reply carries the daemon's state covers both hops in one message.
  const PING_MS = 3000;
  const STALE_MS = 8000; // ~2 missed replies before we claim anything
  let lastPongAt = Date.now();
  let daemonUp = true;
  let indicatorEnabled = true;
  let pingTimer = null;

  const veil = el('div', 'offline-veil');
  veil.hidden = true;
  document.body.appendChild(veil);

  function paintConnection() {
    // Silence beats a false alarm: while the tab is hidden, timers are
    // throttled and replies queue up, so staleness there means nothing.
    const hidden = document.visibilityState === 'hidden';
    const stale = !hidden && Date.now() - lastPongAt > STALE_MS;
    const offline = navigator.onLine === false;
    veil.hidden = !indicatorEnabled || !(stale || offline || !daemonUp);
  }

  function ping() {
    vscode.postMessage({ type: 'ping' });
    paintConnection();
  }

  function startHeartbeat() {
    if (pingTimer) return;
    pingTimer = setInterval(ping, PING_MS);
    ping();
  }

  // A tab returning to the foreground has not been talking to anyone; give it
  // a fresh window before judging, or every unlock would flash the border.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastPongAt = Date.now();
      ping();
    } else {
      paintConnection();
    }
  });
  // The browser's own view of the link: instant, and worth reacting to even
  // though it reports the interface rather than reachability.
  window.addEventListener('offline', paintConnection);
  window.addEventListener('online', () => {
    lastPongAt = Date.now();
    ping();
  });

  vscode.postMessage({ type: 'ready' });
  startHeartbeat();
})();
