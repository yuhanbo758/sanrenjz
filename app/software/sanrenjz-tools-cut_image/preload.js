const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 插件配置
const PLUGIN_NAME = '图片裁剪工具';

// 服务API封装
window.services = {
    // 数据存储
    getStorageItem: (key) => {
        return ipcRenderer.sendSync('plugin-storage-get', PLUGIN_NAME, key);
    },
    
    setStorageItem: (key, value) => {
        return ipcRenderer.sendSync('plugin-storage-set', PLUGIN_NAME, key, value);
    },
    
    removeStorageItem: (key) => {
        return ipcRenderer.sendSync('plugin-storage-remove', PLUGIN_NAME, key);
    },
    
    // 文件对话框
    selectFile: (options = {}) => {
        const defaultOptions = {
            title: '选择图片文件',
            filters: [
                { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] },
                { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
                { name: 'PNG', extensions: ['png'] },
                { name: 'WebP', extensions: ['webp'] },
                { name: '所有文件', extensions: ['*'] }
            ],
            properties: ['openFile']
        };
        return ipcRenderer.sendSync('show-open-dialog', { ...defaultOptions, ...options });
    },
    
    selectFolder: () => {
        return ipcRenderer.sendSync('show-open-dialog', {
            title: '选择保存文件夹',
            properties: ['openDirectory']
        });
    },
    
    saveFile: (options = {}) => {
        const defaultOptions = {
            title: '保存图片',
            filters: [
                { name: 'PNG图片', extensions: ['png'] },
                { name: 'JPEG图片', extensions: ['jpg'] },
                { name: 'WebP图片', extensions: ['webp'] },
                { name: '所有文件', extensions: ['*'] }
            ]
        };
        return ipcRenderer.sendSync('show-save-dialog', { ...defaultOptions, ...options });
    },
    
    // 内容插入（统一改为仅复制到剪贴板，不进行自动粘贴）
    insertContent: (content, type = 'text') => {
        try {
            const { clipboard, nativeImage } = require('electron');
            if (type === 'text') {
                clipboard.writeText(String(content || ''));
            } else if (type === 'image') {
                let img = null;
                if (Buffer.isBuffer(content)) {
                    img = nativeImage.createFromBuffer(content);
                } else if (typeof content === 'string') {
                    if (content.startsWith('data:image')) {
                        const base64 = content.split(',')[1] || '';
                        img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
                    } else {
                        try { img = nativeImage.createFromPath(content); } catch {}
                    }
                }
                if (img) clipboard.writeImage(img);
            } else {
                clipboard.writeText(String(content || ''));
            }
            return Promise.resolve({ success: true, copied: true });
        } catch (e) {
            console.error('复制到剪贴板失败:', e);
            return Promise.resolve({ success: false, error: e.message });
        }
    },
    
    // 窗口控制
    closeWindow: () => {
        return ipcRenderer.invoke('close-plugin-window', PLUGIN_NAME);
    },
    
    minimizeWindow: () => {
        return ipcRenderer.invoke('minimize-plugin-window', PLUGIN_NAME);
    },
    
    maximizeWindow: () => {
        return ipcRenderer.invoke('maximize-plugin-window', PLUGIN_NAME);
    },
    
    togglePin: () => {
        return ipcRenderer.invoke('toggle-plugin-pin-window', PLUGIN_NAME);
    },
    
    // 文件系统操作
    readFile: (filePath) => {
        try {
            return fs.readFileSync(filePath);
        } catch (error) {
            console.error('读取文件失败:', error);
            return null;
        }
    },
    
    writeFile: (filePath, data) => {
        try {
            fs.writeFileSync(filePath, data);
            return true;
        } catch (error) {
            console.error('写入文件失败:', error);
            return false;
        }
    },
    
    // 获取系统字体列表
    getSystemFonts: () => {
        try {
            // 尝试通过 PowerShell 获取系统字体 (仅 Windows)
            if (process.platform === 'win32') {
                const command = `powershell -command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name"`;
                // 设置超时防止卡死
                const output = execSync(command, { encoding: 'utf8', timeout: 3000 });
                const fonts = output.split(/[\r\n]+/).map(f => f.trim()).filter(f => f);
                if (fonts.length > 0) return fonts;
            }
        } catch (e) {
            console.error('Failed to load system fonts via PowerShell:', e);
        }

        const systemFonts = [
            'Microsoft YaHei',
            'Microsoft YaHei UI',
            'SimSun',
            'SimHei',
            'KaiTi',
            'FangSong',
            'NSimSun',
            'Arial',
            'Times New Roman',
            'Helvetica',
            'Georgia',
            'Verdana',
            'Tahoma',
            'Trebuchet MS',
            'Impact',
            'Comic Sans MS',
            'Courier New',
            'Lucida Console'
        ];
        return systemFonts;
    },
    
    // 显示通知
    showNotification: (title, body) => {
        if (Notification.permission === 'granted') {
            new Notification(title, { body });
        }
    }
};

