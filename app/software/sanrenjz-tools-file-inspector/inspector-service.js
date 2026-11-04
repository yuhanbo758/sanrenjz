const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 20000;
const MAX_MATCHES = 5000;

function normalizeRoots(paths) {
  const unique = [...new Set((paths || []).map(value => path.resolve(String(value))))];
  if (!unique.length) throw new Error('请选择或拖入文件、目录');
  return unique.map(fullPath => {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) throw new Error('暂不支持符号链接入口');
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`不支持的路径：${fullPath}`);
    return { path: fullPath, directory: stat.isDirectory() };
  });
}

async function collect(paths, options = {}) {
  const roots = normalizeRoots(paths);
  const files = [];
  const skipped = { links: 0, unreadable: 0 };
  const pending = roots.map(root => ({ ...root, relativePath: root.directory ? '' : path.basename(root.path), depth: 0 }));
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Math.max(0, Math.min(100, Number(options.maxDepth))) : 100;
  while (pending.length) {
    const item = pending.pop();
    if (!item.directory) {
      try {
        const stat = await fs.promises.stat(item.path);
        files.push({ path: item.path, relativePath: item.relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (_) { skipped.unreadable++; }
      if (files.length > MAX_FILES) throw new Error(`文件超过 ${MAX_FILES} 个，请缩小检查范围`);
      continue;
    }
    if (item.depth >= maxDepth) continue;
    let entries;
    try { entries = await fs.promises.readdir(item.path, { withFileTypes: true }); }
    catch (_) { skipped.unreadable++; continue; }
    entries.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) { skipped.links++; continue; }
      if (!entry.isFile() && !entry.isDirectory()) continue;
      pending.push({ path: path.join(item.path, entry.name), relativePath: path.join(item.relativePath, entry.name), directory: entry.isDirectory(), depth: item.depth + 1 });
    }
  }
  return { files, skipped };
}

function extensionSet(value) {
  return new Set(String(value || '').split(/[,，;；\s]+/).map(item => item.trim().replace(/^\./, '').toLowerCase()).filter(Boolean));
}

function matchesExtension(file, extensions) {
  return !extensions.size || extensions.has(path.extname(file.path).slice(1).toLowerCase());
}

async function search(paths, options = {}) {
  const query = String(options.query || '');
  if (!query) throw new Error('请输入搜索内容');
  const regexp = options.regex ? new RegExp(query, options.caseSensitive ? 'g' : 'gi') : null;
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const extensions = extensionSet(options.extensions);
  const maxBytes = Math.max(1, Math.min(100, Number(options.maxSizeMb) || 5)) * 1048576;
  const { files, skipped } = await collect(paths);
  const matches = [];
  let scanned = 0, skippedLarge = 0, skippedBinary = 0;
  for (const file of files) {
    if (!matchesExtension(file, extensions)) continue;
    if (file.size > maxBytes) { skippedLarge++; continue; }
    let data;
    try { data = await fs.promises.readFile(file.path); }
    catch (_) { skipped.unreadable++; continue; }
    if (data.includes(0)) { skippedBinary++; continue; }
    scanned++;
    const lines = data.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (regexp ? (regexp.lastIndex = 0, regexp.test(line)) : (options.caseSensitive ? line : line.toLocaleLowerCase()).includes(needle)) {
        matches.push({ path: file.path, relativePath: file.relativePath, line: index + 1, text: line.trim().slice(0, 500) });
        if (matches.length >= MAX_MATCHES) return { matches, scanned, total: files.length, skippedLarge, skippedBinary, skipped, limited: true };
      }
    }
  }
  return { matches, scanned, total: files.length, skippedLarge, skippedBinary, skipped, limited: false };
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function compare(leftPath, rightPath, options = {}) {
  const leftRoot = normalizeRoots([leftPath])[0], rightRoot = normalizeRoots([rightPath])[0];
  if (!leftRoot.directory || !rightRoot.directory) throw new Error('比较需要两个目录');
  if (leftRoot.path === rightRoot.path) throw new Error('请选择两个不同目录');
  const [left, right] = await Promise.all([collect([leftPath]), collect([rightPath])]);
  const a = new Map(left.files.map(file => [file.relativePath, file]));
  const b = new Map(right.files.map(file => [file.relativePath, file]));
  const items = [];
  for (const relativePath of [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y, 'zh-CN'))) {
    const first = a.get(relativePath), second = b.get(relativePath);
    let status = first ? second ? '不同' : '仅左侧' : '仅右侧';
    if (first && second) {
      if (first.size === second.size) {
        if (options.hash) status = await hashFile(first.path) === await hashFile(second.path) ? '相同' : '不同';
        else status = Math.abs(first.mtimeMs - second.mtimeMs) < 1000 ? '相同' : '不同';
      }
    }
    items.push({ relativePath, status, leftSize: first?.size ?? null, rightSize: second?.size ?? null });
  }
  return { items, skipped: { links: left.skipped.links + right.skipped.links, unreadable: left.skipped.unreadable + right.skipped.unreadable } };
}

async function tree(rootPath, options = {}) {
  const root = normalizeRoots([rootPath])[0];
  if (!root.directory) throw new Error('目录树需要一个目录');
  const { files, skipped } = await collect([rootPath], { maxDepth: options.maxDepth ?? 100 });
  const extensions = extensionSet(options.extensions);
  const filtered = files.filter(file => matchesExtension(file, extensions)).sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
  const format = options.format || 'text';
  const text = format === 'json'
    ? JSON.stringify(filtered.map(file => ({ path: file.relativePath, bytes: file.size })), null, 2)
    : filtered.map(file => `${format === 'markdown' ? '- ' : ''}${file.relativePath}${options.showSize ? ` (${file.size} B)` : ''}`).join('\n');
  return { text, count: filtered.length, skipped };
}

module.exports = { normalizeRoots, collect, search, compare, tree };
