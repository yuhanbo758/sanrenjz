const { contextBridge, ipcRenderer, clipboard } = require('electron');
const database = require('./database-service');

const PLUGIN_NAME = 'SQLite 数据表管理器';
const api = {
  dialog: {
    openDatabase: () => ipcRenderer.sendSync('show-open-dialog', {
      title: '打开 SQLite 数据库',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }),
    createDatabase: () => ipcRenderer.sendSync('show-save-dialog', {
      title: '创建 SQLite 数据库',
      defaultPath: 'data.db',
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    })
  },
  database: {
    inspect: database.inspectDatabase,
    schema: database.getTableSchema,
    query: database.queryRows,
    insert: database.insertRow,
    update: database.updateRow,
    delete: database.deleteRow,
    create: database.createDatabase,
    createTable: database.createTable
  },
  storage: {
    get: key => ipcRenderer.invoke('plugin-storage-get-async', PLUGIN_NAME, key),
    set: (key, value) => ipcRenderer.invoke('plugin-storage-set-async', PLUGIN_NAME, key, value)
  },
  copy: value => clipboard.writeText(String(value ?? '')),
  close: () => ipcRenderer.invoke('close-plugin-window', PLUGIN_NAME)
};

try { contextBridge.exposeInMainWorld('accountManagerAPI', api); } catch (_) { window.accountManagerAPI = api; }

window.exports = {
  'sqlite-table-manager': {
    mode: 'none',
    args: {
      enter: action => window.dispatchEvent(new CustomEvent('plugin-enter', { detail: action || {} })),
      search: (_action, _searchWord, callbackSetList) => callbackSetList([]),
      select: () => {}
    }
  }
};