// 超级面板功能导出
window.exports = {
    "image-crop": {
        mode: "none",
        args: {
            enter: (action, callbackSetList) => {
                console.log('图片裁剪工具被调用');
                // 主功能入口 - 直接打开插件界面
                // 插件界面已经通过 main: "index.html" 自动加载
            },
            
            search: (action, searchWord, callbackSetList) => {
                // 搜索功能（当前为 none 模式，不需要实现）
                console.log('搜索功能:', searchWord);
            },
            
            select: (action, itemData) => {
                // 选择处理（当前为 none 模式，不需要实现）
                console.log('选择项目:', itemData);
            }
        }
    }
};

// 初始化函数
function initializePlugin() {
    console.log('图片裁剪工具初始化中...');
    
    // 加载配置
    const config = window.services.getStorageItem('config') || {};
    
    // 设置默认配置
    if (!config.initialized) {
        const defaultConfig = {
            initialized: true,
            version: '1.0.0',
            settings: {
                defaultFormat: 'png',
                defaultQuality: 90,
                autoSave: false,
                showGrid: true,
                defaultFont: 'Microsoft YaHei',
                defaultFontSize: 24,
                defaultTextColor: '#000000'
            },
            recentSizes: [
                { name: '微信头像', width: 200, height: 200 },
                { name: '微博封面', width: 900, height: 500 },
                { name: 'B站封面', width: 1146, height: 717 },
                { name: '抖音封面', width: 1080, height: 1920 },
                { name: 'YouTube缩略图', width: 1280, height: 720 }
            ]
        };
        
        window.services.setStorageItem('config', defaultConfig);
        console.log('默认配置已保存');
    }
    
    // 请求通知权限
    if (Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    console.log('图片裁剪工具初始化完成');
}

// 工具函数
window.utils = {
    // 格式化文件大小
    formatFileSize: (bytes) => {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    },
    
    // 生成唯一ID
    generateId: () => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },
    
    // 颜色转换
    hexToRgba: (hex, alpha = 1) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },
    
    // 计算图片缩放比例
    calculateScale: (imageWidth, imageHeight, maxWidth, maxHeight) => {
        return Math.min(maxWidth / imageWidth, maxHeight / imageHeight, 1);
    },
    
    // 获取图片信息
    getImageInfo: (imageElement) => {
        return {
            width: imageElement.naturalWidth,
            height: imageElement.naturalHeight,
            aspectRatio: imageElement.naturalWidth / imageElement.naturalHeight
        };
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', initializePlugin);

// 错误处理
window.addEventListener('error', (event) => {
    console.error('插件运行错误:', event.error);
    window.services.showNotification('图片裁剪工具', '发生了一个错误，请查看控制台获取详细信息');
});

// 导出给全局使用
window.PLUGIN_NAME = PLUGIN_NAME;
