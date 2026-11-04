const MAX_DIFF_CELLS = 1_000_000;

function splitLines(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n');
}

function compareText(left, right, ignoreWhitespace = false) {
  const a = splitLines(left);
  const b = splitLines(right);
  const key = line => ignoreWhitespace ? line.trim().replace(/\s+/g, ' ') : line;
  if (a.length * b.length > MAX_DIFF_CELLS) throw new Error('文本行数过多，请缩小比较范围（最多约 100 万个比较单元）');
  // LCS 对齐可避免插入或删除一行后，误把后续所有行标为变化。
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = key(a[i]) === key(b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]) === key(b[j])) {
      lines.push({ type: 'same', text: a[i], left: ++i, right: ++j });
    } else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push({ type: 'add', text: b[j], right: ++j }); added++;
    } else {
      lines.push({ type: 'del', text: a[i], left: ++i }); removed++;
    }
  }
  return { lines, added, removed };
}

function processLines(input, options = {}) {
  let lines = splitLines(input);
  if (options.trim) lines = lines.map(line => line.trim());
  if (options.removeEmpty) lines = lines.filter(line => line.trim());
  if (options.filter) {
    const needle = options.caseSensitive ? options.filter : options.filter.toLocaleLowerCase();
    lines = lines.filter(line => (options.caseSensitive ? line : line.toLocaleLowerCase()).includes(needle));
  }
  if (options.unique) {
    const seen = new Set();
    lines = lines.filter(line => {
      const key = options.caseSensitive ? line : line.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  if (options.sort) lines.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  if (options.reverse) lines.reverse();
  return { text: lines.map((line, index) => `${options.number ? `${index + 1}. ` : ''}${options.prefix || ''}${line}${options.suffix || ''}`).join('\n'), count: lines.length };
}

function inspectRegex(input, pattern, flags, replacement, replaceEnabled) {
  if (!pattern) throw new Error('请输入正则表达式');
  const expression = new RegExp(pattern, flags);
  const matchExpression = new RegExp(expression.source, expression.flags.includes('g') ? expression.flags : `${expression.flags}g`);
  const matches = [];
  for (const match of input.matchAll(matchExpression)) {
    matches.push({ value: match[0], index: match.index, groups: match.slice(1), namedGroups: match.groups || {} });
    if (matches.length >= 10000) break;
  }
  return { matches, truncated: matches.length >= 10000, replaced: replaceEnabled ? input.replace(expression, replacement) : null };
}

module.exports = { compareText, processLines, inspectRegex };
