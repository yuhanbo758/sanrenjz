const { contextBridge, ipcRenderer, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');

let emit = () => {};
const api = createAiRuntime('AI 学习卡片', chunk => emit(chunk));
api.onChunk = listener => { emit = listener; return () => { emit = () => {}; }; };
api.pickFiles = () => ipcRenderer.sendSync('show-open-dialog', {
  title: '选择学习资料', properties: ['openFile', 'multiSelections'],
  filters: [{ name: '文档', extensions: ['pdf', 'txt', 'md', 'markdown'] }]
}) || [];
api.readDocument = async filePath => {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.pdf', '.txt', '.md', '.markdown'].includes(ext)) throw new Error('不支持的文件格式');
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('文档必须小于 20 MB');
  if (ext === '.pdf') return new Promise((resolve, reject) => {
    // pdf-parse 在 Electron 渲染进程会误判运行环境，改由 Node 模式子进程解析。
    const child = spawn(process.execPath, [path.join(__dirname, 'learning-pdf-worker.js'), filePath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    let size = 0;
    let errorText = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('PDF 解析超时')); }, 60000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) { child.kill(); reject(new Error('PDF 提取文本过大')); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { errorText += chunk.toString().slice(0, 1000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(errorText.trim() || 'PDF 解析失败')); });
  });
  const text = fs.readFileSync(filePath, 'utf8');
  if (text.includes('\uFFFD') || text.includes('\0')) throw new Error('文件不是有效的 UTF-8 文本');
  return text;
};
api.copyText = text => clipboard.writeText(String(text || ''));
api.saveCsv = text => {
  const target = ipcRenderer.sendSync('show-save-dialog', {
    title: '导出 Anki CSV', defaultPath: 'anki-cards.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (target) fs.writeFileSync(target, String(text), 'utf8');
  return target || '';
};
try { contextBridge.exposeInMainWorld('aiAPI', api); } catch (_) { window.aiAPI = api; }
function enter(action) { window.dispatchEvent(new CustomEvent('plugin-enter', { detail: action || {} })); }
window.exports = { 'plugin-market-ai-learning': { mode: 'none', args: {
  enter, search: (_action, _word, setList) => setList([]), select: () => {}
} } };
