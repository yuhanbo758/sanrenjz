const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { inspectRepository, readRepository } = require('../app/software/sanrenjz-tools-ai-git/git-service');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-git-test-'));
function git(...args) { return execFileSync('git', args, { cwd: temp, encoding: 'utf8', windowsHide: true }); }

(async () => {
  try {
    git('init');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'AI Git Test');
    fs.writeFileSync(path.join(temp, 'file.txt'), 'baseline\n', 'utf8');
    git('add', 'file.txt');
    git('commit', '-m', 'init: baseline');
    git('tag', 'v0.1.0');
    git('branch', 'base');
    fs.writeFileSync(path.join(temp, 'file.txt'), 'baseline\nstaged line\n', 'utf8');
    git('add', 'file.txt');
    fs.writeFileSync(path.join(temp, 'file.txt'), 'baseline\nstaged line\nunstaged line\n', 'utf8');
    fs.writeFileSync(path.join(temp, 'new.txt'), 'untracked content must not be read', 'utf8');

    const nested = path.join(temp, 'nested');
    fs.mkdirSync(nested);
    const repo = await inspectRepository(nested);
    assert.strictEqual(path.normalize(repo.root), path.normalize(temp));
    assert.strictEqual(repo.changedFiles, 2);

    const staged = await readRepository(temp, 'staged');
    assert(staged.hasChanges);
    assert(staged.text.includes('## 已暂存 Diff'));
    assert(!staged.text.includes('## 未暂存 Diff'));
    assert(!staged.text.includes('unstaged line'));
    assert(!staged.text.includes('untracked content must not be read'));

    const unstaged = await readRepository(temp, 'unstaged');
    assert(unstaged.text.includes('## 未暂存 Diff'));
    assert(!unstaged.text.includes('## 已暂存 Diff'));
    const all = await readRepository(temp, 'all');
    assert(all.text.includes('## 已暂存 Diff') && all.text.includes('## 未暂存 Diff'));
    assert(all.text.includes('## 未跟踪文件'));

    const recent = await readRepository(temp, 'recent');
    assert(recent.text.includes('init: baseline'));
    assert(!recent.text.includes('## 未跟踪文件'));
    const sinceTag = await readRepository(temp, 'tag');
    assert(!sinceTag.hasChanges);
    assert(sinceTag.text.includes('v0.1.0..HEAD'));

    await assert.rejects(inspectRepository(path.join(temp, 'file.txt')), /文件夹/);
    await assert.rejects(readRepository(temp, 'arbitrary'), /不支持的读取范围/);
    await assert.rejects(readRepository(temp, 'base', '--help'), /有效的基准分支名/);
    await assert.rejects(readRepository(temp, 'base', 'missing'), /找不到基准分支/);
    git('add', 'file.txt');
    git('commit', '-m', 'feat: branch change');
    const comparison = await readRepository(temp, 'base', 'base');
    assert(comparison.hasChanges);
    assert(comparison.text.includes('## 分支 Diff'));
    assert(comparison.text.includes('feat: branch change'));
    assert(!comparison.text.includes('untracked content must not be read'));
    console.log('AI Git 助手只读 Git 范围验证通过');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
