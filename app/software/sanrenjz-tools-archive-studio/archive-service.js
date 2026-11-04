const fs = require('fs');
const path = require('path');
const fflate = require('fflate');

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 20000;

function safeName(name) {
  const normalized = String(name).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) ||
      parts.some(part => part === '.' || part === '..' || part.includes('\0') || /[<>:"|?*]/.test(part) ||
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`压缩包包含不安全路径：${name}`);
  }
  return parts.join('/');
}

function inspect(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) throw new Error('ZIP 文件不存在或超过 256 MB 限制');
  const bytes = fs.readFileSync(filePath);
  const entries = [];
  const seen = new Set();
  let total = 0;
  let count = 0;
  // fflate 在 filter 阶段只读取 ZIP 目录，不解压数据，可先完成大小和路径检查。
  fflate.unzipSync(bytes, { filter(info) {
    if (++count > MAX_ENTRIES) throw new Error('ZIP 条目超过 20000 个');
    const name = safeName(info.name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`ZIP 包含重复路径：${name}`);
    seen.add(key);
    if (info.originalSize < 0 || (total += info.originalSize) > MAX_TOTAL_BYTES) throw new Error('解压后总大小超过 512 MB 限制');
    entries.push({ name: info.name, size: info.originalSize, packed: info.size, directory: info.name.endsWith('/') });
    return false;
  } });
  return { file: filePath, bytes: stat.size, totalBytes: total, entries };
}

function ensureInside(root, name) {
  const target = path.resolve(root, ...safeName(name).split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`压缩包包含不安全路径：${name}`);
  // 目标目录里的符号链接不能成为解压写入的跳板。
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`目标路径包含符号链接：${current}`);
  }
  return target;
}

function extract(filePath, outputDirectory, selectedNames = [], skipExisting = true) {
  const summary = inspect(filePath);
  const root = path.resolve(outputDirectory);
  if (!fs.existsSync(path.dirname(root)) || !fs.statSync(path.dirname(root)).isDirectory()) throw new Error('请选择有效的解压目录');
  const selected = new Set(selectedNames);
  const wanted = summary.entries.filter(item => !selected.size || selected.has(item.name));
  const targets = wanted.map(item => ({ ...item, target: ensureInside(root, item.name) }));
  const accepted = new Set(targets.filter(item => !item.directory && (!skipExisting || !fs.existsSync(item.target))).map(item => item.name));
  if (!skipExisting && targets.some(item => !item.directory && fs.existsSync(item.target))) throw new Error('目标中已有同名文件，请启用“跳过已有文件”或更换目录');
  const bytes = fs.readFileSync(filePath);
  const unpacked = fflate.unzipSync(bytes, { filter: item => accepted.has(item.name) });
  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const item of targets) {
    if (item.directory) { fs.mkdirSync(item.target, { recursive: true }); continue; }
    if (!Object.hasOwn(unpacked, item.name)) continue;
    ensureInside(root, item.name);
    fs.mkdirSync(path.dirname(item.target), { recursive: true });
    // wx 防止检查之后出现的同名文件被覆盖。
    try { fs.writeFileSync(item.target, unpacked[item.name], { flag: 'wx' }); written++; }
    catch (error) { if (error.code !== 'EEXIST' || !skipExisting) throw error; }
  }
  return { written, skipped: targets.filter(item => !item.directory).length - written, outputDirectory: root };
}

function collectSources(paths) {
  const items = [];
  const names = new Set();
  function add(fullPath, name) {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) throw new Error(`不打包符号链接：${fullPath}`);
    if (stat.isDirectory()) {
      const children = fs.readdirSync(fullPath).sort();
      if (!children.length) items.push({ path: fullPath, name: `${name}/`, directory: true, size: 0 });
      for (const child of children) add(path.join(fullPath, child), `${name}/${child}`);
    } else if (stat.isFile()) items.push({ path: fullPath, name, directory: false, size: stat.size });
  }
  for (const source of paths) add(path.resolve(source), path.basename(source));
  let total = 0;
  for (const item of items) {
    const name = safeName(item.name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`存在同名打包条目：${name}`);
    names.add(key);
    if ((total += item.size) > MAX_TOTAL_BYTES || items.length > MAX_ENTRIES) throw new Error('打包内容超过 512 MB 或 20000 个条目限制');
  }
  return { items, total };
}

function create(paths, outputPath, level = 6) {
  if (!paths.length) throw new Error('请先添加文件或文件夹');
  const { items } = collectSources(paths);
  const target = path.resolve(outputPath);
  if (fs.existsSync(target)) throw new Error('目标 ZIP 已存在，请选择新文件名');
  if (paths.some(source => path.resolve(source) === target)) throw new Error('输出位置不能与源文件相同');
  const data = Object.create(null);
  for (const item of items) data[item.name] = item.directory ? new Uint8Array() : new Uint8Array(fs.readFileSync(item.path));
  const zipped = fflate.zipSync(data, { level: Math.max(0, Math.min(9, Number(level) || 0)) });
  fs.writeFileSync(target, zipped, { flag: 'wx' });
  return { output: target, files: items.filter(item => !item.directory).length, bytes: zipped.length };
}

module.exports = { inspect, extract, create, collectSources };
