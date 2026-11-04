const fs = require('fs')
const path = require('path')
const { ipcRenderer } = require('electron');

// 默认设置
const DEFAULT_SETTINGS = {
    snippetsPath: '', // 旧版单一路径（保持向后兼容）
    snippetsPaths: [], // 新版多路径支持
    autoInsert: true, // 是否自动插入内容
    searchSubfolders: true, // 是否搜索子文件夹
};

// 用于存储所有文本片段的缓存
let snippetsCache = [];
const PLUGIN_NAME = '余汉波文本片段助手';
const STATE_KEY = 'snippets-activity-v1';

function getActivity() {
    const value = ipcRenderer.sendSync('plugin-storage-get', PLUGIN_NAME, STATE_KEY) || {};
    return {
        favorites: Array.isArray(value.favorites) ? value.favorites : [],
        recent: Array.isArray(value.recent) ? value.recent : []
    };
}

function saveActivity(activity) {
    if (!ipcRenderer.sendSync('plugin-storage-set', PLUGIN_NAME, STATE_KEY, activity)) {
        throw new Error('片段使用记录保存失败');
    }
}

function updateActivity(filePath, action) {
    const activity = getActivity();
    if (action === 'favorite') {
        activity.favorites = activity.favorites.includes(filePath)
            ? activity.favorites.filter(item => item !== filePath)
            : [...activity.favorites, filePath];
    } else if (action === 'used') {
        activity.recent = [filePath, ...activity.recent.filter(item => item !== filePath)].slice(0, 30);
    } else if (action === 'remove') {
        activity.favorites = activity.favorites.filter(item => item !== filePath);
        activity.recent = activity.recent.filter(item => item !== filePath);
    }
    saveActivity(activity);
    return activity;
}

// 直接插入功能的主要实现
async function insertContent(content) {
    try {
        const result = await ipcRenderer.invoke('insert-content', {
            title: '文本片段', content: String(content), contentType: 'text-snippet', directInsert: true
        });
        if (!result || !result.success) throw new Error(result && (result.error || result.message) || '插入失败');
        closePlugin();
    } catch (error) {
        showNotification('自动插入失败，内容已保留在剪贴板：' + error.message, 'error');
    }
}

// 关闭插件窗口
function closePlugin() {
    console.log('开始关闭插件窗口...');
    
    try {
        // 先隐藏搜索窗口，这会触发焦点恢复逻辑
        ipcRenderer.invoke('hide-search-window').then(() => {
            console.log('搜索窗口已隐藏');
            
            // 搜索窗口隐藏后，立即尝试恢复焦点
            setTimeout(() => {
                console.log('尝试恢复焦点到原窗口');
                ipcRenderer.invoke('restore-previous-focus').then(result => {
                    console.log('焦点恢复结果:', result);
                    
                    // 给焦点恢复一点时间，然后关闭插件窗口
                    setTimeout(() => {
                        ipcRenderer.invoke('close-plugin-window', '余汉波文本片段助手');
                        console.log('插件窗口关闭完成');
                    }, 200);
                }).catch(error => {
                    console.error('恢复焦点失败:', error);
                    // 即使焦点恢复失败，也要关闭插件窗口
                    ipcRenderer.invoke('close-plugin-window', '余汉波文本片段助手');
                });
            }, 100);
        }).catch(error => {
            console.error('隐藏搜索窗口失败:', error);
            // 即使失败也要尝试恢复焦点并关闭插件窗口
            ipcRenderer.invoke('restore-previous-focus').then(() => {
                setTimeout(() => {
                    ipcRenderer.invoke('close-plugin-window', '余汉波文本片段助手');
                }, 200);
            }).catch(e => {
                console.error('恢复焦点失败:', e);
                ipcRenderer.invoke('close-plugin-window', '余汉波文本片段助手');
            });
        });
    } catch (error) {
        console.error('关闭插件失败:', error);
        // 备用方案：直接关闭插件窗口
        try {
            ipcRenderer.invoke('close-plugin-window', '余汉波文本片段助手');
        } catch (e) {
            console.error('备用关闭方案也失败:', e);
        }
    }
}

