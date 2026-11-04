const { contextBridge, ipcRenderer, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');
const service = require('./meeting-service');

let emit = () => {};
const api = createAiRuntime('AI 会议纪要', chunk => emit(chunk));
api.onChunk = listener => { emit = listener; return () => { emit = () => {}; }; };
api.pickFiles = () => ipcRenderer.sendSync('show-open-dialog', {
  title: '选择会议资料或录音', properties: ['openFile', 'multiSelections'],
  filters: [{ name: '会议资料和录音', extensions: [...service.DOCUMENT_EXTENSIONS, ...service.AUDIO_EXTENSIONS].map(ext => ext.slice(1)) }]
}) || [];
api.readFiles = async paths => {
  const results = [];
  for (const filePath of paths) {
    const stat = await fs.promises.stat(filePath);
    service.checkFile(filePath, stat.size);
    const data = await fs.promises.readFile(filePath);
    results.push({ name: path.basename(filePath), data: new Uint8Array(data), kind: service.checkFile(filePath, data.length) });
  }
  return results;
};
api.checkFile = service.checkFile;
api.extractDocument = service.extractDocument;
api.transcribeAudio = async (name, data, model, providerId) => {
  const config = await api.getConfig();
  const provider = config.providers.find(item => item.id === providerId);
  if (!provider) throw new Error('请选择语音转写供应商');
  return service.transcribeAudio({ name, data, model, provider, secret: await api.getProviderSecret(providerId) });
};
api.copyText = text => clipboard.writeText(String(text || ''));
api.saveMinutes = async text => {
  const filePath = ipcRenderer.sendSync('show-save-dialog', { title: '导出会议纪要', defaultPath: '会议纪要.md', filters: [{ name: 'Markdown', extensions: ['md'] }] });
  if (!filePath) return '';
  await fs.promises.writeFile(filePath, String(text || ''), 'utf8');
  return filePath;
};
try { contextBridge.exposeInMainWorld('aiAPI', api); } catch (_) { window.aiAPI = api; }
function enter(action) { window.dispatchEvent(new CustomEvent('plugin-enter', { detail: action || {} })); }
window.exports = { 'plugin-market-ai-meeting': { mode: 'none', args: { enter, search: (_a, _w, setList) => setList([]), select: () => {} } } };
