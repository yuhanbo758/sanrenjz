(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RegexWorkbench = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function parseLiteral(value) {
    const text = String(value || '').trim();
    if (!text.startsWith('/')) return null;
    // 从末尾识别标志位，避免把表达式中的转义斜杠当作结束符。
    for (let i = text.length - 1; i > 0; i--) {
      if (text[i] !== '/') continue;
      let slashes = 0;
      for (let j = i - 1; text[j] === '\\'; j--) slashes++;
      if (slashes % 2) continue;
      const flags = text.slice(i + 1);
      if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) continue;
      return { source: text.slice(1, i), flags };
    }
    return null;
  }

  function extract(text) {
    const value = String(text || '');
    const fences = [...value.matchAll(/```(?:regex|regexp|javascript|js)?[^\n]*\n([\s\S]*?)\n```/gi)];
    for (const fence of fences) {
      const candidate = fence[1].trim();
      const literal = parseLiteral(candidate);
      if (literal) return literal;
      if (candidate && !candidate.includes('\n')) return { source: candidate, flags: '' };
    }
    for (const line of value.split(/\r?\n/)) {
      const candidate = line.trim().replace(/^[-*]\s*/, '').replace(/^正则(?:表达式)?[：:]\s*/, '').replace(/^`|`$/g, '');
      const literal = parseLiteral(candidate);
      if (literal) return literal;
    }
    const inline = value.match(/`(\/[^\n`]+\/[dgimsuvy]*)`/);
    return inline ? parseLiteral(inline[1]) : null;
  }

  function formatLiteral(source, flags) {
    return `/${String(source).replace(/\\?\//g, match => match === '/' ? '\\/' : match)}/${flags || ''}`;
  }

  return { parseLiteral, extract, formatLiteral };
});
