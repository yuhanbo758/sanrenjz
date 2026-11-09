'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set(['back', 'forward', 'reload', 'home']);

contextBridge.exposeInMainWorld('builtinBrowser', {
    getState: () => ipcRenderer.invoke('builtin-browser:get-state'),
    act: action => typeof action === 'string' && actions.has(action)
        ? ipcRenderer.invoke('builtin-browser:action', action)
        : Promise.reject(new Error('不支持的导航操作')),
    onState: callback => {
        if (typeof callback !== 'function') throw new Error('导航状态回调无效');
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('builtin-browser:state', listener);
        return () => ipcRenderer.removeListener('builtin-browser:state', listener);
    }
});
