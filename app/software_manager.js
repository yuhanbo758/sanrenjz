const path = require('path');
const { spawn, fork } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { PluginCatalog } = require('./plugin-catalog');
const { removePluginPath, assertPluginAvailable } = require('./plugin-uninstall');
const { normalizePluginIdentity } = require('./plugin_store');
const { waitForPluginWindowReady } = require('./plugin_runtime/plugin-window-ready');
const { decodeUtf8Stream } = require('./console-encoding');
const { getInstalledAppRoot } = require('./install-root');
const { MacPluginDock } = require('./plugin_runtime/mac-dock');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const HOST_DEBUG_MESSAGES = new Set(['自定义标题栏创建完成', '点击最小化按钮', '点击最大化按钮', '点击关闭按钮', '注册插件进入事件', '注册插件准备就绪事件', '当前平台不支持键盘模拟', '序列化测试通过']);
const HOST_DEBUG_PREFIXES = ['点击钉住按钮，当前状态:', '钉住状态更新为:', '插件初始钉住状态:', '收到钉住状态更新事件:', '模拟键盘按键:', '键盘模拟完成，退出码:',
    '插件存储设置开始:', '插件存储设置结果:', '插件存储获取开始:', '插件存储获取完成:', '插件存储获取结果:', '插件存储删除开始:', '插件存储删除结果:', '序列化测试通过:'];

class PluginManager {
    constructor(mainWindow, { loadSettings: readHostSettings, onLog } = {}) {
        try {
            this.readHostSettings = typeof readHostSettings === 'function' ? readHostSettings : null;
            this.onLog = typeof onLog === 'function' ? onLog : () => {};
            this.loggedWebContents = new WeakSet();
            const candidatePluginDirs = app.isPackaged
                ? [
                    path.join(getInstalledAppRoot(app), 'plugins')
                ]
                : [
                    path.join(__dirname, 'software'),
                    path.join(app.getAppPath(), 'app', 'software')
                ];

            this.pluginDir = candidatePluginDirs.find((dir) => fs.existsSync(dir)) || candidatePluginDirs[0];
                
            if (!fs.existsSync(this.pluginDir)) {
                fs.mkdirSync(this.pluginDir, { recursive: true });
                console.log('创建插件目录成功:', this.pluginDir);
            }

            this.catalog = new PluginCatalog(this.pluginDir);
            this.startupPluginsPromise = null;
            this.mainWindow = mainWindow;
            this.pluginWindows = new Map(); // 存储插件窗口
            this.pluginPinnedMap = new Map(); // 存储插件窗口的钉住状态
            this.pluginProcesses = new Map(); // 存储插件进程
            this.dynamicFeatures = new Map(); // 存储插件动态注册的功能
            this.pluginAuxWindows = new Map();
            this.pluginMeta = new Map();
            this.pluginCleanupTimers = new Map();
            this.pluginBackgroundKeepAlive = new Map();
            this.macDock = new MacPluginDock({
                runtimeRoot: path.join(app.getPath('userData'), 'runtime', 'mac-plugin-dock'),
                helperPath: path.join(__dirname, 'native', 'mac-dock-helper'),
                onError: error => this.sendError(`Mac Dock 图标失败：${error.message}\n`)
            });

            console.log('PluginManager 初始化成功');
            console.log('插件目录:', this.pluginDir);

            // 添加插件数据存储管理
            this.initPluginDataStorage();

        } catch (error) {
            console.error('PluginManager 初始化失败:', error);
            throw error;
        }
    }

    // 初始化插件数据存储系统
    initPluginDataStorage() {
        // 检查是否有自定义路径设置
        const settings = this.loadSettings();
        if (settings.customPluginDataPath && fs.existsSync(settings.customPluginDataPath)) {
            this.pluginDataDir = settings.customPluginDataPath;
        } else {
            this.pluginDataDir = path.join(app.getPath('userData'), 'plugin-data');
        }
        
        // 确保插件数据目录存在
        if (!fs.existsSync(this.pluginDataDir)) {
            fs.mkdirSync(this.pluginDataDir, { recursive: true });
            console.log('创建插件数据目录:', this.pluginDataDir);
        }
    }

    // 更新插件数据存储目录
    updatePluginDataDirectory(newPath) {
        this.pluginDataDir = newPath;
        
        // 确保新目录存在
        if (!fs.existsSync(this.pluginDataDir)) {
            fs.mkdirSync(this.pluginDataDir, { recursive: true });
            console.log('创建新的插件数据目录:', this.pluginDataDir);
        }
        
        console.log('插件数据目录已更新为:', this.pluginDataDir);
    }

    // 获取插件存储文件路径
    getPluginStoragePath(pluginName) {
        return path.join(this.pluginDataDir, `${pluginName}-storage.json`);
    }

    // 读取插件存储数据
    loadPluginStorage(pluginName) {
        try {
            const storagePath = this.getPluginStoragePath(pluginName);
            if (fs.existsSync(storagePath)) {
                const data = fs.readFileSync(storagePath, 'utf8');
                return JSON.parse(data);
            }
            return {};
        } catch (error) {
            console.error(`读取插件 ${pluginName} 存储数据失败:`, error);
            return {};
        }
    }

