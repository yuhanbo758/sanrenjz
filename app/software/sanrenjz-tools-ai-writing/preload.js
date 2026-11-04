const { contextBridge, ipcRenderer, clipboard } = require('electron');
const fs = require('fs');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');
const { EXTENSIONS, extract, read } = require('./writing-files');

let emit = () => {};
const api = createAiRuntime('AI 写作工作室', chunk => emit(chunk));
api.onChunk = listener => { emit = listener; return () => { emit = () => {}; }; };
api.pickFiles = () => ipcRenderer.sendSync('show-open-dialog', {
  title: '选择写作参考文件', properties: ['openFile', 'multiSelections'],
  filters: [{ name: '写作素材', extensions: EXTENSIONS.map(ext => ext.slice(1)) }]
}) || [];
api.readFile = read;
api.readDroppedFile = (name, bytes) => extract(name, bytes);
api.copyText = text => clipboard.writeText(String(text || ''));
api.saveMarkdown = async text => {
  const target = ipcRenderer.sendSync('show-save-dialog', {
    title: '保存写作结果', defaultPath: '写作结果.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (!target) return false;
  await fs.promises.writeFile(target, String(text || ''), 'utf8');
  return true;
};
try { contextBridge.exposeInMainWorld('aiAPI', api); } catch (_) { window.aiAPI = api; }

function enter(action) { window.dispatchEvent(new CustomEvent('plugin-enter', { detail: action || {} })); }
window.exports = {
  'plugin-market-ai-writing': {
    mode: 'none', args: { enter, search: (_action, _word, setList) => setList([]), select: () => {} }
  }
};
