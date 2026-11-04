// 审查报告只接受文本 Markdown；所有原文先转义，再生成受控标签。
(function (root, factory) {
  const renderer = factory();
  if (typeof module === 'object' && module.exports) module.exports = renderer;
  if (root) root.ReviewReportRenderer = renderer;
})(typeof window === 'undefined' ? null : window, function () {
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function inline(source) {
    const codes = [];
    let safe = escapeHtml(source).replace(/`([^`]+)`/g, (_, code) => {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    safe = safe.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_, a, b) => '<strong>' + (a || b) + '</strong>');
    safe = safe.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g, (_, a, b) => '<em>' + (a || b) + '</em>');
    return safe.replace(/\u0000(\d+)\u0000/g, (_, n) => codes[Number(n)]);
  }

  function render(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let paragraph = [], list = null, code = [], fence = false;
    function flushParagraph() {
      if (paragraph.length) output.push('<p>' + inline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
    function closeList() {
      if (list) output.push('</' + list + '>');
      list = null;
    }
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        flushParagraph(); closeList();
        if (fence) { output.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>'); code = []; }
        fence = !fence;
        continue;
      }
      if (fence) { code.push(line); continue; }
      if (!line.trim()) { flushParagraph(); closeList(); continue; }
      const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
      if (heading) { flushParagraph(); closeList(); output.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>'); continue; }
      const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.+)$/);
      if (item) {
        flushParagraph();
        const kind = item[2] ? 'ol' : 'ul';
        if (list !== kind) { closeList(); output.push('<' + kind + '>'); list = kind; }
        output.push('<li>' + inline(item[3]) + '</li>');
        continue;
      }
      if (list && /^\s{2,}\S/.test(line)) {
        output[output.length - 1] = output[output.length - 1].replace(/<\/li>$/, '<br>' + inline(line.trim()) + '</li>');
        continue;
      }
      closeList(); paragraph.push(line.trim());
    }
    flushParagraph(); closeList();
    if (fence) output.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
    return output.join('');
  }
  return { render, escapeHtml };
});
