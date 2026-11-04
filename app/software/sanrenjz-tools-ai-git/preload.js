const { contextBridge, ipcRenderer } = require('electron');
const { createAiRuntime } = require('../../plugin_runtime/ai-runtime');
const { inspectRepository, readRepository } = require('./git-service');

let emit = () => {};
const api = createAiRuntime('AI Git 助手', chunk => emit(chunk));
api.onChunk = listener => { emit = listener; return () => { emit = () => {}; }; };
api.inspectRepository = inspectRepository;
api.readRepository = readRepository;
api.pickDirectory = async () => {
  const value = await ipcRenderer.invoke('show-open-dialog', { title: '选择 Git 项目', properties: ['openDirectory'] });
  return (Array.isArray(value) ? value[0] : value?.filePaths?.[0]) || '';
};

try { contextBridge.exposeInMainWorld('aiAPI', api); } catch (_) { window.aiAPI = api; }
function entry(mode) {
  return { mode: 'none', args: {
    enter: action => window.dispatchEvent(new CustomEvent('plugin-enter', { detail: { ...action, requestedMode: mode } })),
    search: (_a, _w, setList) => setList([]), select: () => {}
  } };
}
window.exports = {
  'plugin-market-ai-git': entry('提交说明'),
  'plugin-market-ai-git-changelog': entry('变更日志'),
  'plugin-market-ai-git-release': entry('Release Notes'),
  'plugin-market-ai-git-pr': entry('PR 描述'),
  'plugin-market-ai-git-risk': entry('变更风险')
};
