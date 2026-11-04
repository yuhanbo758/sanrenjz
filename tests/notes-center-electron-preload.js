const { contextBridge } = require('electron');
const data = {
  'md-notes': [
    { id: 1, title: '甲', content: '# 甲\n\n原文' },
    { id: 2, title: '乙', content: '第二篇' }
  ],
  stickies: [{ text: '便签原文', time: '09-27' }]
};
const api = {
  storage: {
    get: async key => JSON.parse(JSON.stringify(data[key] ?? null)),
    set: async (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); return true; }
  },
  notes: {
    copy: text => { window.copiedForTest = text; },
    importMarkdown: async () => [{ title: '导入篇', content: '# 导入成功' }],
    exportMarkdown: async (title, content) => { window.exportedForTest = { title, content }; return true; }
  }
};
window.notesDataForTest = data;
try { contextBridge.exposeInMainWorld('pluginAPI', api); }
catch (_) { window.pluginAPI = api; }
