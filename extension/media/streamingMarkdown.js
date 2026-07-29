// Splits a partially-received assistant message into the part whose markdown
// structure is already unambiguous ("stable") and the part still arriving
// ("tail"). The webview renders the stable prefix as markdown and leaves the
// tail as plain text, so finished blocks never re-flow as more text arrives.
//
// Dual-target on purpose: a global for the inlined webview, module.exports for
// the node:test suite. The webview has no test harness, so the only way this
// logic gets tested is by being reachable from Node.
(function (root) {
  var FENCE_RE = /^\s{0,3}(```|~~~)/;

  /** Start offsets of every line that opens or closes a fenced code block. */
  function fenceLineStarts(text) {
    var starts = [];
    var pos = 0;
    for (;;) {
      var nl = text.indexOf('\n', pos);
      var end = nl === -1 ? text.length : nl;
      if (FENCE_RE.test(text.slice(pos, end))) starts.push(pos);
      if (nl === -1) break;
      pos = nl + 1;
    }
    return starts;
  }

  function splitStreamingMarkdown(text) {
    var src = text == null ? '' : String(text);
    // A blank line is the one boundary markdown treats as unambiguous: no
    // later text can change how the block before it parses.
    var idx = src.lastIndexOf('\n\n');
    if (idx === -1) return { stable: '', tail: src };
    var boundary = idx + 2;
    // ...unless the boundary sits inside an unclosed fence, where a blank line
    // is just code. Back up to where that fence opened.
    var starts = fenceLineStarts(src.slice(0, boundary));
    if (starts.length % 2 === 1) boundary = starts[starts.length - 1];
    if (boundary <= 0) return { stable: '', tail: src };
    return { stable: src.slice(0, boundary), tail: src.slice(boundary) };
  }

  root.splitStreamingMarkdown = splitStreamingMarkdown;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { splitStreamingMarkdown: splitStreamingMarkdown };
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
