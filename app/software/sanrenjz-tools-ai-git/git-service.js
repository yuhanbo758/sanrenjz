const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const MAX_INPUT_BYTES = 180000;
const GIT_OPTIONS = { encoding: 'utf8', windowsHide: true, timeout: 15000,
  maxBuffer: MAX_INPUT_BYTES + 32768,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } };

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['--no-pager', '-c', 'core.quotepath=false', ...args], { ...GIT_OPTIONS, cwd });
    if (Buffer.byteLength(stdout, 'utf8') > MAX_INPUT_BYTES) throw new Error('Git 输出超过 180 KB，请缩小读取范围或手动粘贴片段');
    return stdout.trimEnd();
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Git 输出超过 180 KB，请缩小读取范围或手动粘贴片段');
    throw error;
  }
}

async function inspectRepository(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('请选择或拖入项目文件夹');
  const candidate = path.resolve(directory);
  const stat = await fs.promises.stat(candidate).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('请拖入文件夹，而不是单个文件');
  let root;
  try {
    const inside = await git(candidate, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') throw new Error('所选目录不是 Git 工作区');
    root = await git(candidate, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    if (error.message === '所选目录不是 Git 工作区') throw error;
    throw new Error('所选目录不是 Git 工作区，或本机 Git 不可用');
  }
  const branch = await git(root, ['branch', '--show-current']);
  const status = await git(root, ['status', '--short', '--untracked-files=normal']);
  return { root, branch: branch || '分离 HEAD', status, changedFiles: status ? status.split('\n').length : 0 };
}

async function hasHead(root) {
  try { await git(root, ['rev-parse', '--verify', 'HEAD']); return true; }
  catch (_) { return false; }
}

async function readRepository(directory, source, baseRef = '') {
  const repo = await inspectRepository(directory);
  const root = repo.root;
  const sections = [`## 仓库\n${path.basename(root)} (${repo.branch})`];
  const head = await hasHead(root);
  const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color'];
  const stagedArgs = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color'];
  let contentFound = false;
  if (['all', 'staged', 'unstaged'].includes(source)) {
    // 分开读取暂存区与工作区，避免 git diff HEAD 把两类变更混在一起。
    if (source !== 'unstaged') {
      const staged = await git(root, stagedArgs);
      if (staged) { sections.push(`## 已暂存 Diff\n${staged}`); contentFound = true; }
    }
    if (source !== 'staged') {
      const unstaged = await git(root, diffArgs);
      if (unstaged) { sections.push(`## 未暂存 Diff\n${unstaged}`); contentFound = true; }
    }
    if (!head && !repo.status) sections.push('仓库尚无提交或文件变更。');
    if (source === 'all') {
      const untracked = repo.status.split('\n').filter(line => line.startsWith('??'));
      if (untracked.length) sections.push(`## 未跟踪文件（仅路径，未读取内容）\n${untracked.join('\n')}`);
    }
  } else if (source === 'base') {
    if (!head) throw new Error('仓库尚无提交，无法与基准分支比较');
    const ref = String(baseRef || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) || ref.includes('..') || ref.includes('//')) {
      throw new Error('请输入有效的基准分支名，例如 main 或 origin/main');
    }
    let baseCommit;
    try { baseCommit = await git(root, ['rev-parse', '--verify', `${ref}^{commit}`]); }
    catch (_) { throw new Error(`找不到基准分支：${ref}`); }
    let mergeBase;
    try { mergeBase = await git(root, ['merge-base', baseCommit, 'HEAD']); }
    catch (_) { throw new Error(`当前分支与 ${ref} 没有共同祖先`); }
    sections.push(`## 比较范围\n${ref}...HEAD`);
    const diff = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', mergeBase, 'HEAD']);
    if (diff) { sections.push(`## 分支 Diff\n${diff}`); contentFound = true; }
    const log = await git(root, ['log', '--no-show-signature', '--format=%h %s%n%b', `${mergeBase}..HEAD`]);
    if (log) { sections.push(`## 分支提交\n${log}`); contentFound = true; }
  } else if (source === 'recent' || source === 'tag') {
    if (!head) throw new Error('仓库尚无提交，无法生成历史记录');
    let range = '';
    if (source === 'tag') {
      try { range = `${await git(root, ['describe', '--tags', '--abbrev=0'])}..HEAD`; }
      catch (_) { throw new Error('仓库没有可用标签，请改选“最近 30 次提交”'); }
    }
    sections.push(`## 读取范围\n${range || '最近 30 次提交'}`);
    const log = await git(root, ['log', '--no-show-signature', '--format=%h %s%n%b', ...(range ? [range] : ['-30'])]);
    if (log) { sections.push(`## 提交记录${range ? ` (${range})` : ' (最近 30 次)'}\n${log}`); contentFound = true; }
    else sections.push('该范围没有提交。');
    if (range) {
      const stat = await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--stat', range]);
      if (stat) sections.push(`## 变更统计\n${stat}`);
    }
  } else throw new Error('不支持的读取范围');
  const text = sections.join('\n\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('汇总内容超过 180 KB，请缩小读取范围或手动粘贴片段');
  return { ...repo, text, hasChanges: contentFound };
}

module.exports = { inspectRepository, readRepository };
