const { contextBridge, ipcRenderer, clipboard } = require('electron');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');
const { listPromptFiles } = require('./prompt-files');

let emit = () => {};
const api = createAiRuntime('AI 提示词工坊', chunk => emit(chunk));
api.onChunk = listener => { emit = listener; return () => { emit = () => {}; }; };
api.copyText = text => clipboard.writeText(String(text));
api.promptFiles = {
  chooseDirectory: () => {
    const result = ipcRenderer.sendSync('show-open-dialog', {
      title: '选择提示词文件夹', properties: ['openDirectory']
    });
    return result?.[0] || '';
  },
  list: directory => listPromptFiles(directory)
};
try { contextBridge.exposeInMainWorld('aiAPI', api); } catch (_) { window.aiAPI = api; }

function enter(action) { window.dispatchEvent(new CustomEvent('plugin-enter', { detail: action || {} })); }
window.exports = {
  'plugin-market-ai-prompt': { mode: 'none', args: { enter, search: (_a, _w, setList) => setList([]), select: () => {} } }
};
