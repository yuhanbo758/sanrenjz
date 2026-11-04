const { ipcRenderer, clipboard, shell } = require('electron');

const PLUGIN_NAME = '网页浏览';
window.browserAPI = {
    get: (key) => ipcRenderer.invoke('plugin-storage-get-async', PLUGIN_NAME, key),
    set: (key, value) => ipcRenderer.invoke('plugin-storage-set-async', PLUGIN_NAME, key, value),
    copy: (value) => clipboard.writeText(String(value)),
    openExternal: (url) => shell.openExternal(url)
};

window.exports = {
    'main-feature': {
        mode: 'none',
        args: {
            enter: (action) => {
                const payload = action && typeof action.payload === 'string' ? action.payload.trim() : '';
                if (payload) window.dispatchEvent(new CustomEvent('browser-open', { detail: payload }));
            },
            search: (_action, _word, callbackSetList) => callbackSetList([]),
            select: () => {}
        }
    }
};
