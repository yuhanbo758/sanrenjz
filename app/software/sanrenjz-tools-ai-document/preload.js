const { contextBridge, ipcRenderer } = require('electron');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');
const { SUPPORTED_EXTENSIONS, extractDocument, readDocument } = require('./document-service');

let emit = () => {};
const api = createAiRuntime('AI 文档阅读器', chunk => emit(chunk));
api.onChunk = listener => { emit = listener; return () => { emit = () => {}; }; };
api.pickFiles = () => ipcRenderer.sendSync('show-open-dialog', {
  title: '选择文档',
  properties: ['openFile', 'multiSelections'],
  filters: [{ name: '文档', extensions: SUPPORTED_EXTENSIONS.map(ext => ext.slice(1)) }]
}) || [];
api.readDocument = readDocument;
api.readDroppedDocument = (name, bytes) => extractDocument(name, Buffer.from(bytes));
try { contextBridge.exposeInMainWorld('aiAPI', api); } catch (_) { window.aiAPI = api; }

function enter(action) { window.dispatchEvent(new CustomEvent('plugin-enter', { detail: action || {} })); }
window.exports = {
  'plugin-market-ai-document': {
    mode: 'none',
    args: { enter, search: (_action, _word, setList) => setList([]), select: () => {} }
  }
};