    // 保存插件存储数据
    savePluginStorage(pluginName, data) {
        try {
            const storagePath = this.getPluginStoragePath(pluginName);
            fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), 'utf8');
            console.log(`插件 ${pluginName} 存储数据已保存到:`, storagePath);
            return true;
        } catch (error) {
            console.error(`保存插件 ${pluginName} 存储数据失败:`, error);
            return false;
        }
    }

    // 插件存储API
    getPluginStorageItem(pluginName, key) {
        try {
            console.log(`获取插件存储: ${pluginName} - ${key}`);
            const storage = this.loadPluginStorage(pluginName);
            const result = storage[key] || null;
            console.log(`存储结果:`, result);
            return result;
        } catch (error) {
            console.error(`获取插件存储失败: ${pluginName} - ${key}`, error);
            return null;
        }
    }

    setPluginStorageItem(pluginName, key, value) {
        try {
            console.log(`设置插件存储: ${pluginName} - ${key}`, '值:', value);
            
            // 确保值是可序列化的
            let serializableValue = value;
            if (typeof value === 'object' && value !== null) {
                try {
                    // 测试序列化
                    JSON.stringify(value);
                    serializableValue = value;
                } catch (serializeError) {
                    console.error('值不可序列化，转换为字符串:', serializeError);
                    serializableValue = String(value);
                }
            }
            
            const storage = this.loadPluginStorage(pluginName);
            storage[key] = serializableValue;
            const result = this.savePluginStorage(pluginName, storage);
            console.log(`存储保存结果:`, result);
            return result;
        } catch (error) {
            console.error(`设置插件存储失败: ${pluginName} - ${key}`, error);
            return false;
        }
    }

    removePluginStorageItem(pluginName, key) {
        try {
            console.log(`删除插件存储: ${pluginName} - ${key}`);
            const storage = this.loadPluginStorage(pluginName);
            delete storage[key];
            const result = this.savePluginStorage(pluginName, storage);
            console.log(`删除结果:`, result);
            return result;
        } catch (error) {
            console.error(`删除插件存储失败: ${pluginName} - ${key}`, error);
            return false;
        }
    }

    // 获取插件数据存储目录路径
    getPluginDataDirectory() {
        return this.pluginDataDir;
    }

    _pluginLogContext(pluginPath, name) {
        if (typeof pluginPath !== 'string' || !pluginPath) return null;
        return { id: `tools:${path.relative(this.pluginDir, pluginPath).split(path.sep).join('/')}`, name: name || path.basename(pluginPath) };
    }

    _emitLog(context, stream, message) {
        if (!context?.id) return;
        let text = String(message ?? '').replace(/[\r\n]+$/, '');
        if (!text) return;
        if (text.length > 16000) text = text.slice(0, 15970).replace(/[\uD800-\uDBFF]$/, '') + ' [输出过长，已截断]';
        const entry = { id: context.id, engine: 'tools', name: context.name, stream, message: text, timestamp: new Date().toISOString() };
        // 日志为旁路通知，不能因页面或日志订阅失败中断插件。
        try { Promise.resolve(this.onLog(entry)).catch(() => {}); } catch (_) {}
    }

    _attachWindowLogs(window, context) {
        const contents = window.webContents;
        if (this.loggedWebContents.has(contents)) return;
        this.loggedWebContents.add(contents);
        contents.on('console-message', (_event, level, message) => {
            const details = typeof level === 'object' && level ? level : { level, message };
            const text = String(details.message ?? '');
            const severity = Number(details.level);
            // 只剔除已知框架提示和宿主注入的调试信息，插件自身警告与错误继续保留。
            if (/^(?:%c)?Electron Security Warning\b/.test(text) || (severity < 2 && (HOST_DEBUG_MESSAGES.has(text) || HOST_DEBUG_PREFIXES.some(prefix => text.startsWith(prefix))))) return;
            this._emitLog(context, severity >= 2 ? 'stderr' : 'stdout', text);
        });
        contents.on('did-finish-load', () => this._emitLog(context, 'system', '插件页面已加载'));
        contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
            if (mainFrame !== false && code !== -3) this._emitLog(context, 'stderr', `插件页面加载失败（${code}）：${description}`);
        });
        contents.on('render-process-gone', (_event, details) => this._emitLog(context, 'stderr', `插件页面进程已退出：${details.reason}（${details.exitCode}）`));
    }

    _pipePluginOutput(stream, context, channel) {
        if (!stream) return;
        let buffered = '', truncated = false;
        const sendLine = line => channel === 'stderr' ? this.sendError(line, context) : this.sendOutput(line, context);
        decodeUtf8Stream(stream, text => {
            buffered += text;
            let boundary;
            while ((boundary = buffered.search(/[\r\n]/)) >= 0) {
                const line = buffered.slice(0, boundary);
                buffered = buffered.slice(boundary + 1);
                if (!truncated && line) sendLine(line + '\n');
                truncated = false;
            }
            if (buffered.length > 65536) {
                if (!truncated) sendLine(buffered + ' [输出过长，已截断]\n');
                buffered = ''; truncated = true;
            }
        });
        const flush = () => { if (buffered && !truncated) sendLine(buffered); buffered = ''; };
        stream.once('end', flush);
        stream.once('close', flush);
    }

    // 发送输出到主窗口，旧终端通道保持兼容。
    sendOutput(output, context, stream = 'stdout') {
        this._emitLog(context, stream, output);
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
                this.mainWindow.webContents.send('terminal-output', output);
            }
        } catch (error) {
            console.error('发送输出失败:', error);
        }
    }

    // 发送错误到主窗口
    sendError(error, context) {
        this._emitLog(context, 'stderr', error);
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
                this.mainWindow.webContents.send('terminal-error', error);
            }
        } catch (error) {
            console.error('发送错误失败:', error);
        }
    }

    // 清空输出
    clearOutput() {
        try {
            if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
                this.mainWindow.webContents.send('terminal-clear');
            }
        } catch (error) {
            console.error('清空输出失败:', error);
        }
    }

    // 注册插件动态功能
    registerDynamicFeatures(pluginName, features) {
        try {
            console.log(`注册插件动态功能: ${pluginName}, 数量: ${features.length}`);
            this.dynamicFeatures.set(pluginName, features);
            return true;
        } catch (error) {
            console.error(`注册插件动态功能失败 ${pluginName}:`, error);
            return false;
        }
    }

    // 清单读取异步合并并发请求，未变化的 JSON 不重复解析。
    async getPluginList({ force = false } = {}) {
        try {
            const entries = await this.catalog.read(force);
            return entries.map(entry => {
                const pluginConfig = entry.config;
                const pluginName = pluginConfig.pluginName || entry.folder;
                const sanitizeCmd = (c) => {
                    try {
                        if (typeof c === 'string') return c;
                        if (c && typeof c === 'object') {
                            const out = {};
                            if (c.type !== undefined) out.type = String(c.type);
                            if (typeof c.label === 'string') out.label = c.label;
                            else if (Array.isArray(c.label)) out.label = c.label.map(v => String(v));
                            if (typeof c.minLength === 'number') out.minLength = c.minLength;
                            if (typeof c.maxLength === 'number') out.maxLength = c.maxLength;
                            if (c.match) {
                                if (c.match instanceof RegExp) {
                                    out.match = { pattern: c.match.source, flags: c.match.flags };
                                } else if (typeof c.match === 'string') {
                                    out.match = c.match;
                                } else if (typeof c.match === 'object') {
                                    const m = {};
                                    for (const k of Object.keys(c.match)) {
                                        const v = c.match[k];
                                        if (v instanceof RegExp) m[k] = { pattern: v.source, flags: v.flags };
                                        else if (['string', 'number', 'boolean'].includes(typeof v)) m[k] = v;
                                    }
                                    out.match = m;
                                }
                            }
                            return out;
                        }
                        return String(c);
                    } catch (_) {
                        return String(c);
                    }
                };

                const features = Array.isArray(pluginConfig.features) ? pluginConfig.features.filter(f => f && typeof f === 'object').map(f => ({
                    code: f.code,
                    explain: f.explain,
                    cmds: Array.isArray(f.cmds) ? f.cmds.map(sanitizeCmd) : []
                })) : [];
                const dynamic = this.dynamicFeatures.get(pluginName);
                return {
                    name: pluginName,
                    description: pluginConfig.description || '暂无描述',
                    version: pluginConfig.version || '1.0.0',
                    author: pluginConfig.author || '未知',
                    category: pluginConfig.category || '工具',
                    path: entry.path,
                    iconPath: entry.iconPath,
                    main: pluginConfig.main || 'index.html',
                    features: Array.isArray(dynamic) ? features.concat(dynamic) : features
                };
            });
        } catch (error) {
            console.error('获取插件列表失败:', error);
            throw error;
        }
    }

    async getPluginManagementList() {
        const plugins = await this.getPluginList();
        const preferences = this.loadSettings().pluginPreferences || {};
        return Promise.all(plugins.map(async plugin => {
            let storage = {};
            try {
                storage = JSON.parse(await fs.promises.readFile(this.getPluginStoragePath(plugin.name), 'utf8'));
            } catch (error) {
                if (error.code !== 'ENOENT') console.warn(`读取插件管理设置失败 ${plugin.name}:`, error.message);
            }
            // 只返回管理所需的布尔选项，不能把插件存储中的凭据等内容发给页面。
            const pluginSettings = {};
            for (const key of ['autoSeparate', 'exitOnBackground', 'autoStartWithMain', 'pushToSearch']) {
                pluginSettings[key] = storage?.[key] === true;
            }
            pluginSettings.showInMainUI = true;
            for (const key of ['autoStartWithMain', 'showInMainUI']) {
                if (typeof preferences[plugin.name]?.[key] === 'boolean') {
                    pluginSettings[key] = preferences[plugin.name][key];
                }
            }
            return { ...plugin, pluginSettings };
        }));
    }

    startConfiguredPlugins(shouldStop = () => false) {
        if (this.startupPluginsPromise) return this.startupPluginsPromise;
        this.startupPluginsPromise = (async () => {
            const plugins = await this.getPluginManagementList();
            const results = [];
            // 在首屏加载后逐个启动；只打开插件，不自动执行其第一个业务功能。
            for (const plugin of plugins.filter(item => item.pluginSettings.autoStartWithMain)) {
                if (shouldStop()) break;
                try {
                    const result = await this.runPlugin(plugin.path, []);
                    if (!result?.success) throw new Error(result?.error || '插件启动失败');
                    const win = this.pluginWindows.get(plugin.name);
                    if (win) await waitForPluginWindowReady(win.webContents);
                    results.push({ name: plugin.name, success: true });
                } catch (error) {
                    console.warn(`自动启动插件失败 ${plugin.name}:`, error.message);
                    results.push({ name: plugin.name, success: false, error: error.message });
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return results;
        })();
        return this.startupPluginsPromise;
    }

    // 卸载插件
    async uninstallPlugin(pluginName, pluginPath) {
        try {
            const plugins = await this.getPluginList({ force: true });
            const matches = plugins.filter(p => pluginPath ? p.path === pluginPath : p.name === pluginName);
            if (matches.length > 1) throw new Error('存在同名插件，请从插件管理中选择具体插件卸载');
            const plugin = matches[0];
            if (!plugin) {
                throw new Error(`找不到插件: ${pluginName}`);
            }
            const win = this.pluginWindows.get(plugin.name);
            const child = this.pluginProcesses.get(plugin.name);
            if ((win && !win.isDestroyed()) || (child && child.exitCode == null)) {
                throw new Error('请先关闭正在运行的插件再卸载');
            }
            await removePluginPath(this.pluginDir, plugin.path, `tools:${normalizePluginIdentity(plugin.name)}`);
            this.dynamicFeatures.delete(plugin.name);
            await this.getPluginList({ force: true });
            return { success: true, message: `插件 ${pluginName} 已卸载` };
        } catch (error) {
            console.error(`卸载插件 ${pluginName} 失败:`, error);
            return { success: false, error: error.message };
        }
    }

    // 执行插件
    async runPlugin(pluginPath, features = []) {
        let logContext = this._pluginLogContext(pluginPath);
        try {
            assertPluginAvailable(pluginPath);
            console.log('开始执行插件:', pluginPath);
            
            const pluginJsonPath = path.join(pluginPath, 'plugin.json');
            
            if (!fs.existsSync(pluginJsonPath)) {
                throw new Error(`插件配置文件不存在: ${pluginJsonPath}`);
            }

            const pluginConfig = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
            logContext = this._pluginLogContext(pluginPath, pluginConfig.pluginName);
            const mainFile = pluginConfig.main || 'index.html';
            const mainFilePath = path.join(pluginPath, mainFile);

            if (!fs.existsSync(mainFilePath)) {
                throw new Error(`插件主文件不存在: ${mainFilePath}`);
            }

            // 根据主文件类型决定执行方式
            const fileExt = path.extname(mainFile).toLowerCase();
            
            if (fileExt === '.html') {
                // HTML插件
                // 如果有指定要运行的功能，直接使用 runPluginAction 执行
                if (features && Array.isArray(features) && features.length > 0 && features[0].code) {
                    console.log('插件启动时执行指定功能:', features[0].code);
                    // runPluginAction 会自动处理窗口创建和等待
                    const result = await this.runPluginAction(pluginPath, features[0], '');
                    if (result?.success === false) return result;
                } else {
                    // 否则只创建新窗口显示
                    await this.createPluginWindow(pluginPath, pluginConfig);
                }
            } else if (fileExt === '.js') {
                // JavaScript插件，在Node.js环境中执行
                await this.executeJavaScriptPlugin(pluginPath, pluginConfig);
            } else {
                throw new Error(`不支持的插件类型: ${fileExt}`);
            }

            this.sendOutput(`插件 ${pluginConfig.pluginName || path.basename(pluginPath)} 启动成功\n`, logContext, 'system');
            return { success: true };
            
        } catch (error) {
            console.error('执行插件失败:', error);
            const errorMsg = `执行插件失败: ${error.message}\n`;
            this.sendError(errorMsg, logContext);
            return { success: false, error: error.message };
        }
    }
    
    // 创建插件窗口（适用于HTML插件）
    async createPluginWindow(pluginPath, pluginConfig, options = {}) {
        const pluginName = pluginConfig.pluginName || path.basename(pluginPath);
        const logContext = this._pluginLogContext(pluginPath, pluginName);
        const startHidden = options.startHidden === true;
        
        // 检查插件是否已经在运行
        if (this.pluginWindows.has(pluginName)) {
            const existingWindow = this.pluginWindows.get(pluginName);
            
            // 如果现有窗口还未销毁
            if (existingWindow && !existingWindow.isDestroyed()) {
                this._attachWindowLogs(existingWindow, logContext);
                this._emitLog(logContext, 'system', '已打开现有插件窗口');
                console.log(`插件 ${pluginName} 已经在运行，聚焦到现有窗口`);
                
                // 截图优先入口必须保持隐藏，避免完整翻译界面先于截图遮罩闪现。
                if (startHidden) {
                    existingWindow.hide();
                } else {
                    if (!existingWindow.isVisible()) existingWindow.show();
                    existingWindow.focus();
                }
                this.clearPluginCleanupTimer(pluginName);
                
                // 返回现有窗口，不创建新窗口
                return existingWindow;
            } else {
                // 如果窗口已销毁，清理引用
                this.pluginWindows.delete(pluginName);
                this.pluginPinnedMap.delete(pluginName);
                console.log(`插件 ${pluginName} 的旧窗口已销毁，将创建新窗口`);
            }
        }

        const mainFile = pluginConfig.main || 'index.html';
        const mainFilePath = path.join(pluginPath, mainFile);
        
        console.log(`创建新的插件窗口: ${pluginName}`);
        
        // 获取插件图标路径
        const pluginIconPath = this.getPluginIconPath(pluginPath);
        console.log(`插件 ${pluginName} 图标路径: ${pluginIconPath}`);

        // 获取插件的自定义设置
        const autoSeparate = this.getPluginStorageItem(pluginName, 'autoSeparate') || false;
        const exitOnBackground = this.getPluginStorageItem(pluginName, 'exitOnBackground') || false;
        console.log(`插件 ${pluginName} 设置: autoSeparate=${autoSeparate}, exitOnBackground=${exitOnBackground}`);
        
        // 创建插件窗口，默认不显示在任务栏，且不置顶
        // 如果开启了自动分离，则允许最小化且显示在任务栏
        const pluginWindow = new BrowserWindow({
            width: pluginConfig.pluginSetting?.width || 800,
            height: pluginConfig.pluginSetting?.height || 600,
            title: pluginName,
            icon: pluginIconPath, // 设置窗口图标
            skipTaskbar: !autoSeparate,  // 如果自动分离，则显示在任务栏
            alwaysOnTop: false, // 默认不置顶
            minimizable: true,  // 允许最小化
            resizable: true,    // 允许调整大小
            frame: false,       // 隐藏默认窗口边框，使用自定义标题栏
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true,
                webSecurity: false,
                webviewTag: pluginName === '网页浏览',
                // 如果有preload脚本，加载它
                preload: pluginConfig.preload ? path.join(pluginPath, pluginConfig.preload) : undefined
            },
            show: false
        });
        this._attachWindowLogs(pluginWindow, logContext);
        this._emitLog(logContext, 'system', '插件窗口已创建');

        if (pluginName === '网页浏览') {
            pluginWindow.webContents.on('will-attach-webview', (event, preferences, params) => {
                if (!/^https?:\/\//i.test(params.src || '')) {
                    event.preventDefault();
                    return;
                }
                delete preferences.preload;
                delete preferences.preloadURL;
                preferences.nodeIntegration = false;
                preferences.contextIsolation = true;
                preferences.webSecurity = true;
                preferences.sandbox = true;
            });
            pluginWindow.webContents.on('did-attach-webview', (_event, guest) => {
                guest.on('will-navigate', (event, url) => {
                    if (!/^https?:\/\//i.test(url)) event.preventDefault();
                });
                // 站点的 target=_blank 仍可用，但只复用隔离的网页容器。
                guest.setWindowOpenHandler(({ url }) => {
                    if (/^https?:\/\//i.test(url)) guest.loadURL(url).catch(() => {});
                    return { action: 'deny' };
                });
            });
        }

        // 为插件窗口设置独特的应用ID，确保在任务栏中独立显示
        try {
            if (process.platform === 'win32') {
                // 使用插件目录名作为唯一标识，避免中文名称去除非法字符后重复的问题
                const folderName = path.basename(pluginPath);
                // 确保ID只包含安全字符，虽然文件夹名通常是安全的，但为了AppID规范还是处理一下
                const safeId = folderName.replace(/[^a-zA-Z0-9\-_]/g, '');
                const appId = `SanRenJuZhi.Plugin.${safeId}`;
                console.log(`为插件 ${pluginName} (目录: ${folderName}) 设置应用ID: ${appId}`);
                
                // 准备应用详情参数
                const appDetails = {
                    appId: appId,
                    appIconIndex: 0,
                    relaunchCommand: '', // 空字符串表示不提供重启命令
                    relaunchDisplayName: pluginName
                };
                
                // 获取.ico格式的图标用于任务栏显示
                const icoIconPath = this.getPluginIcoPath(pluginPath);
                
                // 缓存图标，确保每个插件有独立的文件路径
                const cachedIconPath = this.cachePluginIcon(folderName, icoIconPath);
                
                if (cachedIconPath) {
                    appDetails.appIconPath = cachedIconPath;
                    console.log(`任务栏将使用缓存图标: ${cachedIconPath}`);
                } else {
                    console.log(`插件 ${pluginName} 没有可用的.ico图标，任务栏将使用默认图标`);
                }
                
                pluginWindow.setAppDetails(appDetails);
            }
        } catch (error) {
            console.error(`设置插件 ${pluginName} 的应用详情失败:`, error);
        }

        // 插件窗口按键监听：只处理窗口控制快捷键，不处理钉住快捷键
        pluginWindow.webContents.on('before-input-event', (event, input) => {
            // Ctrl+W 关闭插件窗口
            if (input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'w') {
                console.log('插件窗口内Ctrl+W被触发，关闭窗口');
                this.stopPlugin(pluginName);
                event.preventDefault();
                return;
            }
            
            // 其他快捷键不拦截，让全局快捷键正常工作
            // 特别注意：不要在这里处理钉住快捷键，避免与全局快捷键冲突
        });

        // 初始化钉住状态
        this.pluginPinnedMap.set(pluginName, autoSeparate);
        console.log(`插件 ${pluginName} 钉住状态初始化为: ${autoSeparate}`);

        // 失去焦点时隐藏窗口（除非被钉住）
        pluginWindow.on('blur', () => {
            const pinned = this.pluginPinnedMap.get(pluginName);
            console.log(`插件 ${pluginName} 失去焦点，钉住状态: ${pinned}`);
            
            // 如果设置了“退出到后台立即结束运行”
            // 且未被钉住，则直接停止插件
            if (exitOnBackground && !pinned) {
                 console.log(`插件 ${pluginName} 设置了退出即结束，且未钉住，正在停止...`);
                 this.stopPlugin(pluginName);
                 return;
            }

            // 如果没有钉住，延迟隐藏窗口以允许快捷键操作
            if (!pinned && pluginWindow && !pluginWindow.isDestroyed()) {
                // 延迟500ms隐藏，给钉住快捷键操作留出充足时间
                setTimeout(() => {
                    // 再次检查钉住状态，可能在延迟期间被改变了
                    const currentPinned = this.pluginPinnedMap.get(pluginName);
                    if (!currentPinned && pluginWindow && !pluginWindow.isDestroyed() && !pluginWindow.isFocused()) {
                        console.log(`插件 ${pluginName} 因失去焦点而隐藏`);
                        pluginWindow.hide();
                        const keepAlive = this.pluginBackgroundKeepAlive.get(pluginName) === true;
                        if (!keepAlive) {
                            this.schedulePluginCleanup(pluginName, 3 * 60 * 1000);
                        }
                    }
                }, 500);
            }
            // 如果已钉住，保持显示状态
        });

        // 窗口关闭时清理状态
        pluginWindow.on('closed', () => {
            this.macDock.unpin(pluginName);
            this._emitLog(logContext, 'system', '插件窗口已关闭');
            console.log(`插件窗口关闭，清理状态: ${pluginName}`);
            this.closePluginIndicatorWindow(pluginName);
            this.pluginWindows.delete(pluginName);
            this.pluginPinnedMap.delete(pluginName);
            this.pluginMeta.delete(pluginName);
            this.clearPluginCleanupTimer(pluginName);
        });

        // 监听窗口最大化/还原状态变化
        pluginWindow.on('maximize', () => {
            if (pluginWindow.webContents) {
                pluginWindow.webContents.send('window-maximized', true);
            }
        });

        pluginWindow.on('unmaximize', () => {
            if (pluginWindow.webContents) {
                pluginWindow.webContents.send('window-maximized', false);
            }
        });

        // 为插件窗口注入全局变量
        pluginWindow.webContents.once('dom-ready', () => {
            // 注入阻止右键长按默认菜单的逻辑
            try {
                // 读取设置中的延迟时间
                const settings = this.loadSettings();
                const longPressDelay = settings.rightClickDelay || 300;
                const enableRightClickPanel = settings.enableRightClickPanel !== false; // 默认为true

                if (enableRightClickPanel) {
                    pluginWindow.webContents.executeJavaScript(`
                        (function() {
                            let rightClickTimer = null;
                            let isLongPress = false;
                            const LONG_PRESS_DELAY = ${longPressDelay};

                            document.addEventListener('mousedown', (e) => {
                                if (e.button === 2) { // 右键
                                    isLongPress = false;
                                    rightClickTimer = setTimeout(() => {
                                        isLongPress = true;
                                        // console.log('检测到右键长按，准备阻止默认菜单');
                                    }, LONG_PRESS_DELAY);
                                }
                            });

                            document.addEventListener('mouseup', (e) => {
                                if (e.button === 2) {
                                    if (rightClickTimer) {
                                        clearTimeout(rightClickTimer);
                                        rightClickTimer = null;
                                    }
                                }
                            });
                            
                            document.addEventListener('contextmenu', (e) => {
                                if (isLongPress) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    // console.log('已阻止右键长按触发的默认菜单');
                                    isLongPress = false; // 重置状态
                                    return false;
                                }
                            }, true); // 使用捕获阶段以确保优先处理
                        })();
                    `).catch(err => console.error('注入右键长按拦截脚本失败:', err));
                }
            } catch (error) {
                console.error('注入右键拦截逻辑失败:', error);
            }

            // 添加完整的自定义标题栏样式
            pluginWindow.webContents.insertCSS(`
                /* 自定义标题栏样式 */
                .custom-title-bar {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 32px;
                    background: #f8f9fa;
                    border-bottom: 1px solid #e1e4e8;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    z-index: 10000;
                    -webkit-app-region: drag;
                    user-select: none;
                }
                
                .title-bar-title {
                    flex: 1;
                    padding-left: 12px;
                    font-size: 14px;
                    color: #24292e;
                    font-weight: 500;
                    -webkit-app-region: drag;
                }
                
                .title-bar-controls {
                    display: flex;
                    align-items: center;
                    -webkit-app-region: no-drag;
                }
                
                .title-bar-pin-button {
                    background: transparent;
                    border: none;
                    border-radius: 3px;
                    padding: 4px 8px;
                    font-size: 14px;
                    cursor: pointer;
                    user-select: none;
                    transition: all 0.3s;
                    width: 32px;
                    height: 28px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    -webkit-app-region: no-drag;
                    margin-right: 4px;
                    color: #666;
                }
                .title-bar-pin-button:hover {
                    background: #e1e4e8;
                }
                .title-bar-pin-button.pinned {
                    background: #0078d4 !important;
                    color: white !important;
                }
                .title-bar-pin-button.pinned:hover {
                    background: #106ebe !important;
                }
                
                .window-control-button {
                    background: transparent;
                    border: none;
                    width: 46px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    font-size: 12px;
                    transition: background-color 0.2s;
                    -webkit-app-region: no-drag;
                }
                
                .window-control-button:hover {
                    background: #e1e4e8;
                }
                
                .window-control-button.close:hover {
                    background: #e13238;
                    color: white;
                }
                
                /* 调整页面内容位置 */
                body {
                    padding-top: 32px !important;
                }
            `);
            
            // 注入插件路径和配置
            pluginWindow.webContents.executeJavaScript(`
                try {
                    // 创建完整的自定义标题栏
                    const { ipcRenderer } = require('electron');
                    // 安全地定义插件名称，避免字符串转义问题
                    const pluginName = ${JSON.stringify(pluginName)};
                    const pluginIconPath = ${JSON.stringify(pluginIconPath)};
                    
                    // 创建标题栏容器
                    const titleBar = document.createElement('div');
                    titleBar.className = 'custom-title-bar';
                    
                    // 创建标题区域
                    const titleElement = document.createElement('div');
                    titleElement.className = 'title-bar-title';
                    
                    // 如果有插件图标，创建图标元素
                    if (pluginIconPath) {
                        const iconElement = document.createElement('img');
                        iconElement.src = 'file://' + pluginIconPath.replace(/\\\\/g, '/');
                        iconElement.style.cssText = \`
                            width: 16px;
                            height: 16px;
                            margin-right: 8px;
                            vertical-align: middle;
                        \`;
                        iconElement.onerror = function() {
                            // 如果图标加载失败，隐藏图标元素
                            this.style.display = 'none';
                        };
                        titleElement.appendChild(iconElement);
                    }
                    
                    // 添加标题文本
                    const titleText = document.createElement('span');
                    titleText.textContent = pluginName;
                    titleElement.appendChild(titleText);
                    
                    // 创建控制按钮区域
                    const controlsContainer = document.createElement('div');
                    controlsContainer.className = 'title-bar-controls';
                    
                    // 创建钉住按钮
                    const pinButton = document.createElement('button');
                    pinButton.className = 'title-bar-pin-button';
                    pinButton.innerHTML = '📌'; // 使用innerHTML而不是textContent以支持emoji
                    pinButton.title = '钉住到任务栏';
                    
                    let isPinned = false;
                    
                    // 更新钉住按钮状态的函数
                    function updatePinButtonState(pinned) {
                        isPinned = pinned;
                        if (isPinned) {
                            pinButton.classList.add('pinned');
                            pinButton.innerHTML = '📌'; // 钉住时显示实心图钉
                            pinButton.title = '已钉住 - 点击取消钉住';
                            pinButton.style.background = '#0078d4';
                            pinButton.style.color = 'white';
                        } else {
                            pinButton.classList.remove('pinned');
                            pinButton.innerHTML = '📍'; // 未钉住时显示空心图钉
                            pinButton.title = '钉住到任务栏';
                            pinButton.style.background = 'transparent';
                            pinButton.style.color = '#666';
                        }
                    }
                    
                    // 钉住按钮点击事件
                    pinButton.addEventListener('click', async () => {
                        try {
                            console.log('点击钉住按钮，当前状态:', isPinned);
                            const newStatus = await ipcRenderer.invoke('toggle-plugin-pin-window', pluginName);
                            console.log('钉住状态更新为:', newStatus);
                            updatePinButtonState(newStatus);
                        } catch (error) {
                            console.error('切换钉住状态失败:', error);
                        }
                    });
                    
                    // 创建最小化按钮
                    const minimizeButton = document.createElement('button');
                    minimizeButton.className = 'window-control-button minimize';
                    minimizeButton.innerHTML = '&#8211;';
                    minimizeButton.title = '最小化';
                    minimizeButton.addEventListener('click', async () => {
                        try {
                            console.log('点击最小化按钮');
                            await ipcRenderer.invoke('minimize-plugin-window', pluginName);
                        } catch (error) {
                            console.error('最小化失败:', error);
                        }
                    });
                    
                    // 创建最大化/还原按钮
                    const maximizeButton = document.createElement('button');
                    maximizeButton.className = 'window-control-button maximize';
                    maximizeButton.innerHTML = '&#9633;';
                    maximizeButton.title = '最大化';
                    maximizeButton.addEventListener('click', async () => {
                        try {
                            console.log('点击最大化按钮');
                            const isMaximized = await ipcRenderer.invoke('maximize-plugin-window', pluginName);
                            if (isMaximized) {
                                maximizeButton.title = '还原';
                                maximizeButton.innerHTML = '&#9635;';
                            } else {
                                maximizeButton.title = '最大化';
                                maximizeButton.innerHTML = '&#9633;';
                            }
                        } catch (error) {
                            console.error('最大化失败:', error);
                        }
                    });
                    
                    // 创建关闭按钮
                    const closeButton = document.createElement('button');
                    closeButton.className = 'window-control-button close';
                    closeButton.innerHTML = '&#10005;';
                    closeButton.title = '关闭';
                    closeButton.addEventListener('click', async () => {
                        try {
                            console.log('点击关闭按钮');
                            await ipcRenderer.invoke('close-plugin-window', pluginName);
                        } catch (error) {
                            console.error('关闭失败:', error);
                        }
                    });
                    
                    // 组装控制按钮
                    controlsContainer.appendChild(pinButton);
                    controlsContainer.appendChild(minimizeButton);
                    controlsContainer.appendChild(maximizeButton);
                    controlsContainer.appendChild(closeButton);
                    
                    // 组装标题栏
                    titleBar.appendChild(titleElement);
                    titleBar.appendChild(controlsContainer);
                    
                    // 初始化钉住状态
                    ipcRenderer.invoke('get-plugin-pin-status-window', pluginName).then(status => {
                        console.log('插件初始钉住状态:', pluginName, status);
                        updatePinButtonState(status);
                    }).catch(error => {
                        console.error('获取钉住状态失败:', error);
                        updatePinButtonState(false); // 默认未钉住
                    });
                    
                    // 添加标题栏到页面
                    document.body.appendChild(titleBar);
                    
                    // 监听窗口状态变化
                    ipcRenderer.on('window-maximized', (event, isMaximized) => {
                        if (isMaximized) {
                            maximizeButton.title = '还原';
                            maximizeButton.innerHTML = '&#9635;';
                        } else {
                            maximizeButton.title = '最大化';
                            maximizeButton.innerHTML = '&#9633;';
                        }
                    });
                    
                    // 监听钉住状态更新事件
                    ipcRenderer.on('pin-status-updated', (event, newPinStatus) => {
                        console.log('收到钉住状态更新事件:', newPinStatus);
                        updatePinButtonState(newPinStatus);
                    });
                    
                    console.log('自定义标题栏创建完成');
                } catch (error) {
                    console.error('创建标题栏失败:', error);
                }
                
                // 安全地定义变量，避免字符串转义问题
                window.pluginPath = ${JSON.stringify(pluginPath)};
                window.pluginConfig = ${JSON.stringify(pluginConfig)};
                window.currentPluginName = ${JSON.stringify(pluginName)};
                
                // 模拟uTools API的基本功能
                window.utools = {
                    // 输出插件信息
                    outPlugin: () => {
                        require('electron').ipcRenderer.invoke('close-plugin-window', window.currentPluginName);
                    },
                    
                    // 隐藏主窗口
                    hideMainWindow: () => {
                        try {
                            const remote = require('@electron/remote');
                            remote.getCurrentWindow().hide();
                        } catch (error) {
                            console.warn('无法使用remote模块隐藏窗口:', error);
                            // 使用IPC作为备选方案
                            require('electron').ipcRenderer.invoke('hide-main-window');
                        }
                    },
                    
                    // 显示主窗口
                    showMainWindow: () => {
                        try {
                            const remote = require('@electron/remote');
                            remote.getCurrentWindow().show();
                        } catch (error) {
                            console.warn('无法使用remote模块显示窗口:', error);
                            // 使用IPC作为备选方案
                            require('electron').ipcRenderer.invoke('show-main-window');
                        }
                    },
                    
                    // 复制文本到剪贴板
                    copyText: (text) => {
                        require('electron').clipboard.writeText(text);
                    },
                    
                    // 获取剪贴板文本
                    getCopyedText: () => {
                        return require('electron').clipboard.readText();
                    },
                    
                    // 模拟键盘按键
                    simulateKeyboardTap: (key, ...modifiers) => {
                        try {
                            console.log('模拟键盘按键:', key, modifiers);
                            
                            if (process.platform === 'win32') {
                                // 在Windows上使用PowerShell实现键盘模拟
                                const { spawn } = require('child_process');
                                
                                let keyString = '';
                                if (modifiers.includes('ctrl')) keyString += '^';
                                if (modifiers.includes('shift')) keyString += '+';
                                if (modifiers.includes('alt')) keyString += '%';
                                keyString += key;
                                
                                const psScript = \`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("\${keyString}")\`;
                                
                                const ps = spawn('powershell', [
                                    '-Command', psScript
                                ], { 
                                    windowsHide: true,
                                    stdio: 'ignore'
                                });
                                
                                ps.on('close', (code) => {
                                    console.log(\`键盘模拟完成，退出码: \${code}\`);
                                });
                                
                                return true;
                            } else {
                                console.log('当前平台不支持键盘模拟');
                                return false;
                            }
                        } catch (error) {
                            console.error('键盘模拟失败:', error);
                            return false;
                        }
                    },
                    
                    // 显示通知
                    showNotification: (message) => {
                        try {
                            const { Notification } = require('electron');
                            if (Notification.isSupported()) {
                                const notification = new Notification({
                                    title: '插件通知',
                                    body: message,
                                    timeoutType: 'default'
                                });
                                notification.show();
                            } else {
                                console.log('通知:', message);
                            }
                        } catch (error) {
                            console.error('显示通知失败:', error);
                        }
                    },
                    
                    // 插件本地存储
                    dbStorage: {
                        setItem: (key, value) => {
                            try {
                                console.log('插件存储设置开始:', window.currentPluginName, key, typeof value);
                                
                                // 深度克隆并确保值是可序列化的
                                let serializableValue;
                                try {
                                    // 先尝试序列化测试
                                    const testSerialization = JSON.stringify(value);
                                    // 如果成功，再反序列化以确保数据完整性
                                    serializableValue = JSON.parse(testSerialization);
                                    console.log('序列化测试通过');
                                } catch (serializeError) {
                                    console.error('值不可序列化，转换为字符串:', serializeError);
                                    serializableValue = String(value);
                                }
                                
                                const { ipcRenderer } = require('electron');
                                // 使用同步IPC调用主进程的存储API
                                const result = ipcRenderer.sendSync('plugin-storage-set', window.currentPluginName, key, serializableValue);
                                console.log('插件存储设置结果:', window.currentPluginName, key, '成功:', result);
                                return result;
                            } catch (error) {
                                console.error('插件存储设置失败:', error);
                                alert('保存设置失败: ' + error.message);
                                return false;
                            }
                        },
                        getItem: (key) => {
                            try {
                                console.log('插件存储获取开始:', window.currentPluginName, key);
                                const { ipcRenderer } = require('electron');
                                // 使用同步IPC调用主进程的存储API
                                const result = ipcRenderer.sendSync('plugin-storage-get', window.currentPluginName, key);
                                console.log('插件存储获取完成:', window.currentPluginName, key);
                                return result;
                            } catch (error) {
                                console.error('插件存储获取失败:', error);
                                return null;
                            }
                        },
                        removeItem: (key) => {
                            try {
                                console.log('插件存储删除开始:', window.currentPluginName, key);
                                const { ipcRenderer } = require('electron');
                                // 使用同步IPC调用主进程的存储API
                                const result = ipcRenderer.sendSync('plugin-storage-remove', window.currentPluginName, key);
                                console.log('插件存储删除结果:', window.currentPluginName, key, '成功:', result);
                                return result;
                            } catch (error) {
                                console.error('插件存储删除失败:', error);
                                return false;
                            }
                        }
                    },
                    
                    // 显示文件/文件夹选择对话框
                    showOpenDialog: (options) => {
                        try {
                            const { ipcRenderer } = require('electron');
                            const defaultOptions = {
                                title: '选择文件或文件夹',
                                properties: ['openFile']
                            };
                            const dialogOptions = { ...defaultOptions, ...options };
                            const result = ipcRenderer.sendSync('show-open-dialog', dialogOptions);
                            return result;
                        } catch (error) {
                            console.error('文件选择对话框错误:', error);
                            return null;
                        }
                    },
                    
                    // 切换钉住状态
                    togglePin: () => {
                        const { ipcRenderer } = require('electron');
                        return ipcRenderer.invoke('toggle-plugin-pin-window', window.currentPluginName);
                    },
                    
                    // 获取钉住状态
                    getPinStatus: () => {
                        const { ipcRenderer } = require('electron');
                        return ipcRenderer.invoke('get-plugin-pin-status-window', window.currentPluginName);
                    },
                    
                    // 插件进入事件（兼容性方法）
                    onPluginEnter: (callback) => {
                        console.log('注册插件进入事件');
                        setTimeout(() => {
                            if (callback) {
                                callback({
                                    code: 'main',
                                    type: 'enter',
                                    payload: null
                                });
                            }
                        }, 100);
                    },
                    
                    // 插件准备就绪事件
                    onPluginReady: (callback) => {
                        console.log('注册插件准备就绪事件');
                        setTimeout(() => {
                            if (callback) {
                                callback();
                            }
                        }, 200);
                    }
                };
                // executeJavaScript 会把最后一个表达式传回主进程；避免返回含函数的 utools 对象。
                true;
            `).catch(error => console.error('注入插件全局变量失败:', error));
        });

        // 加载插件主页面
        pluginWindow.loadFile(mainFilePath).catch(error => {
            console.error(`插件页面加载失败 ${pluginName}:`, error.message);
        });

        // 窗口准备显示时显示窗口，但不立即获取焦点
        pluginWindow.once('ready-to-show', () => {
            try {
                // 获取鼠标位置并在鼠标所在的屏幕显示插件窗口
                const { screen } = require('electron');
                const cursorPoint = screen.getCursorScreenPoint();
                const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
                
                const windowWidth = pluginConfig.pluginSetting?.width || 800;
                const windowHeight = pluginConfig.pluginSetting?.height || 600;
                
                // 计算窗口位置，在屏幕中央显示
                let x = currentDisplay.workArea.x + Math.round((currentDisplay.workArea.width - windowWidth) / 2);
                let y = currentDisplay.workArea.y + Math.round((currentDisplay.workArea.height - windowHeight) / 2);
                
                // 边界检查，确保窗口在屏幕内
                if (x < currentDisplay.workArea.x) {
                    x = currentDisplay.workArea.x + 10;
                }
                if (x + windowWidth > currentDisplay.workArea.x + currentDisplay.workArea.width) {
                    x = currentDisplay.workArea.x + currentDisplay.workArea.width - windowWidth - 10;
                }
                if (y < currentDisplay.workArea.y) {
                    y = currentDisplay.workArea.y + 10;
                }
                if (y + windowHeight > currentDisplay.workArea.y + currentDisplay.workArea.height) {
                    y = currentDisplay.workArea.y + currentDisplay.workArea.height - windowHeight - 10;
                }
                
                pluginWindow.setBounds({ x, y, width: windowWidth, height: windowHeight });
                console.log(`插件窗口 ${pluginName} 将在屏幕 ${currentDisplay.id} 显示，位置: (${x}, ${y})`);
            } catch (error) {
                console.error('设置插件窗口位置失败，使用默认位置:', error);
            }
            
            if (!startHidden) {
                pluginWindow.show();
                // 延迟获取焦点，避免与搜索窗口的焦点恢复冲突
                setTimeout(() => {
                    if (pluginWindow && !pluginWindow.isDestroyed()) pluginWindow.focus();
                }, 800);
            }
            this.clearPluginCleanupTimer(pluginName);
        });

        // 存储窗口引用
        this.pluginMeta.set(pluginName, { pluginPath, pluginConfig });
        this.pluginBackgroundKeepAlive.set(pluginName, false);
        this.pluginWindows.set(pluginName, pluginWindow);
        if (autoSeparate) {
            try { this.syncPluginDock(pluginName, true); }
            catch (error) { this.stopPlugin(pluginName); throw error; }
        }
        
        return pluginWindow;
    }

    createOrShowPluginIndicatorWindow(pluginName) {
        const key = `${pluginName}::indicator`;
        const existing = this.pluginAuxWindows.get(key);
        if (existing && !existing.isDestroyed()) {
            try {
                if (!existing.isVisible()) existing.showInactive();
            } catch (_) {
            }
            return true;
        }

        const meta = this.pluginMeta.get(pluginName);
        if (!meta || !meta.pluginPath || !meta.pluginConfig) return false;

        const pluginPath = meta.pluginPath;
        const pluginConfig = meta.pluginConfig;

        const mainFile = pluginConfig.main || 'index.html';
        const mainFilePath = path.join(pluginPath, mainFile);
        const indicatorSetting = pluginConfig.indicatorSetting || {};
        const indicatorWidth = Math.max(72, Math.min(1200, Number(indicatorSetting.width) || 72));
        const indicatorHeight = Math.max(72, Math.min(900, Number(indicatorSetting.height) || 72));
        let savedBounds = null;
        try {
            savedBounds = this.getPluginStorageItem(pluginName, 'indicatorBounds');
        } catch (_) {
        }
        const savedWidth = indicatorSetting.resizable === true && Number.isFinite(savedBounds?.width)
            ? Math.max(72, Math.min(1200, Math.round(savedBounds.width))) : indicatorWidth;
        const savedHeight = indicatorSetting.resizable === true && Number.isFinite(savedBounds?.height)
            ? Math.max(72, Math.min(900, Math.round(savedBounds.height))) : indicatorHeight;

        const indicatorWindow = new BrowserWindow({
            width: savedWidth,
            height: savedHeight,
            useContentSize: indicatorSetting.resizable === true,
            frame: false,
            transparent: true,
            resizable: indicatorSetting.resizable === true,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            movable: true,
            skipTaskbar: true,
            alwaysOnTop: true,
            focusable: indicatorSetting.focusable === true,
            show: false,
            hasShadow: false,
            backgroundColor: '#00000000',
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true,
                webSecurity: false,
                preload: pluginConfig.preload ? path.join(pluginPath, pluginConfig.preload) : undefined
            }
        });
        const logContext = this._pluginLogContext(pluginPath, pluginName);
        this._attachWindowLogs(indicatorWindow, logContext);
        this._emitLog(logContext, 'system', '插件指示器窗口已创建');

        try {
            const display = screen ? screen.getPrimaryDisplay() : null;
            const workArea = display ? display.workArea : null;

            if (savedBounds && typeof savedBounds === 'object' && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y)) {
                const x = Math.round(savedBounds.x);
                const y = Math.round(savedBounds.y);
                indicatorWindow.setPosition(x, y);
            } else if (workArea) {
                const x = workArea.x + workArea.width - indicatorWindow.getBounds().width - 20;
                const y = workArea.y + workArea.height - indicatorWindow.getBounds().height - 20;
                indicatorWindow.setPosition(x, y);
            }
        } catch (_) {
        }

        const openingSize = indicatorWindow.getSize();
        let userResized = false;
        try {
            indicatorWindow.on('resize', () => {
                const [width, height] = indicatorWindow.getSize();
                if (Math.abs(width - openingSize[0]) > 4 || Math.abs(height - openingSize[1]) > 4) userResized = true;
            });

            indicatorWindow.on('close', () => {
                try {
                    const { x, y } = indicatorWindow.getBounds();
                    const [width, height] = userResized ? indicatorWindow.getContentSize()
                        : [savedWidth, savedHeight];
                    this.setPluginStorageItem(pluginName, 'indicatorBounds', { x, y, width, height });
                } catch (_) {
                }
            });
        } catch (_) {
        }

        try {
            indicatorWindow.setAlwaysOnTop(true, 'screen-saver');
        } catch (_) {
            indicatorWindow.setAlwaysOnTop(true);
        }

        indicatorWindow.loadFile(mainFilePath, { query: { view: 'indicator' } }).catch(err => {
            console.error('加载指示器窗口失败:', err);
        });

        indicatorWindow.once('ready-to-show', () => {
            try {
                indicatorWindow.showInactive();
            } catch (_) {
                indicatorWindow.show();
            }
        });

        indicatorWindow.on('closed', () => {
            this._emitLog(logContext, 'system', '插件指示器窗口已关闭');
            this.pluginAuxWindows.delete(key);
        });

        this.pluginAuxWindows.set(key, indicatorWindow);
        return true;
    }

    closePluginIndicatorWindow(pluginName) {
        const key = `${pluginName}::indicator`;
        const win = this.pluginAuxWindows.get(key);
        if (win && !win.isDestroyed()) {
            try {
                win.close();
            } catch (_) {
            }
        }
        this.pluginAuxWindows.delete(key);
        return true;
    }

    // 执行JavaScript插件（适用于纯JS插件）
    async executeJavaScriptPlugin(pluginPath, pluginConfig) {
        const pluginName = pluginConfig.pluginName || path.basename(pluginPath);
        const logContext = this._pluginLogContext(pluginPath, pluginName);
        const mainFile = pluginConfig.main || 'index.js';
        const mainFilePath = path.join(pluginPath, mainFile);

        // 如果插件已经在运行，先停止旧进程
        if (this.pluginProcesses.has(pluginName)) {
            const oldProcess = this.pluginProcesses.get(pluginName);
            if (!oldProcess.killed) {
                oldProcess.sanrenjzStopRequested = true;
                oldProcess.kill();
            }
        }

        return new Promise((resolve, reject) => {
            // 使用child_process.fork执行JavaScript文件
            const pluginProcess = fork(mainFilePath, [], {
                cwd: pluginPath,
                silent: true,
                env: {
                    ...process.env,
                    PLUGIN_PATH: pluginPath,
                    PLUGIN_NAME: pluginName,
                    PLUGIN_CONFIG: JSON.stringify(pluginConfig)
                }
            });

            // 监听子进程的消息
            pluginProcess.on('message', (message) => {
                if (message?.type === 'output') {
                    this.sendOutput(message.data, logContext);
                } else if (message?.type === 'error') {
                    this.sendError(message.data, logContext);
                }
            });
            this._pipePluginOutput(pluginProcess.stdout, logContext, 'stdout');
            this._pipePluginOutput(pluginProcess.stderr, logContext, 'stderr');

            // 监听子进程错误
            pluginProcess.on('error', (error) => {
                console.error(`插件进程错误 ${pluginName}:`, error);
                this.sendError(`插件执行错误: ${error.message}\n`, logContext);
                if (this.pluginProcesses.get(pluginName) === pluginProcess) this.pluginProcesses.delete(pluginName);
                reject(error);
            });

            // 监听子进程退出
            pluginProcess.on('close', (code, signal) => {
                console.log(`插件进程退出 ${pluginName}: code=${code}, signal=${signal}`);
                if (this.pluginProcesses.get(pluginName) === pluginProcess) this.pluginProcesses.delete(pluginName);
                if (pluginProcess.sanrenjzStopRequested) {
                    this._emitLog(logContext, 'system', '插件进程已停止');
                } else if (code !== 0) {
                    this.sendError(`插件进程异常退出，退出码: ${code}，信号: ${signal || '无'}\n`, logContext);
                } else {
                    this._emitLog(logContext, 'system', '插件进程已退出（0）');
                }
            });

                // 存储进程引用
            this.pluginProcesses.set(pluginName, pluginProcess);
            this.pluginMeta.set(pluginName, { pluginPath, pluginConfig });
            pluginProcess.once('spawn', () => resolve(pluginProcess));
        });
    }

    // 停止插件
    stopPlugin(pluginName) {
        const meta = this.pluginMeta.get(pluginName);
        const logContext = meta ? this._pluginLogContext(meta.pluginPath, pluginName) : null;
        try {
            this.macDock.unpin(pluginName);
            this.closePluginIndicatorWindow(pluginName);

            // 关闭插件窗口
            if (this.pluginWindows.has(pluginName)) {
                const pluginWindow = this.pluginWindows.get(pluginName);
                if (pluginWindow && !pluginWindow.isDestroyed()) {
                    pluginWindow.close();
                }
                this.pluginWindows.delete(pluginName);
            }

            // 清理钉住状态
            if (this.pluginPinnedMap.has(pluginName)) {
                this.pluginPinnedMap.delete(pluginName);
            }

            if (this.pluginBackgroundKeepAlive.has(pluginName)) {
                this.pluginBackgroundKeepAlive.delete(pluginName);
            }

            if (this.pluginMeta.has(pluginName)) {
                this.pluginMeta.delete(pluginName);
            }

            // 终止插件进程
            if (this.pluginProcesses.has(pluginName)) {
                const pluginProcess = this.pluginProcesses.get(pluginName);
                if (pluginProcess && !pluginProcess.killed) {
                    pluginProcess.sanrenjzStopRequested = true;
                    pluginProcess.kill();
                }
                this.pluginProcesses.delete(pluginName);
            }

            this.sendOutput(`插件 ${pluginName} 已停止\n`, logContext, 'system');
        } catch (error) {
            console.error(`停止插件 ${pluginName} 时出错:`, error);
            this._emitLog(logContext, 'stderr', `停止插件失败：${error.message}`);
        }
    }

    // 停止所有插件
    stopAllPlugins() {
        this.macDock.dispose();
        for (const [key, win] of this.pluginAuxWindows) {
            if (win && !win.isDestroyed()) {
                try { win.close(); } catch (_) {}
            }
        }
        this.pluginAuxWindows.clear();

        // 关闭所有插件窗口
        for (const [pluginName, pluginWindow] of this.pluginWindows) {
            if (!pluginWindow.isDestroyed()) {
                pluginWindow.close();
            }
        }
        this.pluginWindows.clear();

        this.pluginMeta.clear();

        // 终止所有插件进程
        for (const [pluginName, pluginProcess] of this.pluginProcesses) {
            if (!pluginProcess.killed) {
                pluginProcess.sanrenjzStopRequested = true;
                pluginProcess.kill();
            }
        }
        this.pluginProcesses.clear();

        this.sendOutput('所有插件已停止\n');
    }

    // 重新加载插件（用于开发调试）
    async reloadPlugin(pluginPath) {
        const pluginJsonPath = path.join(pluginPath, 'plugin.json');
        
        if (!fs.existsSync(pluginJsonPath)) {
            throw new Error(`插件配置文件不存在: ${pluginJsonPath}`);
        }

        const pluginConfig = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
        const pluginName = pluginConfig.pluginName || path.basename(pluginPath);
        
        // 先停止插件
        this.stopPlugin(pluginName);
        
        // 等待一小段时间确保资源释放
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // 重新启动插件
        return this.runPlugin(pluginPath, pluginConfig.features);
    }

    // 切换插件窗口钉住状态
    togglePluginPin(pluginName) {
        try {
            const win = this.pluginWindows.get(pluginName);
            if (!win || win.isDestroyed()) {
                console.log(`插件窗口 ${pluginName} 不存在或已销毁，无法切换钉住状态`);
                return false;
            }
            
            const currentStatus = this.pluginPinnedMap.get(pluginName) || false;
            const newStatus = !currentStatus;
            this.pluginPinnedMap.set(pluginName, newStatus);
            try { this.syncPluginDock(pluginName, newStatus); }
            catch (error) {
                this.pluginPinnedMap.set(pluginName, currentStatus);
                throw error;
            }
            
            console.log(`插件 ${pluginName} 钉住状态: ${currentStatus} -> ${newStatus}`);
            
            if (newStatus) {
                // 钉住：显示在任务栏，允许最小化，保持窗口显示
                win.setSkipTaskbar(false);
                win.setMinimizable(true);  // 钉住时允许最小化
                if (!win.isVisible()) {
                    win.show();
                }
                console.log(`插件 ${pluginName} 已钉住到任务栏，将独立显示`);
                
                // 确保窗口在任务栏中独立显示（Windows特定）
                if (process.platform === 'win32') {
                    try {
                        // 强制刷新任务栏状态
                        setTimeout(() => {
                            if (win && !win.isDestroyed()) {
                                win.setSkipTaskbar(true);
                                setTimeout(() => {
                                    if (win && !win.isDestroyed()) {
                                        win.setSkipTaskbar(false);
                                        console.log(`插件 ${pluginName} 任务栏状态已刷新`);
                                    }
                                }, 100);
                            }
                        }, 100);
                    } catch (refreshError) {
                        console.error(`刷新插件 ${pluginName} 任务栏状态失败:`, refreshError);
                    }
                }
            } else {
                // 取消钉住：从任务栏移除，不允许最小化，但不立即隐藏
                win.setSkipTaskbar(true);
                win.setMinimizable(false); // 取消钉住时不允许最小化
                console.log(`插件 ${pluginName} 已从任务栏移除，窗口保持显示`);
                // 注意：不在这里隐藏窗口，让blur事件处理隐藏逻辑
            }
            
            // 向渲染进程发送钉住状态更新事件
            try {
                if (win.webContents && !win.webContents.isDestroyed()) {
                    win.webContents.send('pin-status-updated', newStatus);
                    console.log(`向插件 ${pluginName} 发送钉住状态更新事件: ${newStatus}`);
                }
            } catch (sendError) {
                console.error(`发送钉住状态更新事件失败:`, sendError);
            }
            
            return newStatus;
        } catch (error) {
            console.error(`切换插件 ${pluginName} 钉住状态时出错:`, error);
            return false;
        }
    }

    // Mac 的每个钉住插件使用独立 Dock 身份；窗口与业务仍由宿主管理。
    syncPluginDock(pluginName, pinned) {
        if (process.platform !== 'darwin') return;
        if (!pinned) { this.macDock.unpin(pluginName); return; }
        const meta = this.pluginMeta.get(pluginName);
        const win = this.pluginWindows.get(pluginName);
        if (!meta || !win || win.isDestroyed()) return;
        this.macDock.pin({
            id: pluginName, stableId: `tools:${path.relative(this.pluginDir, meta.pluginPath).split(path.sep).join('/')}`,
            name: pluginName, icon: this.getPluginIconPath(meta.pluginPath),
            focus: () => {
                if (win.isDestroyed()) return;
                if (win.isMinimized()) win.restore();
                win.show(); win.focus();
            },
            close: () => this.stopPlugin(pluginName)
        });
    }

    // 获取插件窗口钉住状态
    getPluginPinStatus(pluginName) {
        return this.pluginPinnedMap.get(pluginName) || false;
    }

    // 最小化插件窗口
    minimizePlugin(pluginName, options = {}) {
        const win = this.pluginWindows.get(pluginName);
        if (win && !win.isDestroyed()) {
            const keepAlive = options && options.keepAlive === true;
            if (keepAlive) {
                this.pluginBackgroundKeepAlive.set(pluginName, true);
                this.clearPluginCleanupTimer(pluginName);
                win.hide();
                return true;
            }
            if (win.isVisible()) {
                win.minimize();
                return true;
            }
            return false;
        }
        return false;
    }

    clearPluginCleanupTimer(pluginName) {
        const timer = this.pluginCleanupTimers.get(pluginName);
        if (timer) {
            clearTimeout(timer);
            this.pluginCleanupTimers.delete(pluginName);
        }
    }

    schedulePluginCleanup(pluginName, delayMs) {
        const pinned = this.pluginPinnedMap.get(pluginName);
        if (pinned) return;
        const keepAlive = this.pluginBackgroundKeepAlive.get(pluginName) === true;
        if (keepAlive) return;
        this.clearPluginCleanupTimer(pluginName);
        const timer = setTimeout(() => {
            const win = this.pluginWindows.get(pluginName);
            const currentPinned = this.pluginPinnedMap.get(pluginName);
            if (!currentPinned && win && !win.isDestroyed() && !win.isVisible()) {
                console.log(`插件 ${pluginName} 超时未重新打开，执行关闭清理`);
                this.stopPlugin(pluginName);
            }
            this.pluginCleanupTimers.delete(pluginName);
        }, delayMs);
        this.pluginCleanupTimers.set(pluginName, timer);
    }

    // 最大化/还原插件窗口
    maximizePlugin(pluginName) {
        const win = this.pluginWindows.get(pluginName);
        if (win && !win.isDestroyed()) {
            if (win.isMaximized()) {
                win.unmaximize();
                return false; // 返回false表示现在是还原状态
            } else {
                win.maximize();
                return true; // 返回true表示现在是最大化状态
            }
        }
        return false;
    }

    // 获取活跃的插件窗口（当前获得焦点的插件窗口）
    getActivePluginWindow() {
        for (const [pluginName, pluginWindow] of this.pluginWindows) {
            if (pluginWindow && !pluginWindow.isDestroyed() && pluginWindow.isFocused()) {
                return pluginWindow;
            }
        }
        return null;
    }

    // 获取可见的插件窗口（用于快捷键操作）
    getVisiblePluginWindow() {
        for (const [pluginName, pluginWindow] of this.pluginWindows) {
            if (pluginWindow && !pluginWindow.isDestroyed() && pluginWindow.isVisible()) {
                return pluginWindow;
            }
        }
        return null;
    }

    // 根据窗口对象获取插件名称
    getPluginNameByWindow(window) {
        for (const [pluginName, pluginWindow] of this.pluginWindows) {
            if (pluginWindow === window) {
                return pluginName;
            }
        }
        return null;
    }

    // macOS/Linux 优先 PNG，Windows 保持 ICO 优先。
    getPluginIconPath(pluginPath) {
        try {
            const logoIcoPath = path.join(pluginPath, 'logo.ico');
            const logoPngPath = path.join(pluginPath, 'logo.png');
            
            if (process.platform !== 'win32' && fs.existsSync(logoPngPath)) return logoPngPath;
            // Windows 优先检查 logo.ico；原生 Mac Dock 辅助进程也能只读加载旧 ICO。
            if (fs.existsSync(logoIcoPath)) {
                console.log(`插件图标找到 logo.ico: ${logoIcoPath}`);
                return logoIcoPath;
            }
            
            // 其次检查 logo.png
            if (fs.existsSync(logoPngPath)) {
                console.log(`插件图标找到 logo.png: ${logoPngPath}`);
                return logoPngPath;
            }
            
            // 如果都没有，使用主应用的图标
            const appIconPath = app.isPackaged 
                ? path.join(process.resourcesPath, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
                : path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
                
            if (fs.existsSync(appIconPath)) {
                console.log(`插件无自定义图标，使用主应用图标: ${appIconPath}`);
                return appIconPath;
            }
            
            console.log('未找到插件图标文件');
            return undefined;
        } catch (error) {
            console.error('获取插件图标路径失败:', error);
            return undefined;
        }
    }

    // 确保图标缓存目录存在
    ensureIconCacheDir() {
        try {
            const cacheDir = path.join(app.getPath('userData'), 'plugin-icons');
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            return cacheDir;
        } catch (error) {
            console.error('创建图标缓存目录失败:', error);
            return null;
        }
    }

    // 缓存插件图标到用户数据目录，防止图标覆盖
    cachePluginIcon(pluginName, sourcePath) {
        try {
            if (!sourcePath || !fs.existsSync(sourcePath)) return undefined;
            
            const cacheDir = this.ensureIconCacheDir();
            if (!cacheDir) return sourcePath;

            // 使用插件名称的Hex编码作为文件名，确保文件名安全且唯一
            const safeName = Buffer.from(pluginName).toString('hex');
            const ext = path.extname(sourcePath);
            const destPath = path.join(cacheDir, `${safeName}${ext}`);
            
            // 总是复制最新图标
            fs.copyFileSync(sourcePath, destPath);
            console.log(`插件 ${pluginName} 图标已缓存到: ${destPath}`);
            return destPath;
        } catch (error) {
            console.error(`缓存插件 ${pluginName} 图标失败:`, error);
            return sourcePath; // 失败时回退到源路径
        }
    }

    // 获取插件的.ico格式图标（专门用于任务栏显示）- 优先使用 logo.ico，其次 logo.png
    getPluginIcoPath(pluginPath) {
        try {
            const logoIcoPath = path.join(pluginPath, 'logo.ico');
            const logoPngPath = path.join(pluginPath, 'logo.png');
            
            // 优先检查 logo.ico
            if (fs.existsSync(logoIcoPath)) {
                console.log(`插件.ico图标找到 logo.ico: ${logoIcoPath}`);
                return logoIcoPath;
            }
            
            // 其次检查 logo.png（虽然不是.ico格式，但可以作为备选）
            if (fs.existsSync(logoPngPath)) {
                console.log(`插件.ico图标找到 logo.png: ${logoPngPath}`);
                return logoPngPath;
            }
            
            // 如果都没有，使用主应用的.ico图标
            const appIconPath = app.isPackaged 
                ? path.join(process.resourcesPath, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
                : path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
                
            if (fs.existsSync(appIconPath)) {
                console.log(`插件无自定义图标，使用主应用.ico图标: ${appIconPath}`);
                return appIconPath;
            }
            
            console.log('未找到插件.ico格式图标文件');
            return undefined;
        } catch (error) {
            console.error('获取插件.ico图标路径失败:', error);
            return undefined;
        }
    }

    // 加载设置的方法（从main.js复制）
    loadSettings() {
        try {
            // 复用宿主的固定配置入口，避免 Electron 路径变化后读到另一份设置。
            if (this.readHostSettings) return this.readHostSettings();
            const path = require('path');
            const fs = require('fs');
            const { app } = require('electron');
            
            const settingsPath = path.join(app.getPath('userData'), 'settings.json');
            const defaultSettings = {
                globalHotkey: 'Alt+Space',
                autoStart: false,
                pinHotkey: 'Ctrl+D',
                customPluginDataPath: null
            };
            
            if (fs.existsSync(settingsPath)) {
                const data = fs.readFileSync(settingsPath, 'utf8');
                return { ...defaultSettings, ...JSON.parse(data) };
            }
            return defaultSettings;
        } catch (error) {
            console.error('读取设置失败:', error);
            return {
                globalHotkey: 'Alt+Space',
                autoStart: false,
                pinHotkey: 'Ctrl+D'
            };
        }
    }

    // 执行插件的特定功能
    async runPluginAction(pluginPath, feature, selectedText) {
        let logContext = this._pluginLogContext(pluginPath);
        try {
            assertPluginAvailable(pluginPath);
            console.log('🎯 执行插件功能:', feature.code, '选中文本:', selectedText);
            
            const pluginJsonPath = path.join(pluginPath, 'plugin.json');
            
            if (!fs.existsSync(pluginJsonPath)) {
                throw new Error(`插件配置文件不存在: ${pluginJsonPath}`);
            }

            const pluginConfig = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
            const pluginName = pluginConfig.pluginName || path.basename(pluginPath);
            logContext = this._pluginLogContext(pluginPath, pluginName);
            const configuredFeature = Array.isArray(pluginConfig.features)
                ? pluginConfig.features.find(item => item.code === feature.code)
                : null;
            const startHidden = configuredFeature?.startHidden === true;

            // 检查插件是否已经运行，如果没有，先创建插件窗口
            let pluginWindow;
            if (this.pluginWindows.has(pluginName)) {
                pluginWindow = this.pluginWindows.get(pluginName);
                if (pluginWindow && pluginWindow.isDestroyed()) {
                    this.pluginWindows.delete(pluginName);
                    pluginWindow = null;
                }
            }

            // 如果插件窗口不存在，创建一个
            if (!pluginWindow) {
                console.log(`插件 ${pluginName} 未运行，创建插件窗口`);
                pluginWindow = await this.createPluginWindow(pluginPath, pluginConfig, { startHidden });
            }
            await waitForPluginWindowReady(pluginWindow.webContents);

            if (startHidden) {
                pluginWindow.hide();
            } else {
                if (!pluginWindow.isVisible()) pluginWindow.show();
                setTimeout(() => {
                    if (pluginWindow && !pluginWindow.isDestroyed()) pluginWindow.focus();
                }, 800);
            }

            // 发送功能执行请求到插件
            try {
                console.log('向插件发送功能执行请求:', feature.code);
                
                // 首先检查插件是否支持exports API
                const result = await pluginWindow.webContents.executeJavaScript(`
                    (function() {
                        try {
                            // 检查插件是否有exports对象和对应的功能
                            if (typeof window.exports === 'object' && window.exports && window.exports['${feature.code}']) {
                                const featureHandler = window.exports['${feature.code}'];
                                console.log('找到插件功能处理器:', '${feature.code}');
                                
                                // 执行功能
                                if (featureHandler.mode === 'list') {
                                    // 列表模式：通过enter方法进入功能
                                    if (featureHandler.args && featureHandler.args.enter) {
                                        console.log('执行列表模式功能');
                                        featureHandler.args.enter('${feature.code}', function(items) {
                                            console.log('插件返回的列表项:', items.length);
                                        });
                                        return { success: true, message: '插件功能已启动' };
                                    }
                                } else if (featureHandler.mode === 'none') {
                                    // 无模式：直接通过enter方法执行
                                    if (featureHandler.args && featureHandler.args.enter) {
                                        console.log('执行无模式功能');
                                        featureHandler.args.enter('${feature.code}');
                                        return { success: true, message: '插件功能已执行' };
                                    }
                                }
                                
                                return { success: false, error: '未找到合适的功能处理方法' };
                            } else {
                                console.log('插件exports对象或功能不存在');
                                return { success: false, error: '插件功能未找到' };
                            }
                        } catch (error) {
                            console.error('执行插件功能时出错:', error);
                            return { success: false, error: error.message };
                        }
                    })();
                `);

                console.log('插件功能执行结果:', result);

                if (result && result.success) {
                    this._emitLog(logContext, 'system', '插件功能已执行');
                    return { success: true, message: result.message || '插件功能执行成功' };
                } else {
                    console.warn('插件功能执行失败:', result?.error);
                    this._emitLog(logContext, 'stderr', `插件功能执行失败：${result?.error || '未知错误'}`);
                    return { success: false, error: result?.error || '插件功能执行失败' };
                }

            } catch (executeError) {
                console.error('向插件发送执行请求失败:', executeError);
                this._emitLog(logContext, 'stderr', `插件通信失败：${executeError.message}`);
                return { success: false, error: `插件通信失败: ${executeError.message}` };
            }

        } catch (error) {
            console.error('执行插件功能失败:', error);
            this._emitLog(logContext, 'stderr', `插件功能执行失败：${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // 获取插件路径（供外部调用）
    getPluginPath(pluginName) {
        if (pluginName && fs.existsSync(this.pluginDir)) {
            try {
                const items = fs.readdirSync(this.pluginDir, { withFileTypes: true });
                for (const item of items) {
                    if (!item.isDirectory()) continue;
                    const pluginPath = path.join(this.pluginDir, item.name);
                    const pluginJsonPath = path.join(pluginPath, 'plugin.json');
                    if (!fs.existsSync(pluginJsonPath)) continue;
                    try {
                        const pluginConfig = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
                        const resolvedName = pluginConfig.pluginName || item.name;
                        if (resolvedName === pluginName) {
                            return pluginPath;
                        }
                    } catch (error) {
                        console.error('读取插件配置失败:', pluginJsonPath, error);
                    }
                }
            } catch (error) {
                console.error('扫描插件目录失败:', this.pluginDir, error);
            }
        }

        const folderName = pluginName ? pluginName.toLowerCase().replace(/\s+/g, '-') : '';
        return path.join(this.pluginDir, folderName);
    }
}

module.exports = PluginManager;
