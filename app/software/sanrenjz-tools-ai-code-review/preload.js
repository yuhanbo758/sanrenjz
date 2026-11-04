const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');

const MAX_INPUT_BYTES = 200000;
const execFileAsync = promisify(execFile);
let emit = () => {};
const api = createAiRuntime('AI 代码审查', chunk => emit(chunk));
api.onChunk = listener => { emit = listener; return () => { emit = () => {}; }; };

api.openTextFile = async () => {
  const selected = await ipcRenderer.invoke('show-open-dialog', {
    properties: ['openFile'],
    filters: [{ name: '代码、Diff 与文本', extensions: ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'html', 'css', 'json', 'md', 'txt', 'diff', 'patch'] }, { name: '所有文件', extensions: ['*'] }]
  });
  const file = Array.isArray(selected) ? selected[0] : selected?.filePaths?.[0];
  if (!file) return null;
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('文件超过 200 KB，请选取较小文件或粘贴片段');
  return { name: path.basename(file), text: await fs.promises.readFile(file, 'utf8') };
};

api.openGitDiff = async () => {
  const selected = await ipcRenderer.invoke('show-open-dialog', { properties: ['openDirectory'] });
  const directory = Array.isArray(selected) ? selected[0] : selected?.filePaths?.[0];
  if (!directory) return null;
  // 只读取所选仓库相对 HEAD 的已跟踪文件差异，不运行 shell 或外部 diff 工具。
  const { stdout } = await execFileAsync('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.'], {
    cwd: directory, encoding: 'utf8', maxBuffer: MAX_INPUT_BYTES + 4096, timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
  if (Buffer.byteLength(stdout, 'utf8') > MAX_INPUT_BYTES) throw new Error('Diff 超过 200 KB，请缩小范围后粘贴');
  return { name: path.basename(directory), text: stdout };
};

try { contextBridge.exposeInMainWorld('aiAPI', api); } catch (_) { window.aiAPI = api; }
function enter(action) { window.dispatchEvent(new CustomEvent('plugin-enter', { detail: action || {} })); }
window.exports = { 'plugin-market-ai-code-review': { mode: 'none', args: { enter, search: (_a, _w, setList) => setList([]), select: () => {} } } };
