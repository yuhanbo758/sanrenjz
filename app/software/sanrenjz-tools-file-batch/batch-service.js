const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILES = 10000;

function collect(paths, recursive = false) {
  const files = new Set();
  const pending = [...new Set((paths || []).map(item => path.resolve(String(item))))];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isFile() || (recursive && entry.isDirectory())) pending.push(path.join(current, entry.name));
      }
    } else if (stat.isFile()) files.add(current);
    if (files.size > MAX_FILES) throw new Error(`一次最多处理 ${MAX_FILES} 个文件`);
  }
  return [...files].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function key(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function planRename(files, options = {}) {
  const sources = [...new Map(files.map(file => [key(file), path.resolve(file)])).values()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const start = Number(options.start ?? 1);
  const padding = Number(options.padding ?? 2);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(padding) || padding < 1 || padding > 12) throw new Error('编号起始或位数无效');
  const filter = String(options.extensions || '').split(/[,，\s]+/).map(x => x.replace(/^\./, '').toLowerCase()).filter(Boolean);
  const find = String(options.find || '');
  const replacement = String(options.replace || '');
  const expression = options.regex && find ? new RegExp(find, 'g') : null;
  const chosen = sources.filter(file => !filter.length || filter.includes(path.extname(file).slice(1).toLowerCase()));
  const plan = chosen.map((file, index) => {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`不是普通文件：${file}`);
    const before = path.basename(file);
    const ext = path.extname(before);
    let base = before.slice(0, before.length - ext.length);
    if (find) base = expression ? base.replace(expression, replacement) : base.split(find).join(replacement);
    if (options.caseMode === 'lower') base = base.toLowerCase();
    if (options.caseMode === 'upper') base = base.toUpperCase();
    const number = options.number ? `${String(start + index).padStart(padding, '0')}-` : '';
    const after = `${options.prefix || ''}${number}${base}${options.suffix || ''}${ext}`;
    if (!after || after === '.' || after === '..' || /[\\/]/.test(after) || (process.platform === 'win32' && (/[<>:"|?*\x00-\x1f]/.test(after) || /[. ]$/.test(after)))) throw new Error(`文件名无效：${after}`);
    return { from: file, to: path.join(path.dirname(file), after), before, after, size: stat.size, mtimeMs: stat.mtimeMs };
  }).filter(row => row.from !== row.to);
  const destinations = new Set();
  const moving = new Set(plan.map(row => key(row.from)));
  for (const row of plan) {
    const target = key(row.to);
    if (destinations.has(target) || (fs.existsSync(row.to) && !moving.has(target))) throw new Error(`目标文件冲突：${row.after}`);
    destinations.add(target);
  }
  return plan;
}

function executeRename(plan) {
  if (!Array.isArray(plan) || !plan.length) throw new Error('没有待执行的预览计划');
  const sources = new Set(plan.map(row => key(row.from)));
  const destinations = new Set();
  for (const row of plan) {
    const stat = fs.statSync(row.from);
    if (!stat.isFile() || stat.size !== row.size || stat.mtimeMs !== row.mtimeMs) throw new Error(`源文件已变化，请重新预览：${row.before}`);
    const target = key(row.to);
    if (destinations.has(target) || (fs.existsSync(row.to) && !sources.has(target))) throw new Error(`目标文件冲突，请重新预览：${row.after}`);
    destinations.add(target);
  }
  const staged = [];
  const completed = [];
  try {
    // 先全部移到同目录临时名，支持文件名互换，且不会覆盖已有目标。
    for (const row of plan) {
      let temp;
      do { temp = path.join(path.dirname(row.from), `.sanrenjz-rename-${crypto.randomUUID()}.tmp`); } while (fs.existsSync(temp));
      fs.renameSync(row.from, temp);
      staged.push({ ...row, temp });
    }
    for (const row of staged) { fs.renameSync(row.temp, row.to); completed.push(row); }
    return plan.length;
  } catch (error) {
    const rollbackErrors = [];
    for (const row of completed.reverse()) try { fs.renameSync(row.to, row.temp); } catch (failure) { rollbackErrors.push(failure.message); }
    for (const row of staged.reverse()) if (fs.existsSync(row.temp)) try { fs.renameSync(row.temp, row.from); } catch (failure) { rollbackErrors.push(failure.message); }
    throw new Error(rollbackErrors.length ? `${error.message}；回滚未完成：${rollbackErrors.join('；')}` : error.message);
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function checksum(files) {
  const result = [];
  for (const file of files) result.push({ file, sha256: await sha256(file) });
  return result;
}

module.exports = { collect, planRename, executeRename, checksum };
