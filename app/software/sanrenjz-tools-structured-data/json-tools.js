function pathParts(path) {
  const source = String(path || '').trim().replace(/^\$\.?/, '');
  if (!source) return [];
  const parts = [];
  const token = /(?:^|\.)([^.\[\]]+)|\[(\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]/gy;
  let offset = 0;
  while (offset < source.length) {
    token.lastIndex = offset;
    const match = token.exec(source);
    if (!match) throw new Error(`路径语法错误，位置 ${offset + 1}`);
    const bracket = match[2];
    parts.push(bracket === undefined ? match[1] : /^\d+$/.test(bracket) ? Number(bracket) : bracket[0] === '"' ? JSON.parse(bracket) : bracket.slice(1, -1));
    offset = token.lastIndex;
  }
  return parts;
}

function findPath(value, path) {
  let current = value;
  for (const part of pathParts(path)) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      throw new Error(`路径不存在：${path}`);
    }
    current = current[part];
  }
  return current;
}

function summarize(value) {
  const count = { objects: 0, arrays: 0, values: 0, maxDepth: 0 };
  const walk = (node, depth) => {
    count.maxDepth = Math.max(count.maxDepth, depth);
    if (Array.isArray(node)) { count.arrays++; node.forEach(item => walk(item, depth + 1)); }
    else if (node && typeof node === 'object') { count.objects++; Object.values(node).forEach(item => walk(item, depth + 1)); }
    else count.values++;
  };
  walk(value, 0);
  return count;
}

function treeLines(value, limit = 300) {
  const lines = [];
  const walk = (node, label, depth) => {
    if (lines.length >= limit) return;
    const prefix = `${'  '.repeat(depth)}${label}`;
    if (Array.isArray(node)) { lines.push(`${prefix} [${node.length}]`); node.forEach((item, index) => walk(item, `[${index}]`, depth + 1)); }
    else if (node && typeof node === 'object') { const keys = Object.keys(node); lines.push(`${prefix} {${keys.length}}`); keys.forEach(key => walk(node[key], key, depth + 1)); }
    else lines.push(`${prefix}: ${JSON.stringify(node)}`);
  };
  walk(value, '$', 0);
  if (lines.length >= limit) lines.push(`…已显示前 ${limit} 行`);
  return lines.join('\n');
}

function runJson(input, options = {}) {
  const action = options.action || 'format';
  if (action === 'jsonl-to-array') {
    const lines = input.split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) throw new Error('JSON Lines 为空');
    const values = lines.map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`第 ${index + 1} 条 JSON Lines 无效：${error.message}`); }
    });
    return { result: JSON.stringify(values, null, 2), stats: summarize(values) };
  }
  const value = JSON.parse(input);
  const selected = findPath(value, options.query || '');
  const stats = summarize(selected);
  if (action === 'array-to-jsonl') {
    if (!Array.isArray(selected)) throw new Error('JSON Lines 导出需要数组，请先查询到数组节点');
    return { result: selected.map(item => JSON.stringify(item)).join('\n'), stats };
  }
  if (action === 'validate') return { result: 'JSON 语法有效', stats };
  if (action === 'tree') return { result: treeLines(selected), stats };
  if (action === 'minify') return { result: JSON.stringify(selected), stats };
  if (action !== 'format') throw new Error(`未知 JSON 操作：${action}`);
  return { result: JSON.stringify(selected, null, 2), stats };
}

module.exports = { pathParts, findPath, summarize, runJson };
