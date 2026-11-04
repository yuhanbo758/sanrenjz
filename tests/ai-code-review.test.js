const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { render } = require('../app/software/sanrenjz-tools-ai-code-review/report-renderer');

const report = [
  '## 高：边界条件',
  '',
  '**描述：** 第一段内容。',
  '',
  '**位置：** `src/a.js:12`',
  '',
  '- 缺少空值检查',
  '- 可用测试验证',
  '',
  '```js',
  'if (value < 0) throw new Error("invalid");',
  '```'
].join('\n');
const html = render(report);
assert.match(html, /<h2>高：边界条件<\/h2>/);
assert.match(html, /<strong>描述：<\/strong> 第一段内容。<\/p><p>/);
assert.match(html, /<code>src\/a\.js:12<\/code>/);
assert.match(html, /<ul><li>缺少空值检查<\/li><li>可用测试验证<\/li><\/ul>/);
assert.match(html, /<pre><code>if \(value &lt; 0\)/);

const unsafe = render('**<img src=x onerror=alert(1)>**\n\n<script>alert(1)</script>');
assert.doesNotMatch(unsafe, /<img|<script>/);
assert.match(unsafe, /&lt;img/);
assert.match(unsafe, /&lt;script&gt;/);
assert.match(render('A & B'), /A &amp; B/);

async function verifyLocalInputs() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-'));
  try {
    const file = path.join(directory, 'sample.js');
    fs.writeFileSync(file, 'const answer = 1;\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'sample.js'], { cwd: directory });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: directory });
    fs.writeFileSync(file, 'const answer = 2;\n', 'utf8');
    fs.writeFileSync(path.join(directory, 'untracked.js'), 'doNotRead();\n', 'utf8');
    let selection = [file];
    const sandbox = {
      require(name) {
        if (name === 'electron') return { contextBridge: { exposeInMainWorld: (_key, api) => { sandbox.api = api; } }, ipcRenderer: { invoke: async () => selection } };
        if (name === '../../plugin_runtime/ai-runtime') return { createAiRuntime: () => ({}) };
        return require(name);
      },
      process, Buffer, window: { addEventListener() {}, dispatchEvent() {} }, CustomEvent: class {}, module: { exports: {} }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/software/sanrenjz-tools-ai-code-review/preload.js'), 'utf8'), sandbox);
    const input = await sandbox.api.openTextFile();
    assert.strictEqual(input.text, 'const answer = 2;\n');
    selection = [directory];
    const diff = await sandbox.api.openGitDiff();
    assert.match(diff.text, /\+const answer = 2;/);
    assert.doesNotMatch(diff.text, /doNotRead/);
    selection = [];
    assert.strictEqual(await sandbox.api.openGitDiff(), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
verifyLocalInputs().then(() => console.log('AI 代码审查 Markdown 与本地输入验证通过')).catch(error => { console.error(error); process.exitCode = 1; });
