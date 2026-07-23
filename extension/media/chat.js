// Webview client for a single Claude Persist session. All state of record
// lives in the daemon; this script only renders events and forwards input.
(function () {
  const vscode = acquireVsCodeApi();
  const sessionId = document.body.dataset.sessionId;
  // Persist sessionId so the panel can be restored after a window reload.
  vscode.setState({ sessionId });

  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const statusLine = document.getElementById('status-line');
  const statusText = document.getElementById('status-text');

  let streamingEl = null; // assistant bubble currently receiving deltas

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

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

  function pretty(value) {
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function renderEvent(event) {
    switch (event.type) {
      case 'user_message': {
        endStreaming();
        messagesEl.appendChild(el('div', 'msg user', event.text));
        break;
      }
      case 'assistant_text': {
        // The final text supersedes any streamed deltas for this block.
        if (streamingEl) {
          streamingEl.textContent = event.text;
          endStreaming();
        } else {
          messagesEl.appendChild(el('div', 'msg assistant', event.text));
        }
        break;
      }
      case 'tool_use': {
        endStreaming();
        const details = el('details', 'tool');
        const summary = el('summary');
        summary.appendChild(el('span', null, '🔧 '));
        summary.appendChild(el('span', 'tool-name', event.toolName));
        details.appendChild(summary);
        details.appendChild(el('pre', null, pretty(event.input)));
        messagesEl.appendChild(details);
        break;
      }
      case 'tool_result': {
        const details = el('details', 'tool' + (event.isError ? ' error' : ''));
        details.appendChild(el('summary', null, event.isError ? '⚠ tool result (error)' : '↳ tool result'));
        details.appendChild(el('pre', null, event.summary));
        messagesEl.appendChild(details);
        break;
      }
      case 'permission_request': {
        endStreaming();
        const card = el('div', 'permission');
        card.dataset.requestId = event.requestId;
        card.appendChild(el('div', 'perm-title', `Claude wants to use ${event.toolName}`));
        card.appendChild(el('pre', null, pretty(event.input)));
        const actions = el('div', 'perm-actions');
        const allow = el('button', null, 'Allow');
        const deny = el('button', 'secondary', 'Deny');
        allow.addEventListener('click', () => {
          vscode.postMessage({ type: 'permission', requestId: event.requestId, allow: true });
        });
        deny.addEventListener('click', () => {
          vscode.postMessage({ type: 'permission', requestId: event.requestId, allow: false });
        });
        actions.appendChild(allow);
        actions.appendChild(deny);
        card.appendChild(actions);
        messagesEl.appendChild(card);
        break;
      }
      case 'permission_resolved': {
        const card = messagesEl.querySelector(`.permission[data-request-id="${event.requestId}"]`);
        if (card) {
          card.classList.add('resolved');
          card.appendChild(el('div', 'meta', event.allowed ? 'Allowed' : 'Denied'));
        }
        break;
      }
      case 'status': {
        if (event.status === 'running') {
          setRunning(true);
        } else {
          endStreaming();
          setRunning(false);
          if (event.status === 'error') {
            messagesEl.appendChild(el('div', 'meta', `⚠ ${event.detail || 'error'}`));
          }
        }
        break;
      }
      case 'result': {
        endStreaming();
        const bits = [];
        if (typeof event.costUsd === 'number') bits.push(`$${event.costUsd.toFixed(4)}`);
        if (typeof event.durationMs === 'number') bits.push(`${(event.durationMs / 1000).toFixed(1)}s`);
        messagesEl.appendChild(el('div', 'meta', `— turn done${bits.length ? ` (${bits.join(', ')})` : ''} —`));
        setRunning(false);
        break;
      }
    }
    scrollToBottom();
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'replay': {
        for (const persisted of msg.events) renderEvent(persisted.event);
        if (msg.info) setRunning(msg.info.status === 'running');
        scrollToBottom();
        break;
      }
      case 'event':
        renderEvent(msg.event.event);
        break;
      case 'delta': {
        if (!streamingEl) {
          streamingEl = el('div', 'msg assistant streaming', '');
          messagesEl.appendChild(streamingEl);
          setRunning(true);
        }
        streamingEl.textContent += msg.text;
        scrollToBottom();
        break;
      }
    }
  });

  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    inputEl.value = '';
    autosize();
  }

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'interrupt' }));
  inputEl.addEventListener('input', autosize);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