// 显示通知
function showNotification(message, type = 'info') {
    try {
        // 使用简单的弹窗通知，可以后续改进
        if (window.parent && window.parent.showNotification) {
            window.parent.showNotification(message, type);
        } else {
            console.log(`通知 [${type}]: ${message}`);
            // 备用方案：创建一个简单的页面内通知
            const notification = document.createElement('div');
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: ${type === 'error' ? '#ff4d4f' : type === 'success' ? '#52c41a' : '#1890ff'};
                color: white;
                padding: 12px 20px;
                border-radius: 6px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                z-index: 10000;
                font-size: 14px;
                max-width: 300px;
            `;
            notification.textContent = message;
            document.body.appendChild(notification);
            
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 3000);
        }
    } catch (error) {
        console.error('显示通知失败:', error);
    }
}

// 扫描文件夹
function scanFolder() {
    console.log('开始扫描文件夹...');
    
    const settings = getSettings();
    const allSnippets = [];
    
    // 获取所有路径
    const paths = Array.isArray(settings.snippetsPaths) && settings.snippetsPaths.length > 0 
        ? settings.snippetsPaths 
        : (settings.snippetsPath ? [settings.snippetsPath] : []);
    
    if (paths.length === 0) {
        console.log('未设置有效的片段路径');
        snippetsCache = [];
        return [];
    }
    
    try {
        // 递归扫描函数
        function readDir(dir, subDir = false) {
            if (!dir || !fs.existsSync(dir)) {
                console.log(`路径不存在: ${dir}`);
                return;
            }
            
            if (!settings.searchSubfolders && subDir) {
                // 如果设置不搜索子文件夹，并且当前是子文件夹，则跳过
                return;
            }
            
            const items = fs.readdirSync(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                let stat;
                try {
                    stat = fs.lstatSync(fullPath);
                } catch (error) {
                    console.warn(`跳过无法读取的路径: ${fullPath}`, error);
                    continue;
                }
                // 不跟随符号链接，避免循环扫描或越过用户指定的目录。
                if (stat.isSymbolicLink()) continue;
                
                if (stat.isFile() && path.extname(item).toLowerCase() === '.md') {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const fileName = path.basename(item, '.md');
                        
                        allSnippets.push({
                            fileName,
                            title: fileName,
                            path: fullPath,
                            content,
                            modifiedAt: stat.mtimeMs,
                            folder: dir,
                            preview: content.slice(0, 200) + (content.length > 200 ? '...' : '')
                        });
                    } catch (error) {
                        console.error(`读取文件 ${fullPath} 失败:`, error);
                    }
                } else if (stat.isDirectory() && settings.searchSubfolders) {
                    readDir(fullPath, true);
                }
            }
        }
        
        // 扫描每个路径
        for (const folderPath of paths) {
            if (folderPath && fs.existsSync(folderPath)) {
                console.log(`扫描路径: ${folderPath}`);
                try { readDir(folderPath); } catch (error) { console.error(`扫描路径失败: ${folderPath}`, error); }
            } else {
                console.log(`跳过无效路径: ${folderPath}`);
            }
        }
        
        console.log(`共找到 ${allSnippets.length} 个片段`);
        snippetsCache = allSnippets;
        
        return allSnippets;
    } catch (error) {
        console.error('扫描文件夹失败:', error);
        return [];
    }
}

// 获取设置
function getSettings() {
    try {
        // 使用 IPC 同步调用获取插件存储数据
        const settings = ipcRenderer.sendSync('plugin-storage-get', '余汉波文本片段助手', 'snippets-settings');
        return { ...DEFAULT_SETTINGS, ...(settings || {}) };
    } catch (error) {
        console.error('获取设置失败:', error);
        return DEFAULT_SETTINGS;
    }
}

// 保存设置
function saveSettings(settings) {
    try {
        // 使用 IPC 同步调用保存插件存储数据
        const result = ipcRenderer.sendSync('plugin-storage-set', '余汉波文本片段助手', 'snippets-settings', settings);
        return result;
    } catch (error) {
        console.error('保存设置失败:', error);
        return false;
    }
}

// 创建片段时获取第一个有效路径
function getFirstValidPath(settings) {
    // 先从 snippetsPaths 中获取第一个有效路径
    if (Array.isArray(settings.snippetsPaths) && settings.snippetsPaths.length > 0) {
        for (const path of settings.snippetsPaths) {
            if (path && fs.existsSync(path)) {
                return path;
            }
        }
    }
    
    // 如果没有，则尝试使用 snippetsPath
    if (settings.snippetsPath && fs.existsSync(settings.snippetsPath)) {
        return settings.snippetsPath;
    }
    
    return null;
}

// 获取默认存储路径
function getDefaultSnippetsPath(settings) {
    // 首先使用指定的默认路径
    if (settings.defaultSnippetsPath && fs.existsSync(settings.defaultSnippetsPath)) {
        return settings.defaultSnippetsPath;
    }
    
    // 如果未指定默认路径或路径无效，则使用第一个有效路径
    return getFirstValidPath(settings);
}

function validateSnippetTitle(title) {
    const value = String(title || '').trim();
    if (!value || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(value) || /[. ]$/.test(value)) {
        throw new Error('标题不能为空，且不能包含文件名非法字符或以点、空格结尾');
    }
    if (value.length > 160) throw new Error('标题不能超过 160 个字符');
    return value;
}

function findSnippetByPath(filePath) {
    const snippet = snippetsCache.find(item => item.path === filePath);
    if (!snippet) throw new Error('片段已不在当前列表中，请刷新后重试');
    return snippet;
}

function assertUnchanged(snippet) {
    if (fs.lstatSync(snippet.path).isSymbolicLink()) throw new Error('文件已变为符号链接，请刷新后重试');
    const current = fs.readFileSync(snippet.path, 'utf8');
    if (current !== snippet.content) throw new Error('文件已被其他程序修改，请刷新后重试');
}

function writeNewSnippet(filePath, content) {
    // wx 保证已有同名文件绝不会被悄悄覆盖。
    fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
}

// 导出主要功能
window.exports = {
    // 浏览和管理文本片段
    "text-snippets": {
        mode: "list",
        args: {
            enter: (action, callbackSetList) => {
                // 刷新扫描
                const snippets = scanFolder();
                
                // 显示所有片段
                callbackSetList(snippets.map(snippet => ({
                    title: snippet.title,
                    description: snippet.preview,
                    icon: 'file-text.png',
                    data: snippet
                })));
            },
            search: (action, searchWord, callbackSetList) => {
                if (!searchWord) {
                    return callbackSetList(snippetsCache.map(snippet => ({
                        title: snippet.title,
                        description: snippet.preview,
                        icon: 'file-text.png',
                        data: snippet
                    })));
                }
                
                // 搜索匹配的片段
                const results = snippetsCache.filter(snippet => 
                    snippet.title.toLowerCase().includes(searchWord.toLowerCase()) ||
                    snippet.content.toLowerCase().includes(searchWord.toLowerCase())
                );
                
                callbackSetList(results.map(snippet => ({
                    title: snippet.title,
                    description: snippet.preview,
                    icon: 'file-text.png',
                    data: snippet
                })));
            },
            select: (action, itemData) => {
                // 当选择某一项时，插入内容
                const settings = getSettings();
                if (itemData.path) {
                    try { updateActivity(itemData.path, 'used'); } catch (error) { console.warn('最近使用记录保存失败:', error); }
                }
                if (settings.autoInsert) {
                    insertContent(itemData.content);
                } else {
                    // 如果不自动插入，只复制到剪贴板
                    const { clipboard } = require('electron');
                    clipboard.writeText(itemData.content);
                    showNotification('已复制到剪贴板', 'success');
                    closePlugin();
                }
            }
        }
    },
    
    // 设置界面
    "settings": {
        mode: "none",
        args: {
            enter: (action) => {
                // 设置插件窗口高度
                try {
                    // 通过父窗口调整高度（如果可用）
                    if (window.parent && window.parent.resizeWindow) {
                        window.parent.resizeWindow(600, 450);
                    }
                } catch (error) {
                    console.log('调整窗口大小失败:', error);
                }
            }
        }
    },
    

};

// 服务提供给渲染进程
window.services = {
    getSettings: () => getSettings(),
    
    saveSettings: (settings) => {
        const result = saveSettings(settings);
        if (result) {
            // 如果设置变更成功，重新扫描
            scanFolder();
        }
        return result;
    },
    
    selectFolder: () => {
        try {
            // 使用 IPC 同步调用显示文件夹选择对话框
            const result = ipcRenderer.sendSync('show-open-dialog', {
                title: '选择文本片段文件夹',
                properties: ['openDirectory']
            });
            return result ? result[0] : null;
        } catch (error) {
            console.error('选择文件夹失败:', error);
            return null;
        }
    },

    getSnippets: () => snippetsCache,
    
    refreshSnippets: () => {
        return scanFolder();
    },
    
    createSnippet: (title, content) => {
        const snippetsPath = getDefaultSnippetsPath(getSettings());
        if (!snippetsPath) throw new Error('请先在设置中选择有效的片段文件夹');
        const filePath = path.join(snippetsPath, `${validateSnippetTitle(title)}.md`);
        writeNewSnippet(filePath, String(content));
        scanFolder();
        return filePath;
    },
    
    deleteSnippet: (filePath) => {
        const snippet = findSnippetByPath(filePath);
        assertUnchanged(snippet);
        fs.unlinkSync(snippet.path);
        try { updateActivity(snippet.path, 'remove'); } catch (error) { console.warn('片段活动记录清理失败:', error); }
        scanFolder();
        return true;
    },
    
    editSnippet: (filePath, title, newContent) => {
        const snippet = findSnippetByPath(filePath);
        assertUnchanged(snippet);
        const nextPath = path.join(path.dirname(snippet.path), `${validateSnippetTitle(title)}.md`);
        if (nextPath !== snippet.path) {
            writeNewSnippet(nextPath, String(newContent));
            try { fs.unlinkSync(snippet.path); } catch (error) { fs.unlinkSync(nextPath); throw error; }
            const activity = getActivity();
            activity.favorites = activity.favorites.map(item => item === snippet.path ? nextPath : item);
            activity.recent = activity.recent.map(item => item === snippet.path ? nextPath : item);
            try { saveActivity(activity); } catch (error) { console.warn('片段活动记录迁移失败:', error); }
        } else {
            fs.writeFileSync(snippet.path, String(newContent), 'utf8');
        }
        scanFolder();
        return nextPath;
    },
    copySnippet: (snippet) => {
        require('electron').clipboard.writeText(String(snippet.content));
        try { updateActivity(snippet.path, 'used'); } catch (error) { console.warn('最近使用记录保存失败:', error); }
        return true;
    },
    getActivity,
    toggleFavorite: (filePath) => {
        findSnippetByPath(filePath);
        return updateActivity(filePath, 'favorite');
    },
    getClipboardText: () => require('electron').clipboard.readText(),
    duplicateSnippet: (filePath) => {
        const snippet = findSnippetByPath(filePath);
        assertUnchanged(snippet);
        const folder = path.dirname(snippet.path);
        let duplicatePath;
        for (let index = 1; index <= 100; index++) {
            const suffix = index === 1 ? ' 副本' : ` 副本 ${index}`;
            duplicatePath = path.join(folder, `${validateSnippetTitle(snippet.title + suffix)}.md`);
            if (!fs.existsSync(duplicatePath)) break;
        }
        writeNewSnippet(duplicatePath, snippet.content);
        scanFolder();
        return duplicatePath;
    },
    
    // 获取快速访问片段列表
    getQuickSnippets: (count = 5) => {
        return getQuickSnippets(count);
    },
    
    // 直接插入片段内容
    insertSnippetContent: (snippetData) => {
        if (snippetData && snippetData.content) {
            insertContent(snippetData.content);
            return true;
        }
        return false;
    },
    
    // 刷新片段缓存（保留用于兼容性）
    refreshSnippetsCache: () => {
        return scanFolder();
    }
};

// 初始化插件
(function init() {
    console.log('插件初始化中...');
    
    // 初始化扫描
    scanFolder();
    
    console.log('插件初始化完成');
})();

// 获取快速片段列表（用于超级面板）
function getQuickSnippets(count = 5) {
    return snippetsCache.slice(0, count);
}

 
