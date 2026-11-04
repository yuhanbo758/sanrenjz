const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的API给渲染进程
const electronAPI = {
    // 插件存储API
    storage: {
        set: (pluginName, key, value) => ipcRenderer.sendSync('plugin-storage-set', pluginName, key, value),
        get: (pluginName, key) => ipcRenderer.sendSync('plugin-storage-get', pluginName, key),
        remove: (pluginName, key) => ipcRenderer.sendSync('plugin-storage-remove', pluginName, key),
        setAsync: (pluginName, key, value) => ipcRenderer.invoke('plugin-storage-set-async', pluginName, key, value),
        getAsync: (pluginName, key) => ipcRenderer.invoke('plugin-storage-get-async', pluginName, key),
        removeAsync: (pluginName, key) => ipcRenderer.invoke('plugin-storage-remove-async', pluginName, key)
    },
    
    // 窗口控制API
    window: {
        minimize: (pluginName) => ipcRenderer.invoke('minimize-plugin-window', pluginName),
        maximize: (pluginName) => ipcRenderer.invoke('maximize-plugin-window', pluginName),
        close: (pluginName) => ipcRenderer.invoke('close-plugin-window', pluginName),
        togglePin: (pluginName) => ipcRenderer.invoke('toggle-plugin-pin-window', pluginName)
    },
    
    // 系统对话框API
    dialog: {
        showOpenDialog: (options) => ipcRenderer.sendSync('show-open-dialog', options),
        showSaveDialog: (options) => ipcRenderer.sendSync('show-save-dialog', options)
    },
    
    // 内容插入API（统一改为仅复制到剪贴板）
    insertion: {
        /**
         * 将内容复制到剪贴板
         * 函数级注释：
         * - 支持字符串内容；其他类型按字符串序列化处理
         * - 不再尝试在输入框中自动粘贴
         */
        handleContent: (content) => {
            try {
                const { clipboard } = require('electron');
                const text = typeof content === 'string' ? content : JSON.stringify(content);
                clipboard.writeText(text || '');
                return Promise.resolve({ success: true, copied: true });
            } catch (e) {
                console.error('复制到剪贴板失败:', e);
                return Promise.resolve({ success: false, error: e.message });
            }
        }
    }
};

// 当前插件窗口仍兼容 contextIsolation=false；此时 contextBridge 不可用，需直接挂载窄 API。
try {
    contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (error) {
    window.electronAPI = electronAPI;
}

// 预加载日志
console.log('密码管理器预加载脚本已加载');
