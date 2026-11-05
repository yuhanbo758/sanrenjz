const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, nativeImage, shell, dialog, session, safeStorage, desktopCapturer, screen, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
// extraResources 中的运行模块与 ASAR 是同级目录，显式连接应用自身依赖。
if (app.isPackaged) {
    process.env.NODE_PATH = [path.join(process.resourcesPath, 'app.asar', 'node_modules'), path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    require('module').Module._initPaths();
}
require(app.isPackaged ? path.join(process.resourcesPath, 'app', 'console-encoding.js') : './app/console-encoding').setupConsoleEncoding();
// 新产品数据目录必须在创建设置、缓存与共享运行时之前固定。
app.setName('sanrenjz');
app.setPath('userData', process.env.SANRENJZ_USER_DATA || path.join(app.getPath('appData'), 'sanrenjz'));
const mergedAcceptance = process.env.SANRENJZ_ACCEPTANCE === '1';
if (mergedAcceptance) app.on('browser-window-created', (_event, window) => {
    window.show = () => {};
    window.showInactive = () => {};
    window.focus = () => {};
});
let mergedHost;
let hotkeyController;
const mobileAcceptance = !app.isPackaged && process.env?.SANRENJZ_REMOTE_ACCEPTANCE === '1';
if (mobileAcceptance) app.setPath('userData', path.join(__dirname, 'dist', 'mobile-remote-live', 'profile'));
let mobileRemoteService = null;
function initializeMobileRemote() {
    if (mobileRemoteService) return;
    const { RemoteService } = require(app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'remote', 'service.js')
        : './app/remote/service');
    mobileRemoteService = new RemoteService({
        app, ipcMain, BrowserWindow, session, safeStorage,
        clipboard: require('electron').clipboard, manager: pluginManager,
        screen, hiddenCastWindow: mobileAcceptance, getCastDisplay: () => screen.getDisplayMatching(mainWindow.getBounds()),
        loadSettings, saveSettings,
        cancelAi: requestId => openCodeRuntime.cancel(requestId),
        accountStatus: async () => ({ loggedIn: cachedAccount?.authenticated === true, message: '账号登录和会员认证请在电脑完成' })
    });
    const { CastPluginLoader } = require(app.isPackaged ? path.join(process.resourcesPath, 'app', 'remote', 'cast-plugin-loader.js') : './app/remote/cast-plugin-loader');
    mobileRemoteService.castPlugins = new CastPluginLoader(mobileRemoteService);
    if (!mobileAcceptance && mobileRemoteService.settings().enabled) mobileRemoteService.start().catch(error => console.warn('手机遥控启动失败:', error.message));
}
// app 目录通过 extraResources 放在 ASAR 外，打包后必须从 resources 加载。
const { waitForPluginWindowReady } = require(app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'plugin_runtime', 'plugin-window-ready.js')
    : './app/plugin_runtime/plugin-window-ready');
const { OpenCodeRuntime } = require(app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'plugin_runtime', 'opencode-runtime.js')
    : './app/plugin_runtime/opencode-runtime');
const { initializePluginStore, normalizePluginIdentity, syncBundledPluginRuntime } = require(app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'plugin_store.js')
    : './app/plugin_store');
const { detectTextContextTypes } = require(app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'super_panel_context.js')
    : './app/super_panel_context');
const { hookOutputSource } = require(app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'plugin_runtime', 'windows-hook-output.js')
    : './app/plugin_runtime/windows-hook-output');
const { getInstalledAppRoot } = require(app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'install-root.js')
    : './app/install-root');

const { ReleaseUpdates, GITHUB_RELEASES_URL } = require(app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'release-updates.js')
    : './app/release-updates');
let releaseUpdates;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    app.quit();
}

// 初始化remote模块 - 需要在app ready之后
let remoteMain;
try {
    remoteMain = require('@electron/remote/main');
} catch (error) {
    console.error('加载@electron/remote/main失败:', error);
    // 在打包环境中尝试其他路径
    try {
        remoteMain = require(path.join(process.resourcesPath, 'node_modules', '@electron', 'remote', 'main'));
    } catch (fallbackError) {
        console.error('备用路径加载@electron/remote/main也失败:', fallbackError);
    }
}

// 插件管理器将在app ready后初始化
let PluginManager;

let mainWindow;
let searchWindow;
let superPanelWindow; // 超级面板窗口
let activeRegionCapture = null; // 当前跨屏框选截图会话
const pluginPromptWindowStates = new Map(); // 截图完成后的底部确认条窗口状态
let isSuperPanelGracePeriod = false; // 超级面板显示宽限期
let hasActiveInput = false; // 跟踪是否有活动输入框
let wasTextInputBeforeSearch = false; // 记录打开搜索窗口前是否聚焦在文本输入控件上
let pluginManager;
let isPinned = false; // 添加钉住状态
const pluginPinnedMap = new Map();
let lastActiveWindow = null; // 记录最后活动的窗口句柄
let isSuperPanelFocusListenerRegistered = false;
let superPanelChildWindows = new Set();
const openCodeRuntime = new OpenCodeRuntime({ runtimeDirectory: path.join(app.getPath('userData'), 'opencode-runtime') });

const SHOP_BASE_URL = process.env.SANRENJZ_TOOLS_SHOP_BASE_URL || 'https://shop.sanrenjz.com';
const SHOP_MEMBER_CENTER_URL = `${SHOP_BASE_URL}/member-center`;
const SHOP_TOOLS_STORE_URL = `${SHOP_BASE_URL}/tools`;
const SHOP_HOSTNAME = new URL(SHOP_BASE_URL).hostname;
const SHOP_DOWNLOAD_HOSTNAME = 'xz.sanrenjz.com';
const ACCOUNT_TOKEN_FILE = 'account-token.bin';
const BUILTIN_BROWSER_PARTITION = 'persist:sanrenjz-shop';
const SUPPORTED_PLUGIN_DOWNLOAD_EXTENSIONS = new Set(['.zip']);
let cachedAccount = null;
let accountSnapshotGeneration = 0;
let accountRefreshTimer = null;
let accountLoggingOut = false;
let accountSessionSuppressed = false;
let builtinSessionEventsBound = false;

function trackSuperPanelChildWindow(windowInstance) {
    if (!windowInstance) {
        return;
    }
    superPanelChildWindows.add(windowInstance);
    const cleanup = () => {
        superPanelChildWindows.delete(windowInstance);
    };
    windowInstance.on('closed', cleanup);
    windowInstance.on('close', cleanup);
}

function hasActiveSuperPanelChildWindow() {
    let hasActive = false;
    for (const win of superPanelChildWindows) {
        if (win && !win.isDestroyed()) {
            hasActive = true;
        } else {
            superPanelChildWindows.delete(win);
        }
    }
    return hasActive;
}

function toSerializable(value) {
    if (value == null) return value;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        if (value instanceof Error) {
            return { message: value.message || String(value), stack: value.stack || '' };
        }
        return { message: String(value) };
    }
}

function sendRendererEvent(channel, payload = {}) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, toSerializable(payload));
    }
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function sanitizeFileName(fileName) {
    return String(fileName || 'download')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim() || 'download';
}

function getBuiltinSession() {
    return session.fromPartition(BUILTIN_BROWSER_PARTITION);
}

function isShopDomain(domain) {
    const normalized = String(domain || '').replace(/^\./, '').toLowerCase();
    return normalized === SHOP_HOSTNAME || normalized.endsWith(`.${SHOP_HOSTNAME}`);
}

function isShopUrl(rawUrl) {
    try {
        return isShopDomain(new URL(rawUrl).hostname);
    } catch (_) {
        return false;
    }
}

function isPluginDownloadUrl(rawUrl) {
    try {
        const hostname = new URL(rawUrl).hostname.toLowerCase();
        return isShopDomain(hostname) || hostname === SHOP_DOWNLOAD_HOSTNAME;
    } catch (_) {
        return false;
    }
}

function isSupportedPluginDownload(fileName) {
    return SUPPORTED_PLUGIN_DOWNLOAD_EXTENSIONS.has(path.extname(String(fileName || '')).toLowerCase());
}

function isDirectPluginDownloadUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.hostname.toLowerCase() === SHOP_DOWNLOAD_HOSTNAME || isSupportedPluginDownload(parsed.pathname);
    } catch (_) {
        return false;
    }
}

function getPluginInstallDir() {
    if (pluginManager?.pluginDir) return pluginManager.pluginDir;
    return app.isPackaged
        ? path.join(getInstalledAppDir(), 'plugins')
        : path.join(__dirname, 'app', 'software');
}

function getInstalledAppDir() {
    return getInstalledAppRoot(app, { developmentRoot: __dirname });
}

function getBundledPluginDir() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'software')
        : path.join(__dirname, 'app', 'software');
}

function preparePluginStore() {
    if (!app.isPackaged) {
        return { persistentDir: getPluginInstallDir(), migrated: [], added: [], updated: [], preserved: [] };
    }

    const installedAppDir = getInstalledAppDir();
    const runtimeDir = syncBundledPluginRuntime(
        path.join(process.resourcesPath, 'app', 'plugin_runtime'),
        path.join(installedAppDir, 'plugin_runtime')
    );
    const result = initializePluginStore({
        bundledDir: getBundledPluginDir(),
        persistentDir: getPluginInstallDir(),
        migrationDirs: [`${installedAppDir}.plugin-update-backup`]
    });
    console.log('用户插件目录已就绪:', { ...result, runtimeDir });
    return { ...result, runtimeDir };
}

function uniquePath(filePath) {
    if (!fs.existsSync(filePath)) return filePath;
    const parsed = path.parse(filePath);
    let counter = 1;
    while (true) {
        const candidate = path.join(parsed.dir, `${parsed.name}_${counter}${parsed.ext}`);
        if (!fs.existsSync(candidate)) return candidate;
        counter += 1;
    }
}

function removePath(targetPath) {
    try { fs.rmSync(targetPath, { recursive: true, force: true }); } catch (_) { }
}

function findPluginRoots(rootDir) {
    const matches = [];
    const queue = [rootDir];
    while (queue.length) {
        const current = queue.shift();
        if (!fs.existsSync(current)) continue;
        const pluginJsonPath = path.join(current, 'plugin.json');
        if (fs.existsSync(pluginJsonPath)) {
            matches.push(current);
            continue;
        }
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
                queue.push(path.join(current, entry.name));
            }
        }
    }
    return matches;
}

function copyDirectoryContents(sourceDir, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
}

function findInstalledPluginPath(installDir, pluginName) {
    if (!fs.existsSync(installDir)) return null;
    const expectedIdentity = normalizePluginIdentity(pluginName);
    for (const entry of fs.readdirSync(installDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginPath = path.join(installDir, entry.name);
        const configPath = path.join(pluginPath, 'plugin.json');
        if (!fs.existsSync(configPath)) continue;
        try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const installedName = config.pluginName || entry.name;
            if (normalizePluginIdentity(installedName) === expectedIdentity) return pluginPath;
        } catch (_) { }
    }
    return null;
}

function extractArchive(archivePath, destinationDir) {
    fs.mkdirSync(destinationDir, { recursive: true });
    return new Promise((resolve, reject) => {
        const archive = archivePath.replace(/'/g, "''");
        const destination = destinationDir.replace(/'/g, "''");
        const child = spawn('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`
        ], {
            windowsHide: true,
            env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim() || '解压插件包失败'));
        });
    });
}

async function installDownloadedPlugin(downloadPath) {
    if (!mergedHost) throw new Error('插件管理器尚未就绪');
    try {
        const result = await mergedHost.importArchive(downloadPath);
        return result.installed || [];
    } finally { removePath(downloadPath); }
}

function sendPluginDownloadEvent(payload = {}) {
    sendRendererEvent('plugins:download', payload);
}

function bindBuiltinSessionEvents() {
    if (builtinSessionEventsBound) return;
    builtinSessionEventsBound = true;
    const builtinSession = getBuiltinSession();
    // 统一登录可能只更新 HttpOnly Cookie，不发生页面导航。
    builtinSession.cookies.on('changed', (_event, cookie) => {
        if (accountLoggingOut || accountSessionSuppressed) return;
        if (!isShopDomain(cookie.domain) || !['__Host-srj_shop', 'srj_shop_test'].includes(cookie.name)) return;
        clearTimeout(accountRefreshTimer);
        accountRefreshTimer = setTimeout(() => { refreshAccountState().catch(() => {}); }, 150);
    });
    builtinSession.on('will-download', (event, item, webContents) => {
        const sourceUrl = item.getURL() || webContents?.getURL() || '';
        const fileName = sanitizeFileName(item.getFilename());
        if (!isPluginDownloadUrl(sourceUrl) && !isSupportedPluginDownload(fileName)) return;
        if (!isSupportedPluginDownload(fileName)) {
            event.preventDefault();
            sendPluginDownloadEvent({ type: 'error', fileName, message: '仅支持自动安装 zip 插件包' });
            return;
        }
        const downloadsDir = ensureDir(path.join(getPluginInstallDir(), '.downloads'));
        const savePath = uniquePath(path.join(downloadsDir, fileName));
        item.setSavePath(savePath);
        sendPluginDownloadEvent({ type: 'started', fileName: path.basename(savePath) });
        item.on('done', async (_downloadEvent, state) => {
            if (state !== 'completed') {
                sendPluginDownloadEvent({ type: 'error', fileName: path.basename(savePath), message: `下载未完成：${state}` });
                return;
            }
            try {
                const installed = await installDownloadedPlugin(savePath);
                await refreshPluginCatalog('store-install');
                sendPluginDownloadEvent({ type: 'completed', fileName: path.basename(savePath), installed });
            } catch (error) {
                sendPluginDownloadEvent({ type: 'error', fileName: path.basename(savePath), message: error.message || String(error) });
            }
        });
    });
}

function tokenPath() {
    return path.join(app.getPath('userData'), ACCOUNT_TOKEN_FILE);
}

function saveAccountToken(token) {
    if (!safeStorage?.isEncryptionAvailable()) return false;
    const file = tokenPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encrypted = safeStorage.encryptString(String(token));
    fs.writeFileSync(file, encrypted);
    return true;
}

function readAccountToken() {
    if (accountLoggingOut || accountSessionSuppressed) return '';
    const file = tokenPath();
    if (!fs.existsSync(file)) return '';
    const data = fs.readFileSync(file);
    try {
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(data);
        }
    } catch (_) { }
    // 仅兼容旧版明文 JWT，解密失败的二进制不能作为令牌发送。
    const legacy = data.toString('utf8').trim();
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(legacy) ? legacy : '';
}

function clearAccountToken() {
    try { fs.unlinkSync(tokenPath()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readTokenFromWebContents(webContents) {
    if (!webContents || webContents.isDestroyed()) return '';
    try {
        if (!isShopUrl(webContents.getURL())) return '';
        const token = await webContents.executeJavaScript(`(() => {
            try { return String(window.localStorage.getItem('token') || ''); }
            catch (_) { return ''; }
        })()`, true);
        return String(token || '').trim();
    } catch (_) {
        return '';
    }
}

async function syncAccountFromWebContents(webContents) {
    if (accountLoggingOut || accountSessionSuppressed) return cachedAccount;
    const generation = ++accountSnapshotGeneration;
    const token = await readTokenFromWebContents(webContents);
    if (accountLoggingOut || accountSessionSuppressed || generation !== accountSnapshotGeneration) return cachedAccount;
    if (token) saveAccountToken(token);
    // localStorage 没有 token 是新版正常状态，不再据此清空登录信息。
    return refreshAccountState();
}

async function refreshAccountState() {
    if (accountLoggingOut || accountSessionSuppressed) return cachedAccount;
    const generation = ++accountSnapshotGeneration;
    const snapshot = await loadAccountSnapshot();
    if (accountLoggingOut || accountSessionSuppressed || generation !== accountSnapshotGeneration) return cachedAccount;
    cachedAccount = snapshot;
    sendRendererEvent('account:changed', snapshot);
    return snapshot;
}

async function clearShopSession() {
    const builtinSession = getBuiltinSession();
    let failed = false;
    try {
        await builtinSession.clearStorageData({ origin: SHOP_BASE_URL, storages: ['localstorage'] });
    } catch (_) { failed = true; }
    let cookies = [];
    try { cookies = await builtinSession.cookies.get({ url: SHOP_BASE_URL }); }
    catch (_) { failed = true; }
    for (const cookie of cookies) {
        const domain = String(cookie.domain || '').replace(/^\./, '');
        const protocol = cookie.secure ? 'https://' : 'http://';
        const cookieUrl = `${protocol}${domain}${cookie.path || '/'}`;
        try { await builtinSession.cookies.remove(cookieUrl, cookie.name); } catch (_) { failed = true; }
    }
    if (failed) throw new Error('商店会话未完全清理');
}

async function loadAccountSnapshotFromSession() {
    if (accountLoggingOut || accountSessionSuppressed) return cachedAccount || { authenticated: false, canDownloadUpdates: false, user: null, access: {} };
    const { ShopAccountClient } = require(app.isPackaged
        ? path.join(process.resourcesPath, 'app', 'shop-account.js') : './app/shop-account');
    const snapshot = await new ShopAccountClient({ net: require('electron').net,
        getSession: getBuiltinSession, baseUrl: SHOP_BASE_URL, readToken: readAccountToken }).snapshot();
    if (snapshot.verificationFailed && cachedAccount?.authenticated) {
        return { ...cachedAccount, verificationFailed: true, error: snapshot.error };
    }
    return snapshot;
}

async function fetchToolsAccess() {
    const snapshot = await loadAccountSnapshotFromSession();
    return { authenticated: snapshot.authenticated, access: snapshot.access || {}, canDownloadUpdates: false };
}

async function loadAccountSnapshot() { return loadAccountSnapshotFromSession(); }

function openBuiltinBrowserWindow(url) {
    bindBuiltinSessionEvents();
    const browserWin = new BrowserWindow({
        width: 1100,
        height: 750,
        minWidth: 640,
        minHeight: 480,
        title: '程序小店',
        icon: getIconPath(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: getBuiltinSession()
        }
    });
    browserWin.loadURL(url);
    const syncAccountState = () => {
        syncAccountFromWebContents(browserWin.webContents).catch(() => { });
    };
    browserWin.webContents.on('did-finish-load', syncAccountState);
    browserWin.webContents.on('did-navigate-in-page', syncAccountState);
    browserWin.webContents.on('did-navigate', syncAccountState);
    browserWin.on('focus', syncAccountState);
    browserWin.webContents.on('will-navigate', (event, targetUrl) => {
        if (!isDirectPluginDownloadUrl(targetUrl)) return;
        event.preventDefault();
        browserWin.webContents.downloadURL(targetUrl);
    });
    browserWin.webContents.setWindowOpenHandler(({ url: newUrl }) => {
        if (isDirectPluginDownloadUrl(newUrl)) {
            browserWin.webContents.downloadURL(newUrl);
            return { action: 'deny' };
        }
        openBuiltinBrowserWindow(newUrl);
        return { action: 'deny' };
    });
    browserWin.webContents.on('page-title-updated', (_event, title) => {
        browserWin.setTitle(title || '程序小店');
    });
    return browserWin;
}

function getReleaseUpdates() {
    if (!releaseUpdates) releaseUpdates = new ReleaseUpdates({
        currentVersion: app.getVersion(), updatesDir: path.join(app.getPath('userData'), 'updates'),
        request: options => net.request(options),
        emit: payload => sendRendererEvent('update:status', { source: 'github', ...payload })
    });
    return releaseUpdates;
}

async function runUpdateAction(event, action) {
    // 更新只能由宿主主界面主动触发，商店页面和插件无权安装主程序。
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
        return { success: false, message: '请从主界面的应用更新窗口操作' };
    }
    try { return await action(getReleaseUpdates()); }
    catch (error) {
        const message = String(error?.message || '更新失败，请稍后重试').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
        return { success: false, message };
    }
}

// 快捷搜索热键节流控制
let lastSearchHotkeyTime = 0;
const SEARCH_HOTKEY_COOLDOWN_MS = 1200;



// 设置文件路径
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

// 默认设置
const defaultSettings = {
    // 默认 Alt+Space，注册失败明确提示并保留用户选择。
    globalHotkey: 'Alt+Space',
    autoStart: false,
    pythonMode: 'none',
    customPythonPath: '',
    managedPythonPath: '',
    customPluginConfigDir: '',
    pluginPreferences: {},
    pinHotkey: 'Ctrl+D', // 钉住快捷键
    enableRightClickPanel: true, // 启用右键长按面板
    rightClickDelay: 350, // 右键长按延迟时间（毫秒），降低普通右键误触概率
    // 超级面板快捷键（为空则不注册）
    superPanelHotkey: '',
    customPluginDataPath: null // 自定义插件数据存储路径
};

/**
 * 配置Chromium日志与缓存路径
 * 函数级注释：
 * - 关闭Chromium控制台日志，避免在Windows控制台出现乱码
 * - 将缓存目录显式设置到 userData/Cache，避免权限问题导致的“Unable to move the cache (0x5)”错误
 * - 设置语言为 en-US，统一底层日志语言，进一步减少乱码风险
 */
function configureLoggingAndCache() {
    try {
        app.commandLine.appendSwitch('disable-logging');
        process.env.ELECTRON_ENABLE_LOGGING = '0';
        app.commandLine.appendSwitch('lang', 'en-US');

        const cachePath = path.join(app.getPath('userData'), 'Cache');
        try {
            fs.mkdirSync(cachePath, { recursive: true });
        } catch { }
        app.setPath('cache', cachePath);
    } catch (error) {
        // 静默处理，避免影响应用启动
    }
}

// 读取设置
function loadSettings({ strict = false } = {}) {
    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设置文件必须为 JSON 对象');
        return { ...defaultSettings, ...parsed };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('读取设置失败:', error);
            if (strict) throw new Error(`无法读取现有设置，原文件已保留，请先修复设置文件：${error.message}`);
        }
    }
    return defaultSettings;
}

// 保存设置
function saveSettings(settings) {
    try {
        const currentSettings = loadSettings({ strict: true });
        const newSettings = { ...currentSettings, ...settings };
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        const staging = `${settingsPath}.tmp`;
        fs.writeFileSync(staging, JSON.stringify(newSettings, null, 2), 'utf8');
        fs.renameSync(staging, settingsPath);
        return newSettings;
    } catch (error) {
        console.error('保存设置失败:', error);
        throw error;
    }
}

// 文本片段目录缓存。搜索窗口只读取内存目录，磁盘变化通过 fs.watch 防抖失效。
const textSnippetCache = {
    pathsKey: '', items: [], dirty: true, loading: null, watchers: []
};

function closeTextSnippetWatchers() {
    for (const watcher of textSnippetCache.watchers) {
        try { watcher.close(); } catch (_) { }
    }
    textSnippetCache.watchers = [];
}

function invalidateTextSnippetCache(reason = 'unknown') {
    textSnippetCache.dirty = true;
    invalidateSearchCatalog(`text-snippets:${reason}`);
}

function watchTextSnippetPaths(pathsToWatch) {
    closeTextSnippetWatchers();
    for (const folderPath of pathsToWatch) {
        try {
            const watcher = fs.watch(folderPath, { recursive: process.platform === 'win32' }, () => {
                invalidateTextSnippetCache('filesystem-change');
            });
            watcher.on('error', error => console.warn('文本片段目录监听失败:', error.message));
            textSnippetCache.watchers.push(watcher);
        } catch (error) {
            console.warn(`无法监听文本片段目录 ${folderPath}:`, error.message);
        }
    }
}

/**
 * 异步读取文本片段目录。
 * 禁止使用同步文件 API，避免快捷搜索初始化时阻塞 Electron 主进程事件循环。
 */
async function getTextSnippets(pluginPath) {
    try {
        let actualPaths = [];
        try {
            if (pluginManager) {
                const settings = pluginManager.getPluginStorageItem('余汉波文本片段助手', 'snippets-settings');
                if (settings) {
                    if (Array.isArray(settings.snippetsPaths) && settings.snippetsPaths.length > 0) {
                        actualPaths = settings.snippetsPaths.filter(Boolean);
                    } else if (settings.snippetsPath) {
                        actualPaths = [settings.snippetsPath];
                    }
                }
            }
        } catch (error) {
            console.error('从存储中读取设置失败:', error);
        }

        const existingPaths = [];
        for (const candidate of actualPaths) {
            try {
                const stat = await fs.promises.stat(candidate);
                if (stat.isDirectory()) existingPaths.push(candidate);
            } catch (_) { }
        }

        const pathsKey = JSON.stringify(existingPaths.slice().sort());
        if (pathsKey !== textSnippetCache.pathsKey) {
            textSnippetCache.pathsKey = pathsKey;
            textSnippetCache.dirty = true;
            watchTextSnippetPaths(existingPaths);
        }

        if (!textSnippetCache.dirty) return textSnippetCache.items;
        if (textSnippetCache.loading) return textSnippetCache.loading;
        if (existingPaths.length === 0) {
            textSnippetCache.items = [];
            textSnippetCache.dirty = false;
            return [];
        }

        textSnippetCache.loading = (async () => {
            const allSnippets = [];
            async function scanDirectory(dir, maxDepth = 2, currentDepth = 0) {
                if (currentDepth >= maxDepth) return;
                let entries = [];
                try {
                    entries = await fs.promises.readdir(dir, { withFileTypes: true });
                } catch (error) {
                    console.warn(`扫描文本片段目录失败 ${dir}:`, error.message);
                    return;
                }
                await Promise.all(entries.map(async entry => {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory() && currentDepth < maxDepth - 1) {
                        await scanDirectory(fullPath, maxDepth, currentDepth + 1);
                        return;
                    }
                    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md') return;
                    try {
                        const content = await fs.promises.readFile(fullPath, 'utf8');
                        const fileName = path.basename(entry.name, '.md');
                        let preview = content
                            .replace(/^#+\s*/gm, '')
                            .replace(/\*\*(.*?)\*\*/g, '$1')
                            .replace(/\*(.*?)\*/g, '$1')
                            .replace(/`(.*?)`/g, '$1')
                            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
                            .replace(/\n+/g, ' ')
                            .trim();
                        if (preview.length > 150) preview = `${preview.slice(0, 150)}...`;
                        allSnippets.push({ title: fileName, content, preview: preview || `${fileName} - Markdown文档`, path: fullPath, type: 'text-snippet' });
                    } catch (error) {
                        console.warn(`读取文本片段失败 ${fullPath}:`, error.message);
                    }
                }));
            }

            await Promise.all(existingPaths.map(folderPath => scanDirectory(folderPath)));
            allSnippets.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
            textSnippetCache.items = allSnippets;
            textSnippetCache.dirty = false;
            console.log(`文本片段搜索缓存已刷新，共 ${allSnippets.length} 项`);
            return allSnippets;
        })();

        try { return await textSnippetCache.loading; }
        finally { textSnippetCache.loading = null; }
    } catch (error) {
        console.error('获取文本片段失败:', error);
        return [];
    }
}

// 注册全局快捷键
// 函数级注释：
// - 注册快速搜索的全局快捷键（默认 Alt+Space，占用时明确提示并保留用户选择）
// - 增加节流机制（1200ms）避免在选择结果并隐藏窗口后因键位重复触发导致“快捷搜索反复打开”
function registerGlobalShortcut(hotkey = 'Alt+Space') {
    try {
        const ret = hotkeyController.register('global', hotkey, () => {
            const now = Date.now();
            // 若窗口已可见，仅聚焦即可，避免重复重新定位与闪烁
            if (searchWindow && !searchWindow.isDestroyed() && searchWindow.isVisible()) {
                try {
                    searchWindow.focus();
                } catch (_) {}
                return;
            }

            // 节流：短时间内忽略后续触发，解决重复打开问题
            if (now - lastSearchHotkeyTime < SEARCH_HOTKEY_COOLDOWN_MS) {
                console.log('忽略重复触发全局快捷键（节流中）');
                return;
            }

            lastSearchHotkeyTime = now;
            console.log('全局快捷键被触发:', hotkey);
            showSearchWindow();
        });

        if (!ret) {
            console.log('全局快捷键注册失败:', hotkey);
            return false;
        }

        console.log('全局快捷键注册成功:', hotkey);
        return true;
    } catch (error) {
        console.error('注册全局快捷键失败:', error);
        return false;
    }
}

// 注册钉住快捷键
function registerPinShortcut(hotkey = 'Ctrl+D') {
    try {
        const ret = hotkeyController.register('pin', hotkey, () => {
            console.log('钉住快捷键被触发:', hotkey);

            // 检查搜索窗口是否可见
            if (searchWindow && !searchWindow.isDestroyed() && searchWindow.isVisible()) {
                togglePin();
                return;
            }

            // 检查是否有插件窗口可以操作
            if (pluginManager) {
                // 首先检查当前获得焦点的插件窗口
                let targetWindow = pluginManager.getActivePluginWindow();
                let pluginName = null;

                if (targetWindow) {
                    pluginName = pluginManager.getPluginNameByWindow(targetWindow);
                    console.log('找到获得焦点的插件窗口:', pluginName);
                } else {
                    // 如果没有获得焦点的窗口，检查所有可见的插件窗口
                    targetWindow = pluginManager.getVisiblePluginWindow();
                    if (targetWindow) {
                        pluginName = pluginManager.getPluginNameByWindow(targetWindow);
                        console.log('找到可见的插件窗口:', pluginName);
                    }
                }

                if (pluginName && targetWindow) {
                    console.log('对插件窗口执行钉住操作:', pluginName);

                    // 立即执行钉住操作，不需要延迟
                    try {
                        const newPinStatus = pluginManager.togglePluginPin(pluginName);
                        console.log(`插件 ${pluginName} 钉住状态已更改为: ${newPinStatus}`);

                        // 如果成功钉住，确保窗口显示并获得焦点
                        if (newPinStatus && targetWindow && !targetWindow.isDestroyed()) {
                            if (!targetWindow.isVisible()) {
                                targetWindow.show();
                            }
                            targetWindow.focus();
                            console.log(`插件 ${pluginName} 已显示并获得焦点`);
                        }

                        return;
                    } catch (error) {
                        console.error('执行钉住操作时出错:', error);
                    }
                }
            }

            console.log('没有找到可操作的窗口，快捷键无效');
        });

        if (!ret) {
            console.log('钉住快捷键注册失败:', hotkey);
            return false;
        }

        console.log('钉住快捷键注册成功:', hotkey);
        return true;
    } catch (error) {
        console.error('注册钉住快捷键失败:', error);
        return false;
    }
}

// 切换钉住状态（内部函数）
function togglePin() {
    isPinned = !isPinned;
    console.log('搜索窗口钉住状态:', isPinned ? '已钉住' : '未钉住');

    if (searchWindow && !searchWindow.isDestroyed()) {
        // 更新窗口行为
        if (isPinned) {
            // 钉住时的行为调整
            searchWindow.setSkipTaskbar(false); // 显示在任务栏
            searchWindow.setMinimizable(true); // 允许最小化
        } else {
            // 取消钉住时恢复原始设置
            searchWindow.setSkipTaskbar(true); // 不显示在任务栏
            searchWindow.setMinimizable(false); // 不允许最小化
        }

        // 发送状态更新到渲染进程
        if (searchWindow.webContents) {
            searchWindow.webContents.send('pin-status-changed', isPinned);
        }
    }

    return isPinned;
}

// 获取资源路径的辅助函数
function getResourcePath(relativePath) {
    if (app.isPackaged) {
        // 打包后的路径
        return path.join(process.resourcesPath, 'app', relativePath);
    } else {
        // 开发环境的路径
        return path.join(__dirname, relativePath);
    }
}

// 获取图标路径
function getIconPath() {
    const root = app.isPackaged ? path.join(process.resourcesPath, 'build') : path.join(__dirname, 'build');
    const names = process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png', 'icon.ico'];
    return names.map(name => path.join(root, name)).find(file => fs.existsSync(file)) || null;
}

// 鼠标监控进程
let mouseMonitorProcess = null;
let mouseMonitorRestartTimer = null;
let panelSelectionPending = false;

// 启动鼠标监控（右键长按）
function startMouseMonitor() {
    if (mouseMonitorProcess || app.isQuiting || process.platform !== 'win32') return;

    const settings = loadSettings();
    if (!settings.enableRightClickPanel) return;

    const scriptPath = path.join(app.getPath('userData'), 'mouse-monitor.ps1');
    const configuredDelay = Number(settings.rightClickDelay);
    const delay = Number.isFinite(configuredDelay) ? Math.max(100, Math.min(5000, configuredDelay)) : 350;

    // 使用 WH_MOUSE_LL 低层钩子区分短按、长按和右键拖动。
    // 短按在释放时回放正常右键；长按整段吞掉，因此不会再与系统菜单争抢。
    const psScript = `
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$threshold = ${delay}
$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Collections.Concurrent;

${hookOutputSource}

public static class SanrenjzMouseHook {
    private const int WH_MOUSE_LL = 14;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint LLMHF_INJECTED = 0x00000001;
    private static IntPtr hook = IntPtr.Zero;
    private static HookProc callback = HookCallback;
    private static bool tracking;
    private static bool dragging;
    private static uint pressedAt;
    private static int startX;
    private static int startY;
    private static int threshold;
    private static readonly ConcurrentQueue<uint[]> replayQueue = new ConcurrentQueue<uint[]>();
    private static readonly AutoResetEvent replayReady = new AutoResetEvent(false);

    public static void Start(int longPressThreshold) {
        threshold = Math.Max(100, longPressThreshold);
        SanrenjzHookOutput.Start();
        var replayThread = new Thread(ReplayLoop);
        replayThread.IsBackground = true;
        replayThread.Start();
        using (Process process = Process.GetCurrentProcess())
        using (ProcessModule module = process.MainModule) {
            hook = SetWindowsHookEx(WH_MOUSE_LL, callback, GetModuleHandle(module.ModuleName), 0);
        }
        if (hook == IntPtr.Zero) throw new InvalidOperationException("SetWindowsHookEx failed");
        SanrenjzHookOutput.TryWrite("HOOK_READY");
        try { Application.Run(); }
        finally { UnhookWindowsHookEx(hook); }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode < 0) return CallNextHookEx(hook, nCode, wParam, lParam);
        MSLLHOOKSTRUCT data = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
        if ((data.flags & LLMHF_INJECTED) != 0) return CallNextHookEx(hook, nCode, wParam, lParam);
        int message = wParam.ToInt32();
        if (message == WM_RBUTTONDOWN) {
            tracking = true;
            pressedAt = data.time;
            startX = data.pt.x;
            startY = data.pt.y;
            return new IntPtr(1);
        }
        if (message == WM_MOUSEMOVE && tracking && (Math.Abs(data.pt.x - startX) > 8 || Math.Abs(data.pt.y - startY) > 8)) {
            tracking = false;
            dragging = true;
            // 回放会再次经过钩子，禁止在钩子线程中同步注入输入。
            QueueReplay(MOUSEEVENTF_RIGHTDOWN);
            return CallNextHookEx(hook, nCode, wParam, lParam);
        }
        if (message == WM_RBUTTONUP && dragging) {
            dragging = false;
            // 松开也排入同一队列，防止真实 UP 先于异步 DOWN 而留下按住状态。
            QueueReplay(MOUSEEVENTF_RIGHTUP);
            return new IntPtr(1);
        }
        if (message == WM_RBUTTONUP && tracking) {
            tracking = false;
            uint elapsed = unchecked(data.time - pressedAt);
            if (elapsed >= threshold) SanrenjzHookOutput.TryWrite("RBUTTON_LONG_PRESS_RELEASE");
            else ReplayRightClick();
            return new IntPtr(1);
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    private static void ReplayRightClick() {
        QueueReplay(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP);
    }

    private static void QueueReplay(params uint[] flags) {
        replayQueue.Enqueue(flags);
        replayReady.Set();
    }

    private static void ReplayLoop() {
        while (true) {
            replayReady.WaitOne();
            uint[] flags;
            while (replayQueue.TryDequeue(out flags)) {
                var inputs = new INPUT[flags.Length];
                for (int i = 0; i < flags.Length; i++) inputs[i].mi.dwFlags = flags[i];
                // 同次短按的 DOWN/UP 原子提交；不同点击和拖动按入队顺序回放。
                SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            }
        }
    }

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] private struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public UIntPtr dwExtraInfo; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc proc, IntPtr module, uint threadId);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string moduleName);
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public MOUSEINPUT mi; }
    [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms
[SanrenjzMouseHook]::Start($threshold)
`;

    try {
        // Windows PowerShell 5.1 需 BOM 才能正确读取脚本中的 UTF-8 中文注释。
        fs.writeFileSync(scriptPath, '\uFEFF' + psScript, 'utf8');
        
        console.log('启动鼠标监控进程...');
        const monitor = spawn('powershell', [
            '-ExecutionPolicy', 'Bypass',
            '-NoProfile',
            '-WindowStyle', 'Hidden',
            '-File', scriptPath
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        mouseMonitorProcess = monitor;
        monitor.stderr.on('data', data => console.warn('鼠标监听错误:', data.toString().trim()));
        monitor.on('error', error => {
            console.warn('鼠标监听启动失败:', error.message);
            if (mouseMonitorProcess === monitor) mouseMonitorProcess = null;
        });

        let stdoutBuf = '';
        monitor.stdout.on('data', (data) => {
            if (mouseMonitorProcess !== monitor || app.isQuiting) return;
            stdoutBuf += data.toString();
            const lines = stdoutBuf.split(/\r?\n/);
            stdoutBuf = lines.pop() || '';

            for (const rawLine of lines) {
                const line = (rawLine || '').trim();
                if (!line) continue;

                if (line === 'RBUTTON_LONG_PRESS_RELEASE') {
                    if (panelSelectionPending) continue;
                    panelSelectionPending = true;
                    console.log('检测到右键长按释放，采集选区后打开超级面板');
                    captureSelectedTextForPanel()
                        .then(context => { if (mouseMonitorProcess === monitor && !app.isQuiting) showSuperPanel({ context }); })
                        .catch(error => console.warn('采集超级面板选区失败:', error.message))
                        .finally(() => { panelSelectionPending = false; });
                    continue;
                }
            }
        });

        monitor.on('exit', (code) => {
            console.log(`鼠标监控进程退出，代码: ${code}`);
            // 旧进程退出不能清空刚启动的新进程，否则会产生重复全局钩子。
            if (mouseMonitorProcess !== monitor) return;
            mouseMonitorProcess = null;
            
            // 异常退出自动重启
            if (code !== 0 && code !== null && !app.isQuiting) {
                 mouseMonitorRestartTimer = setTimeout(() => {
                    mouseMonitorRestartTimer = null;
                    startMouseMonitor();
                 }, 5000);
            }
        });
        
    } catch (e) {
        console.error('启动鼠标监控失败:', e);
    }
}

// 停止鼠标监控
function stopMouseMonitor() {
    clearTimeout(mouseMonitorRestartTimer);
    mouseMonitorRestartTimer = null;
    if (mouseMonitorProcess) {
        console.log('停止鼠标监控进程');
        const monitor = mouseMonitorProcess;
        mouseMonitorProcess = null;
        monitor.stdin.end();
        monitor.kill();
    }
}

async function copySelectedTextToClipboard() {
    if (process.platform !== 'win32') return false;
    return new Promise((resolve) => {
        let timer;
        let finished = false;
        const finish = result => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve(result);
        };
        try {
            const psScript = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')";
            const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
            const proc = spawn('powershell', [
                '-NoProfile',
                '-ExecutionPolicy', 'Bypass',
                '-Sta',
                '-EncodedCommand', encoded
            ], {
                windowsHide: true,
                stdio: ['ignore', 'ignore', 'ignore']
            });

            timer = setTimeout(() => { proc.kill(); finish(false); }, 3000);
            proc.on('error', () => finish(false));
            proc.on('exit', (code) => finish(code === 0));
        } catch (e) {
            finish(false);
        }
    });
}



/**
 * 注册超级面板快捷键
 * 函数级注释：根据设置注册全局快捷键，按下后直接调用 showSuperPanel()
 */
function registerSuperPanelShortcut(hotkey = '') {
    try {
        const ret = hotkeyController.register('panel', hotkey, () => {
            showSuperPanel();
        });
        return !!ret;
    } catch (error) {
        return false;
    }
}



// 创建超级面板窗口
function createSuperPanelWindow() {
    if (superPanelWindow && !superPanelWindow.isDestroyed()) {
        return superPanelWindow;
    }

    superPanelWindow = new BrowserWindow({
        width: 450,
        height: 350,
        frame: false,
        show: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        transparent: true,
        icon: getIconPath(),
        focusable: true, // 确保窗口可以获得焦点
        acceptFirstMouse: true, // 即使窗口未被激活也接受第一次鼠标点击
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            webSecurity: false
        }
    });

    // 启用remote模块
    if (remoteMain) {
        remoteMain.enable(superPanelWindow.webContents);
    }

    if (!isSuperPanelFocusListenerRegistered) {
        app.on('browser-window-focus', (event, win) => {
            if (!superPanelWindow || superPanelWindow.isDestroyed() || !superPanelWindow.isVisible()) {
                return;
            }
            if (win === superPanelWindow) {
                return;
            }
            const parentWindow = win && typeof win.getParentWindow === 'function' ? win.getParentWindow() : null;
            if (parentWindow === superPanelWindow) {
                return;
            }
            if (hasActiveSuperPanelChildWindow()) {
                return;
            }
            superPanelWindow.hide();
        });
        isSuperPanelFocusListenerRegistered = true;
    }

    // 加载超级面板页面
    const superPanelPath = getResourcePath('super-panel.html');
    console.log('尝试加载超级面板:', superPanelPath);

    if (fs.existsSync(superPanelPath)) {
        console.log('✅ 从资源路径加载超级面板');
        superPanelWindow.loadFile(superPanelPath);
    } else {
        // 备用方案：从根目录加载
        const rootPath = path.join(__dirname, 'super-panel.html');
        console.log('尝试从根目录加载:', rootPath);

        if (fs.existsSync(rootPath)) {
            console.log('✅ 从根目录加载超级面板');
            superPanelWindow.loadFile(rootPath);
        } else {
            console.error('❌ 无法找到超级面板HTML文件');
            return null;
        }
    }

    // 失去焦点时隐藏窗口。'blur' 是主要方式，响应迅速。
    superPanelWindow.on('blur', () => {
        if (isSuperPanelGracePeriod || hasActiveSuperPanelChildWindow()) {
            // 宽限期内失去焦点，延迟再次检查，而不是直接忽略
            setTimeout(() => {
                if (superPanelWindow && !superPanelWindow.isDestroyed() && !superPanelWindow.isFocused() && !hasActiveSuperPanelChildWindow()) {
                    console.log('宽限期后检查发现失焦，隐藏面板');
                    superPanelWindow.hide();
                }
            }, 350);
            return;
        }

        if (superPanelWindow && !superPanelWindow.isDestroyed() && superPanelWindow.isVisible() && !hasActiveSuperPanelChildWindow()) {
            console.log('超级面板失去焦点（blur事件），自动隐藏');
            superPanelWindow.hide();
        }
    });

    // 为应对 'blur' 事件在某些情况下可能不触发的问题，增加一个基于轮询的失焦检测作为备用方案。
    let focusCheckInterval = null;

    superPanelWindow.on('show', () => {
        // 窗口显示时，启动轮询检查。
        if (focusCheckInterval) {
            clearInterval(focusCheckInterval);
        }
        focusCheckInterval = setInterval(() => {
            if (isSuperPanelGracePeriod || hasActiveSuperPanelChildWindow()) {
                return; // 宽限期内不检查
            }

            if (superPanelWindow && !superPanelWindow.isDestroyed() && superPanelWindow.isVisible() && !superPanelWindow.isFocused()) {
                console.log('超级面板失去焦点（轮询检测），自动隐藏');
                superPanelWindow.hide(); // hide() 会触发 'hide' 事件, 从而清除计时器。
            }
        }, 300); // 增加间隔到300毫秒
    });

    superPanelWindow.on('hide', () => {
        // 窗口隐藏时，停止轮询以节省资源。
        if (focusCheckInterval) {
            clearInterval(focusCheckInterval);
            focusCheckInterval = null;
        }

        // 重置输入框活动状态
        hasActiveInput = false;
        console.log('🔍 面板隐藏，重置输入框状态');
    });

    // 监听窗口关闭
    superPanelWindow.on('closed', () => {
        superPanelWindow = null;
    });

    return superPanelWindow;
}

let isIgnoreEsc = false; // 是否忽略 ESC 键（用于处理右键冲突）
let isSuperPanelPendingActivation = false;
let superPanelPendingActivationTimer = null;

function activateSuperPanelWindow() {
    if (!superPanelWindow || superPanelWindow.isDestroyed() || !superPanelWindow.isVisible()) {
        return;
    }

    isSuperPanelPendingActivation = false;
    if (superPanelPendingActivationTimer) {
        clearTimeout(superPanelPendingActivationTimer);
        superPanelPendingActivationTimer = null;
    }

    superPanelWindow.setAlwaysOnTop(true, 'screen-saver');
    setTimeout(() => {
        if (superPanelWindow && !superPanelWindow.isDestroyed()) {
            superPanelWindow.setAlwaysOnTop(true);
        }
    }, 100);

    setTimeout(() => {
        if (!superPanelWindow || superPanelWindow.isDestroyed()) return;

        superPanelWindow.focus();
        if (superPanelWindow.webContents) {
            superPanelWindow.webContents.focus();
        }

        if (!superPanelWindow.isFocused()) {
            console.log('⚠️ 尝试强制激活窗口');
            superPanelWindow.moveTop();
            superPanelWindow.focus();
        }

        console.log('✅ 超级面板已激活');
        setTimeout(() => {
            isSuperPanelGracePeriod = false;
        }, 600);
    }, 30);
}

// 显示超级面板
function showSuperPanel(options = {}) {
    const activate = options && options.activate !== false;
    const panelContext = options && options.context ? options.context : null;

    try {
        // 异步记录当前活动窗口句柄，消除UI阻塞
        hasActiveInput = false; // 重置输入框活动状态
        recordActiveWindowWithInputStatusAsync();
    } catch (error) {
        console.error('启动记录活动窗口失败:', error);
    }

    if (!superPanelWindow || superPanelWindow.isDestroyed()) {
        // 添加 IPC 处理：检查是否应该忽略 ESC
        ipcMain.removeHandler('should-ignore-esc'); // 先移除，防止重复注册
        ipcMain.handle('should-ignore-esc', () => {
            return isIgnoreEsc;
        });
        createSuperPanelWindow();
    }

    if (!superPanelWindow) {
        console.error('❌ 无法创建超级面板窗口');
        return;
    }

    try {
        // 标记进入宽限期，避免立即被 blur 隐藏
        isSuperPanelGracePeriod = true;
        isSuperPanelPendingActivation = !activate;
        
        // 获取鼠标位置并在鼠标附近显示
        const { screen } = require('electron');
        const cursorPoint = screen.getCursorScreenPoint();
        const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

        const windowWidth = 450;
        const windowHeight = 350;

        // 计算窗口位置，在鼠标右侧显示
        let x = cursorPoint.x + 20;
        let y = cursorPoint.y - windowHeight / 2;

        // 边界检查，确保窗口在屏幕内
        if (x + windowWidth > currentDisplay.workArea.x + currentDisplay.workArea.width) {
            x = cursorPoint.x - windowWidth - 20; // 显示在鼠标左侧
        }
        if (x < currentDisplay.workArea.x) {
            x = currentDisplay.workArea.x + 10;
        }
        if (y < currentDisplay.workArea.y) {
            y = currentDisplay.workArea.y + 10;
        }
        if (y + windowHeight > currentDisplay.workArea.y + currentDisplay.workArea.height) {
            y = currentDisplay.workArea.y + currentDisplay.workArea.height - windowHeight - 10;
        }

        superPanelWindow.setBounds({ x, y, width: windowWidth, height: windowHeight });
        if (activate) {
            superPanelWindow.show();
        } else if (typeof superPanelWindow.showInactive === 'function') {
            superPanelWindow.showInactive();
        } else {
            superPanelWindow.show();
        }

        // 鼠标长按路径直接发送已采集的选区；快捷键路径仍允许页面读取剪贴板作为兼容回退。
        if (superPanelWindow.webContents) {
            if (panelContext) superPanelWindow.webContents.send('super-panel-context', panelContext);
            else superPanelWindow.webContents.send('refresh-super-panel');
        }

        if (activate) {
            activateSuperPanelWindow();
        } else {
            if (superPanelPendingActivationTimer) {
                clearTimeout(superPanelPendingActivationTimer);
            }
            superPanelPendingActivationTimer = setTimeout(() => {
                if (isSuperPanelPendingActivation && superPanelWindow && !superPanelWindow.isDestroyed() && superPanelWindow.isVisible()) {
                    superPanelWindow.hide();
                }
                isSuperPanelPendingActivation = false;
                isSuperPanelGracePeriod = false;
                superPanelPendingActivationTimer = null;
            }, 5000);
        }

    } catch (error) {
        console.error('设置超级面板位置失败:', error);
        // ... (回退逻辑保持不变)
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;
        const windowWidth = 450;
        const windowHeight = 350;
        const x = Math.round((width - windowWidth) / 2);
        const y = Math.round((height - windowHeight) / 3);
        superPanelWindow.setBounds({ x, y, width: windowWidth, height: windowHeight });
        superPanelWindow.show();
        activateSuperPanelWindow();
        
        // 出错回退时也要发送刷新请求
        if (superPanelWindow.webContents) {
            if (panelContext) superPanelWindow.webContents.send('super-panel-context', panelContext);
            else superPanelWindow.webContents.send('refresh-super-panel');
        }
    }
}

// 创建搜索浮窗
function createSearchWindow() {
    if (searchWindow && !searchWindow.isDestroyed()) {
        return searchWindow;
    }

    searchWindow = new BrowserWindow({
        width: 600,
        height: 400,
        frame: false,
        show: false,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        icon: getIconPath(), // 添加图标
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            webSecurity: false
        }
    });

    // 启用remote模块
    if (remoteMain) {
        remoteMain.enable(searchWindow.webContents);
    }

    // 加载搜索窗口页面 - 修复打包后的路径问题
    const searchWindowPath = getResourcePath('search-window.html');
    console.log('尝试加载搜索窗口:', searchWindowPath);

    if (fs.existsSync(searchWindowPath)) {
        console.log('✅ 从资源路径加载搜索窗口');
        searchWindow.loadFile(searchWindowPath);
    } else {
        // 备用方案1：尝试从应用根目录加载
        const rootPath = path.join(__dirname, 'search-window.html');
        console.log('尝试从根目录加载:', rootPath);

        if (fs.existsSync(rootPath)) {
            console.log('✅ 从根目录加载搜索窗口');
            searchWindow.loadFile(rootPath);
        } else {
            // 备用方案2：如果是打包后的应用，尝试从asar包外部加载
            const asarPath = app.isPackaged
                ? path.join(path.dirname(process.execPath), 'search-window.html')
                : './search-window.html';
            console.log('尝试从ASAR外部加载:', asarPath);

            if (fs.existsSync(asarPath)) {
                console.log('✅ 从ASAR外部加载搜索窗口');
                searchWindow.loadFile(asarPath);
            } else {
                console.error('❌ 无法找到搜索窗口HTML文件');
                // 创建一个简单的内联搜索窗口
                searchWindow.loadURL(`data:text/html;charset=utf-8,
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>搜索</title>
                        <style>
                            body { font-family: 'Microsoft YaHei', sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
                            .search-box { width: 100%; padding: 10px; font-size: 16px; border: 1px solid #ddd; border-radius: 4px; }
                            .notice { margin-top: 20px; color: #666; text-align: center; }
                        </style>
                    </head>
                    <body>
                        <input type="text" class="search-box" placeholder="搜索功能暂时不可用，请重新安装应用" disabled>
                        <div class="notice">搜索窗口文件缺失，请联系技术支持</div>
                    </body>
                    </html>
                `);
            }
        }
    }

    // 失去焦点时关闭窗口（除非被钉住）
    searchWindow.on('blur', () => {
        if (searchWindow && !searchWindow.isDestroyed() && !isPinned) {
            console.log('搜索窗口失去焦点，自动关闭');
            restoreFocusToLastActiveWindow();
            searchWindow.close();
        }
    });

    // 监听窗口关闭
    searchWindow.on('closed', () => {
        searchWindow = null;
        isPinned = false; // 重置钉住状态
    });

    return searchWindow;
}

// 显示搜索窗口
/**
 * 显示搜索窗口
 * 在显示搜索窗口前，记录前台活动窗口与其焦点类型，
 * 以便后续在文本片段场景中恢复焦点并自动粘贴。
 */
function showSearchWindow() {
    try {
        // 异步记录当前活动窗口，消除阻塞
        hasActiveInput = false; // 重置输入框活动状态
        recordActiveWindowWithInputStatusAsync();
    } catch (error) {
        console.error('启动记录活动窗口失败:', error);
    }

    if (!searchWindow || searchWindow.isDestroyed()) {
        createSearchWindow();
    }

    try {
        // 获取鼠标位置并尝试跟随显示
        const { screen } = require('electron');
        const cursorPoint = screen.getCursorScreenPoint();
        const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

        const windowWidth = 600;
        const windowHeight = 400;

        // 计算窗口位置，在鼠标上方显示
        let x = cursorPoint.x - windowWidth / 2;
        let y = cursorPoint.y - 200; // 在鼠标上方200像素

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

        searchWindow.setBounds({ x, y, width: windowWidth, height: windowHeight });
    } catch (error) {
        console.error('设置浮窗位置失败，使用默认位置:', error);

        // 出错时回退到默认位置
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;

        const windowWidth = 600;
        const windowHeight = 400;
        const x = Math.round((width - windowWidth) / 2);
        const y = Math.round((height - windowHeight) / 3);

        searchWindow.setBounds({ x, y, width: windowWidth, height: windowHeight });
    }

    searchWindow.show();
    searchWindow.focus();
}

// 记录当前活动窗口 (同步)
function recordActiveWindow() {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const execSync = require('child_process').execSync;
    const tempDir = os.tmpdir();
    const scriptPath = path.join(tempDir, `get_active_window_${Date.now()}.ps1`);

    const psScriptContentArr = [
        '$ErrorActionPreference = "Stop"',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        'try {',
        '    $proc = Get-Process | ',
        '        Where-Object { $_.MainWindowTitle -ne "" -and $_.MainWindowHandle -ne 0 -and $_.ProcessName -ne "ApplicationFrameHost" -and $_.ProcessName -ne "SearchHost" } | ',
        '        Sort-Object StartTime -Descending | ',
        '        Select-Object -First 1;',
        '',
        '    if ($proc) {',
        '        Write-Output "$($proc.MainWindowHandle)|$($proc.MainWindowTitle)"',
        '    } else {',
        '        Write-Output "0||"',
        '    }',
        '} catch {',
        '    Write-Output "0||PS_SCRIPT_ERROR: $($_.Exception.Message)"',
        '}'
    ];
    const psScriptContent = psScriptContentArr.join('\n');

    try {
        console.log('记录当前活动窗口 (同步, 使用临时 .ps1 文件)');
        fs.writeFileSync(scriptPath, psScriptContent, { encoding: 'utf8' });

        const commandToRun = `powershell -ExecutionPolicy Bypass -NonInteractive -NoProfile -File "${scriptPath}"`;
        console.log('Executing PowerShell script for recordActiveWindow:', commandToRun);

        const output = execSync(commandToRun, { windowsHide: true, timeout: 3000, encoding: 'utf8' }).toString().trim();

        if (output && output !== '0||' && !output.startsWith("0||PS_SCRIPT_ERROR")) {
            const parts = output.split('|');
            if (parts.length === 2) {
                const [handle, title] = parts;
                if (handle && title && /^[1-9][0-9]*$/.test(handle)) {
                    lastActiveWindow = { handle, title, timestamp: Date.now(), fallback: false };
                    console.log('记录活动窗口成功:', { title, handle });
                } else {
                    console.log('解析到的句柄或标题无效 (handle, title):', handle, title, 'Output was:', output);
                    lastActiveWindow = { handle: null, title: 'Unknown', timestamp: Date.now(), fallback: true };
                }
            } else {
                console.log('解析活动窗口信息失败 (output did not split into 2 parts): ', output);
                lastActiveWindow = { handle: null, title: 'Unknown', timestamp: Date.now(), fallback: true };
            }
        } else {
            console.log('未获取到有效的活动窗口信息或脚本执行出错 (output): ', output);
            lastActiveWindow = { handle: null, title: 'Unknown', timestamp: Date.now(), fallback: true };
        }
    } catch (error) {
        console.error('记录活动窗口异常 (execSync for .ps1):', error.message);
        if (error.stderr) {
            console.error('记录活动窗口 stderr:', error.stderr.toString());
        }
        if (error.stdout) {
            console.error('记录活动窗口 stdout (on execSync error):', error.stdout.toString());
        }
        lastActiveWindow = { handle: null, title: 'Unknown', timestamp: Date.now(), fallback: true };
    } finally {
        try {
            if (fs.existsSync(scriptPath)) {
                fs.unlinkSync(scriptPath);
            }
        } catch (cleanupError) {
            console.error('清理临时PS脚本失败 (recordActiveWindow):', cleanupError.message);
        }
    }
}

/**
 * 记录当前前台活动窗口，并检测其焦点是否位于文本输入控件上 (异步非阻塞版本)
 * 功能说明：
 * - 使用 PowerShell 调用 Win32 API 获取：窗口句柄、标题、当前焦点控件类名、可见插入符(hwndCaret/rcCaret)
 * - 若存在焦点控件，使用 GetAncestor(GA_ROOT) 获取其顶级窗口作为更稳健的恢复目标
 * - 综合类名白名单与插入符存在进行 isInputLikely 判断，设置全局 wasTextInputBeforeSearch
 * - 同时记录 focusHandle 以便在恢复焦点和 WM_PASTE 时作为回退依据
 */
function recordActiveWindowWithInputStatusAsync() {
    const { exec } = require('child_process');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const tempDir = os.tmpdir();
    const scriptPath = path.join(tempDir, `get_active_window_with_focus_${Date.now()}.ps1`);

    const psScript = [
        '$ErrorActionPreference = "Stop"',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
        '',
        '# GA_ROOT = 2 用于获取控件所属的顶级窗口',
        '$GA_ROOT = 2',
        '',
        '$signature = @"\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\n\nnamespace Win32 {\n    [StructLayout(LayoutKind.Sequential)]\n    public struct RECT {\n        public int left; public int top; public int right; public int bottom;\n    }\n\n    [StructLayout(LayoutKind.Sequential)]\n    public struct GUITHREADINFO {\n        public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret;\n    }\n\n    public static class User32 {\n        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n        [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);\n        [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);\n        [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);\n        [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);\n        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);\n        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n    }\n}\n"@',
        'try { Add-Type -TypeDefinition $signature -Language CSharp -ErrorAction Stop } catch {}',
        'if (-not ("Win32.User32" -as [type])) { try { Add-Type -TypeDefinition $signature -Language CSharp -ErrorAction Stop } catch {} }',
        '',
        '$hWnd = [Win32.User32]::GetForegroundWindow()',
        'if ($hWnd -eq [IntPtr]::Zero) { Write-Output "0||"; return }',
        '',
        '$sb = New-Object System.Text.StringBuilder 256',
        '[void][Win32.User32]::GetWindowText($hWnd, $sb, $sb.Capacity)',
        '$title = $sb.ToString()',
        '',
        '$tid = [Win32.User32]::GetWindowThreadProcessId($hWnd, [ref]([uint32]0))',
        '$info = New-Object Win32.GUITHREADINFO',
        '$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)',
        '[void][Win32.User32]::GetGUIThreadInfo($tid, [ref]$info)',
        '',
        '$focusHwnd = $info.hwndFocus',
        '$classNameSB = New-Object System.Text.StringBuilder 256',
        'if ($focusHwnd -ne [IntPtr]::Zero) { [void][Win32.User32]::GetClassName($focusHwnd, $classNameSB, $classNameSB.Capacity) }',
        '$className = $classNameSB.ToString()',
        '',
        '# 通过焦点控件的可见插入符(光标)来辅助判断输入环境',
        '$caretHwnd = $info.hwndCaret',
        '$rc = $info.rcCaret',
        '$caretLikely = $false',
        'if ($caretHwnd -ne [IntPtr]::Zero) { $caretLikely = $true }',
        'else { if (($rc.right - $rc.left) -gt 0 -and ($rc.bottom - $rc.top) -gt 0) { $caretLikely = $true } }',
        '',
        '# 如果有焦点控件，则获取其顶级窗口作为目标窗口句柄（更稳定）',
        '$targetHwnd = $hWnd',
        'if ($focusHwnd -ne [IntPtr]::Zero) { $targetHwnd = [Win32.User32]::GetAncestor($focusHwnd, $GA_ROOT) }',
        '$handleInt = $targetHwnd.ToInt64()',
        '$focusHandleInt = if ($focusHwnd -ne [IntPtr]::Zero) { $focusHwnd.ToInt64() } else { 0 }',
        '$classLower = $className.ToLower()',
        '$classLikely = ($classLower.Contains("edit") -or $classLower.Contains("richedit") -or $classLower.Contains("renderwidgethost") -or $classLower.Contains("textbox") -or $classLower.Contains("input") -or $classLower.Contains("scintilla") -or $classLower.Contains("chrome_widgetwin"))',
        '$isInputLikely = [System.Convert]::ToInt32($caretLikely -or $classLikely)',
        'Write-Output "$handleInt|$title|$className|$focusHandleInt|$isInputLikely"'
    ].join('\n');

    try {
        fs.writeFileSync(scriptPath, psScript, { encoding: 'utf8' });
        const commandToRun = `powershell -ExecutionPolicy Bypass -NonInteractive -NoProfile -File "${scriptPath}"`;

        // 异步执行，不阻塞主进程
        exec(commandToRun, { windowsHide: true, timeout: 3000, encoding: 'utf8' }, (error, stdout, stderr) => {
            // 清理临时文件
            try {
                if (fs.existsSync(scriptPath)) {
                    fs.unlinkSync(scriptPath);
                }
            } catch (e) { }

            if (error) {
                console.error('记录活动窗口异常(Async):', error.message);
                // 仅在完全失败时重置（或者保留旧值？为了安全，重置比较好，防止粘贴到错误窗口）
                lastActiveWindow = { handle: null, title: 'Unknown', focusHandle: '0', timestamp: Date.now(), fallback: true };
                wasTextInputBeforeSearch = false;
                return;
            }

            const output = stdout ? stdout.toString().trim() : '';

            if (output && !output.startsWith('0||')) {
                const parts = output.split('|');
                const handle = parts[0];
                const title = parts[1] || 'Unknown';
                const className = parts[2] || '';
                const focusHandle = parts[3] || '0';
                const isInputLikely = parts[4] === '1';

                if (handle && /^[1-9][0-9]*$/.test(handle)) {
                    lastActiveWindow = { handle, title, focusHandle, timestamp: Date.now(), fallback: false };
                } else {
                    lastActiveWindow = { handle: null, title, focusHandle, timestamp: Date.now(), fallback: true };
                }

                const cls = className.toLowerCase();
                wasTextInputBeforeSearch = Boolean(isInputLikely || cls.includes('edit') || cls.includes('richedit') || cls.includes('renderwidgethost') || cls.includes('textbox') || cls.includes('input') || cls.includes('scintilla') || cls.includes('chrome_widgetwin'));
                // console.log('记录活动窗口成功(Async):', { title, wasTextInputBeforeSearch });
            } else {
                console.log('未获取到有效的活动窗口信息(Async): ', output);
                lastActiveWindow = { handle: null, title: 'Unknown', focusHandle: '0', timestamp: Date.now(), fallback: true };
                wasTextInputBeforeSearch = false;
            }
        });
    } catch (error) {
        console.error('启动记录活动窗口脚本失败:', error.message);
        try { if (fs.existsSync(scriptPath)) { fs.unlinkSync(scriptPath); } } catch (e) { }
    }
}

/**
 * 恢复焦点到记录的前台活动窗口
 * 功能说明：
 * - 优先使用记录的顶级窗口句柄(lastActiveWindow.handle)；若不可用则回退到焦点控件句柄的 GA_ROOT 顶级窗口
 * - 使用 ShowWindow/BringWindowToTop/AttachThreadInput 提升 SetForegroundWindow 成功率
 * - 将窗口置顶并尝试前台激活，确保后续按键或 WM_PASTE 能落到目标窗体
 */
function restoreFocusToLastActiveWindow() {
    try {
        if (!lastActiveWindow || (!lastActiveWindow.handle && !lastActiveWindow.focusHandle)) {
            console.log('没有可恢复焦点的窗口句柄');
            return;
        }

        const searchHandle = getWindowHandleString(searchWindow);
        if (searchHandle && (lastActiveWindow.handle === searchHandle || lastActiveWindow.focusHandle === searchHandle)) {
            console.log('上次活动窗口是搜索窗口，跳过恢复焦点');
            return;
        }

        const os = require('os');
        const fs = require('fs');
        const path = require('path');
        const execSync = require('child_process').execSync;
        const tempDir = os.tmpdir();
        const scriptPath = path.join(tempDir, `restore_focus_${Date.now()}.ps1`);

        const ps = [
            '$ErrorActionPreference = "Stop"',
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
            '$OutputEncoding = [System.Text.Encoding]::UTF8',
            '$signature = @"\nusing System;\nusing System.Runtime.InteropServices;\nnamespace Win32 {\n  public static class User32 {\n    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);\n    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);\n    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);\n    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);\n    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);\n  }\n  public static class Kernel32 {\n    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();\n  }\n}\n"@',
            'try { Add-Type -TypeDefinition $signature -Language CSharp -ErrorAction Stop } catch {}',
            'if (-not ("Win32.User32" -as [type])) { try { Add-Type -TypeDefinition $signature -Language CSharp -ErrorAction Stop } catch {} }',
            `$rawHandle = ${lastActiveWindow.handle ? `'${lastActiveWindow.handle}'` : "'0'"}`,
            `$rawFocusHandle = ${lastActiveWindow.focusHandle ? `'${lastActiveWindow.focusHandle}'` : "'0'"}`,
            '$hwnd = [IntPtr]::Zero',
            'if ($rawHandle -ne "0" -and $rawHandle -ne "") { $hwnd = New-Object IntPtr ([Int64]$rawHandle) }',
            'if ($hwnd -eq [IntPtr]::Zero -and $rawFocusHandle -ne "0" -and $rawFocusHandle -ne "") {',
            '    $fhwnd = New-Object IntPtr ([Int64]$rawFocusHandle)',
            '    $GA_ROOT = 2',
            '    $parent = [Win32.User32]::GetAncestor($fhwnd, $GA_ROOT)',
            '    if ($parent -ne [IntPtr]::Zero) { $hwnd = $parent } else { $hwnd = $fhwnd }',
            '}',
            'if ($hwnd -ne [IntPtr]::Zero) {',
            '  [void][Win32.User32]::ShowWindow($hwnd, 5)',
            '  [void][Win32.User32]::BringWindowToTop($hwnd)',
            '  $targetTid = [Win32.User32]::GetWindowThreadProcessId($hwnd, [ref]([uint32]0))',
            '  $currentTid = [Win32.Kernel32]::GetCurrentThreadId()',
            '  if ($targetTid -ne 0 -and $currentTid -ne 0) { [void][Win32.User32]::AttachThreadInput($currentTid, $targetTid, $true) }',
            '  try { [void][Win32.User32]::SetForegroundWindow($hwnd) } finally { if ($targetTid -ne 0 -and $currentTid -ne 0) { [void][Win32.User32]::AttachThreadInput($currentTid, $targetTid, $false) } }',
            '}'
        ].join('\n');

        fs.writeFileSync(scriptPath, ps, { encoding: 'utf8' });
        const commandToRun = `powershell -ExecutionPolicy Bypass -NonInteractive -NoProfile -File "${scriptPath}"`;
        execSync(commandToRun, { windowsHide: true, timeout: 2000, encoding: 'utf8' });
    } catch (error) {
        console.error('恢复焦点失败:', error.message);
    }
}

function getWindowHandleString(win) {
    try {
        if (!win || win.isDestroyed()) return null;
        const buffer = win.getNativeWindowHandle();
        if (!buffer || buffer.length === 0) return null;
        if (buffer.length >= 8 && typeof buffer.readBigUInt64LE === 'function') {
            return buffer.readBigUInt64LE(0).toString();
        }
        if (buffer.length >= 4 && typeof buffer.readUInt32LE === 'function') {
            return buffer.readUInt32LE(0).toString();
        }
        return buffer.toString('hex');
    } catch (error) {
        return null;
    }
}

// 创建主窗口
function createWindow() {
    try {
        // 调整为原来大小的三分之二
        mainWindow = new BrowserWindow({
            show: !mobileAcceptance && !mergedAcceptance && process.env.SANRENJZ_TEST_HIDDEN !== '1',
            width: 1000,  // 原来是1200
            height: 680, // 原来是800
            title: '三人聚智',
            icon: getIconPath(), // 修改为使用新的图标路径函数
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true,
                webSecurity: false
            }
        });

        // 启用remote模块
        if (remoteMain) {
            remoteMain.enable(mainWindow.webContents);
        }

        // 移除菜单栏 - 多平台兼容
        if (process.platform === 'darwin') {
            // macOS系统需要设置应用级别的空菜单
            Menu.setApplicationMenu(null);
        } else {
            // Windows和Linux直接移除窗口菜单
            mainWindow.setMenu(null);
        }

        const { HotkeyController } = require(app.isPackaged ? path.join(process.resourcesPath, 'app', 'hotkey-controller.js') : './app/hotkey-controller');
        hotkeyController?.dispose();
        hotkeyController = new HotkeyController({ globalShortcut, window: mainWindow, onCaptured: result => {
            if (!mainWindow.isDestroyed()) mainWindow.webContents.send('hotkey:captured', result);
        } });
        // 初始化插件管理器
        pluginManager = new PluginManager(mainWindow, { loadSettings, onLog: event => mergedHost?.recordToolLog(event) });
        if (!mergedHost) {
            const { createMergedHost } = require(app.isPackaged ? path.join(process.resourcesPath, 'app', 'merged-host.js') : './app/merged-host');
            mergedHost = createMergedHost({ app, ipcMain, dialog, shell, getWindow: () => mainWindow, getManager: () => pluginManager, loadSettings, saveSettings, refresh: refreshPluginCatalog, send: sendRendererEvent });
        }
        // 远程图片可能长期挂起，不能让它们阻塞插件自启动；DOM 就绪即可开始。
        mainWindow.webContents.once('dom-ready', () => {
            if (mergedAcceptance) return;
            mergedHost.startConfigured().catch(error => console.warn('Python 自启动失败:', error.message));
            pluginManager.startConfiguredPlugins(() => app.isQuiting === true)
                .then(results => {
                    const failures = results.filter(item => !item.success);
                    if (failures.length) sendRendererEvent('notify', {
                        title: '部分插件未能自动启动',
                        message: failures.map(item => `${item.name}：${item.error}`).join('；'),
                        type: 'warning'
                    });
                })
                .catch(error => console.warn('加载插件自启动设置失败:', error.message));
        });

        mainWindow.loadFile(path.join(__dirname, 'index.html')).catch(error => {
            console.error('加载主界面失败:', error.message);
        });

        // 启动时应用自定义插件数据存储目录
        // 函数级注释：
        // - 在插件管理器初始化后，立即读取设置中的 customPluginDataPath
        // - 若存在且有效，则显式调用 updatePluginDataDirectory，确保主进程的存储读写指向用户选择路径
        // - 若不存在，则确保使用默认路径 userData/plugin-data，避免首次读取落到错误位置
        (function applyBootPluginDataDirectory() {
            try {
                const settings = loadSettings();
                const defaultPath = path.join(app.getPath('userData'), 'plugin-data');
                const targetPath = settings.customPluginDataPath && fs.existsSync(settings.customPluginDataPath)
                    ? settings.customPluginDataPath
                    : defaultPath;
                if (pluginManager && typeof pluginManager.updatePluginDataDirectory === 'function') {
                    pluginManager.updatePluginDataDirectory(targetPath);
                    console.log('启动时应用插件数据目录:', targetPath);
                }
            } catch (err) {
                console.error('启动时应用插件数据目录失败:', err);
            }
        })();

        // 监听窗口关闭事件
        mainWindow.on('closed', () => {
            mainWindow = null;
            if (pluginManager) {
                pluginManager.stopAllPlugins();
            }
        });

        // 开发环境下打开开发者工具
        if (!app.isPackaged && process.argv.some(arg => arg.startsWith('--inspect') || arg === '--open-devtools')) {
            mainWindow.webContents.openDevTools();
        }

        // 添加系统托盘功能
        if (!mergedAcceptance) createTray();

        console.log('主窗口创建成功');

    } catch (error) {
        console.error('创建主窗口失败:', error);
        throw error;
    }
}

// 系统托盘相关
let tray = null;

// 创建系统托盘
function createTray() {
    try {
        // 创建托盘图标 - 修改为使用新的图标路径
        const iconPath = getIconPath();
        console.log('托盘图标路径:', iconPath);

        // 确保图标文件存在
        if (!iconPath || !fs.existsSync(iconPath)) {
            console.log('托盘图标文件不存在，跳过托盘创建');
            return;
        }

        tray = new Tray(iconPath);

        // 设置托盘提示
        tray.setToolTip('三人聚智-效率工具');

        // 托盘菜单
        const contextMenu = Menu.buildFromTemplate([
            {
                label: '显示主窗口',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                        // 确保窗口在最前面
                        mainWindow.setAlwaysOnTop(true);
                        setTimeout(() => {
                            mainWindow.setAlwaysOnTop(false);
                        }, 100);
                    }
                }
            },
            {
                label: '搜索功能',
                accelerator: loadSettings().globalHotkey || 'Alt+Space',
                click: () => {
                    showSearchWindow();
                }
            },
            {
                label: '设置超级面板',
                click: () => {
                    console.log('🔧 打开超级面板设置');
                    createSuperPanelManagerWindow();
                }
            },
            { type: 'separator' },
            {
                label: '关于',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
            },
            {
                label: '退出应用',
                click: () => {
                    // 彻底退出应用
                    app.isQuiting = true;
                    app.quit();
                }
            }
        ]);

        // 设置托盘上下文菜单
        tray.setContextMenu(contextMenu);

        // 双击托盘图标显示主窗口（Windows 和 Linux）
        tray.on('double-click', () => {
            console.log('托盘图标被双击');
            if (mainWindow) {
                if (mainWindow.isVisible()) {
                    mainWindow.focus();
                } else {
                    mainWindow.show();
                    mainWindow.focus();
                    // 确保窗口在最前面
                    mainWindow.setAlwaysOnTop(true);
                    setTimeout(() => {
                        mainWindow.setAlwaysOnTop(false);
                    }, 100);
                }
            }
        });

        // 单击托盘图标的处理（主要针对 macOS）
        tray.on('click', () => {
            console.log('托盘图标被单击');
            if (process.platform === 'darwin') {
                // macOS 下单击显示/隐藏窗口
                if (mainWindow) {
                    if (mainWindow.isVisible()) {
                        mainWindow.hide();
                    } else {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
            } else {
                // Windows 和 Linux 下单击切换显示/隐藏窗口
                if (mainWindow) {
                    if (mainWindow.isVisible()) {
                        console.log('主窗口可见，隐藏到托盘');
                        mainWindow.hide();
                    } else {
                        console.log('主窗口隐藏，显示并获得焦点');
                        mainWindow.show();
                        mainWindow.focus();
                        mainWindow.setAlwaysOnTop(true);
                        setTimeout(() => {
                            mainWindow.setAlwaysOnTop(false);
                        }, 100);
                    }
                }
            }
        });

        console.log('系统托盘创建成功');
    } catch (error) {
        console.error('创建系统托盘失败:', error);
        console.log('应用将继续运行，但没有系统托盘功能');
    }
}

// IPC 处理程序

// 获取插件列表
ipcMain.handle('get-plugin-list', async () => {
    if (pluginManager) {
        return await pluginManager.getPluginList();
    }
    return [];
});

ipcMain.handle('get-plugin-management-list', async () => {
    return mergedHost ? mergedHost.managementList() : [];
});

// 隐藏只影响主界面卡片；搜索、超级面板和管理列表继续使用完整插件目录。
ipcMain.handle('get-main-plugin-list', async () => mergedHost ? mergedHost.list(false) : []);

ipcMain.handle('set-plugin-preference', async (_event, pluginName, key, value) => {
    try {
        if (!['showInMainUI', 'autoStartWithMain'].includes(key) || typeof value !== 'boolean') {
            throw new Error('无效的插件管理选项');
        }
        const plugins = pluginManager ? await pluginManager.getPluginList() : [];
        if (!plugins.some(plugin => plugin.name === pluginName)) throw new Error('插件未安装');
        const current = loadSettings().pluginPreferences || {};
        // 宿主管理选项集中保存，主界面无需读取可能很大的插件历史和缓存。
        saveSettings({ pluginPreferences: {
            ...current,
            [pluginName]: { ...current[pluginName], [key]: value }
        } });
        sendRendererEvent('plugin-preferences-changed', { pluginName, key });
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('set-plugin-search-keywords', async (_event, pluginName, keywords) => {
    if (!Array.isArray(keywords) || keywords.some(keyword => typeof keyword !== 'string')) throw new Error('搜索关键词必须是文字列表');
    const plugins = pluginManager ? await pluginManager.getPluginList() : [];
    if (!plugins.some(plugin => plugin.name === pluginName)) throw new Error('插件未安装');
    const searchSettings = loadSettings().pluginSearchSettings || {};
    // 仅更新本插件，避免较早打开的管理列表覆盖其他插件刚保存的关键词。
    const saved = saveSettings({ pluginSearchSettings: { ...searchSettings, [pluginName]: {
        ...searchSettings[pluginName], keywords: [...new Set(keywords.map(keyword => keyword.trim()).filter(Boolean))]
    } } });
    invalidateSearchCatalog('plugin-search-keywords');
    return { success: true, keywords: saved.pluginSearchSettings[pluginName].keywords };
});

// 快捷搜索统一目录缓存：插件、命令和文本片段只在失效后重新构建。
const searchCatalogCache = { version: 0, dirty: true, data: null, loading: null };

function invalidateSearchCatalog(reason = 'unknown') {
    searchCatalogCache.dirty = true;
    searchCatalogCache.version += 1;
    if (searchWindow && !searchWindow.isDestroyed()) {
        searchWindow.webContents.send('search-catalog-invalidated', { reason, version: searchCatalogCache.version });
    }
}

let pluginCatalogRefresh = null;

// 导入和手动刷新共用实际插件目录，同步所有入口而不重启正在运行的插件。
async function refreshPluginCatalog(reason = 'manual') {
    const previousRefresh = pluginCatalogRefresh || Promise.resolve();
    // 串行扫描，保证导入完成后的刷新不会复用导入前尚未结束的扫描结果。
    const refresh = previousRefresh.catch(() => {}).then(async () => {
        if (!pluginManager) throw new Error('插件管理器未初始化');
        const plugins = await pluginManager.getPluginList({ force: true });
        const manifests = new Map(pluginManager.catalog.entries.map(entry => [entry.path, entry.config]));
        const installedNames = new Set(plugins.map(plugin => plugin.name));
        for (const name of superPanelRegistry.keys()) {
            if (!installedNames.has(name)) superPanelRegistry.delete(name);
        }
        for (const name of pluginManager.dynamicFeatures.keys()) {
            if (!installedNames.has(name)) pluginManager.dynamicFeatures.delete(name);
        }
        for (const plugin of plugins) {
            const config = manifests.get(plugin.path);
            if (!config) continue;
            // 只替换清单生成的动作，保留运行中插件动态注册的动作。
            const actions = superPanelRegistry.get(plugin.name) || [];
            superPanelRegistry.set(plugin.name, actions.filter(action =>
                !(action.feature && action.id?.startsWith(`plugin-${plugin.name}-`))));
            autoRegisterPluginSuperPanelActions(plugin.name, config, plugin.path, false);
        }
        invalidateSearchCatalog(reason);
        notifySuperPanelUpdate();
        sendRendererEvent('plugins:changed', { plugins, reason });
        return { success: true, count: plugins.length, plugins };
    });
    pluginCatalogRefresh = refresh;
    try {
        return await refresh;
    } finally {
        if (pluginCatalogRefresh === refresh) pluginCatalogRefresh = null;
    }
}

ipcMain.handle('refresh-plugins', async () => {
    try {
        return await refreshPluginCatalog();
    } catch (error) {
        console.error('刷新插件失败:', error);
        return { success: false, error: error.message };
    }
});

let localPluginImportBusy = false;

ipcMain.handle('import-local-plugins', async () => {
    if (localPluginImportBusy) return { success: false, error: '正在加载本地插件，请稍候' };
    localPluginImportBusy = true;
    try {
        if (!pluginManager) throw new Error('插件管理器未初始化');
        const selection = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'multiSelections'],
            title: '选择包含 plugin.json 的插件文件夹'
        });
        if (selection.canceled || !selection.filePaths.length) return { canceled: true };

        const installDir = getPluginInstallDir();
        const installed = [];
        const skipped = [];
        const errors = [];
        for (const sourceDir of selection.filePaths) {
            let stagingDir;
            try {
                const config = JSON.parse(await fs.promises.readFile(path.join(sourceDir, 'plugin.json'), 'utf8'));
                if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('plugin.json 必须是有效的插件配置对象');
                if (config.pluginName && typeof config.pluginName !== 'string') throw new Error('插件名称必须是文本');
                const name = config.pluginName || path.basename(sourceDir);
                const existingPath = findInstalledPluginPath(installDir, name);
                if (existingPath) {
                    skipped.push({ name, path: existingPath });
                    continue;
                }
                const folderName = path.basename(sourceDir);
                if (!folderName) throw new Error('请选择插件文件夹，不能选择磁盘根目录');
                const targetDir = uniquePath(path.join(installDir, folderName));
                const stagingRoot = path.join(installDir, '.downloads');
                await fs.promises.mkdir(stagingRoot, { recursive: true });
                stagingDir = await fs.promises.mkdtemp(path.join(stagingRoot, 'local-import-'));
                const stagedPlugin = path.join(stagingDir, 'plugin');
                // 复制完成后才放入扫描目录，避免刷新时读到半个插件。
                await fs.promises.cp(sourceDir, stagedPlugin, { recursive: true, errorOnExist: true, force: false });
                await fs.promises.rename(stagedPlugin, targetDir);
                installed.push({ name, path: targetDir });
            } catch (error) {
                errors.push({ path: sourceDir, error: error.message });
            } finally {
                if (stagingDir) await fs.promises.rm(stagingDir, { recursive: true, force: true });
            }
        }
        const refreshed = await refreshPluginCatalog('local-import');
        return { ...refreshed, success: installed.length > 0 || skipped.length > 0, installed, skipped, errors };
    } catch (error) {
        console.error('加载本地插件失败:', error);
        return { success: false, error: error.message };
    } finally {
        localPluginImportBusy = false;
    }
});

/**
 * 采集当前选区并恢复用户原剪贴板。
 * 先写入唯一标记可以区分“没有选区”和“选中的文本恰好与旧剪贴板相同”。
 */
async function captureSelectedTextForPanel() {
    const { clipboard } = require('electron');
    const snapshot = {
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        rtf: clipboard.readRTF(),
        bookmark: clipboard.readBookmark(),
        image: clipboard.readImage()
    };
        const marker = `__SANRENJZ_SELECTION_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
        let capturedImage = null;
        try {
            clipboard.writeText(marker);
            await copySelectedTextToClipboard();
            await new Promise(resolve => setTimeout(resolve, 80));
            const copiedText = clipboard.readText();
            const copiedImage = clipboard.readImage();
            const hasSelectedImage = copiedText === marker && copiedImage && !copiedImage.isEmpty();
            if (hasSelectedImage) capturedImage = copiedImage;
            return {
                text: copiedText === marker ? '' : copiedText,
                hasImage: Boolean(hasSelectedImage),
                source: 'selection'
            };
        } finally {
            try {
                // 选中图片时保留刚捕获的图片供插件读取；其余情况恢复用户原剪贴板
                if (capturedImage && !capturedImage.isEmpty()) clipboard.writeImage(capturedImage);
                else clipboard.write(snapshot);
            } catch (error) { console.warn('恢复剪贴板失败:', error.message); }
        }
}

function toFileUrl(filePath) {
    return `file:///${String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

async function resolvePluginLogoUrl(pluginPath) {
    for (const fileName of ['logo.ico', 'logo.png']) {
        const candidate = path.join(pluginPath, fileName);
        try {
            await fs.promises.access(candidate, fs.constants.R_OK);
            return toFileUrl(candidate);
        } catch (_) { }
    }
    return '';
}

async function buildSearchCatalog() {
    const plugins = pluginManager ? await pluginManager.getPluginList() : [];
    const currentSettings = loadSettings();
    const contentGroups = await Promise.all(plugins.map(plugin => getPluginContents(plugin.path)));
    const normalizedPlugins = await Promise.all(plugins.map(async plugin => {
        const customSettings = currentSettings.pluginSearchSettings?.[plugin.name];
        const customKeywords = customSettings?.enabled && Array.isArray(customSettings.keywords) ? customSettings.keywords : [];
        return {
            ...plugin,
            logoUrl: await resolvePluginLogoUrl(plugin.path),
            searchText: [plugin.name, plugin.description, ...customKeywords].filter(Boolean).join('\n').toLowerCase()
        };
    }));
    const contents = [];
    contentGroups.forEach((group, pluginIndex) => {
        const plugin = plugins[pluginIndex];
        for (const content of group) {
            contents.push({
                ...content,
                pluginName: plugin.name,
                pluginPath: plugin.path,
                logoUrl: normalizedPlugins[pluginIndex].logoUrl,
                contentType: content.type || 'unknown',
                type: 'content',
                searchTitle: String(content.title || '').toLowerCase(),
                searchBody: `${content.content || ''}\n${content.preview || ''}`.toLowerCase()
            });
        }
    });
    return { version: searchCatalogCache.version, plugins: [...normalizedPlugins.map(p => ({ ...p, engine: 'tools', id: `tools:${path.basename(p.path)}` })), ...(mergedHost ? await mergedHost.searchEntries() : [])], contents };
}

ipcMain.handle('search-catalog-get', async (event, options = {}) => {
    if (!searchCatalogCache.dirty && searchCatalogCache.data && !options.force) return searchCatalogCache.data;
    if (searchCatalogCache.loading) return searchCatalogCache.loading;
    searchCatalogCache.loading = (async () => {
        // 构建期间若又有插件变更，重新构建，不能把旧目录标记成最新缓存。
        while (true) {
            const version = searchCatalogCache.version;
            const data = await buildSearchCatalog();
            if (version !== searchCatalogCache.version) continue;
            data.version = version;
            searchCatalogCache.data = data;
            searchCatalogCache.dirty = false;
            return data;
        }
    })()
        .finally(() => { searchCatalogCache.loading = null; });
    return searchCatalogCache.loading;
});

// 注册插件动态功能
ipcMain.handle('register-plugin-features', async (event, pluginName, features) => {
    /**
     * 函数级注释：
     * - 接收渲染进程注册的插件特性并进行可序列化清洗，避免“An object could not be cloned”
     * - 仅保留 `code`/`explain`/`cmds` 字段，且 `cmds` 内仅允许字符串或基本对象
     */
    try {
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
                        // 将正则或复杂匹配对象转换为可序列化形式
                        if (c.match instanceof RegExp) {
                            out.match = { pattern: c.match.source, flags: c.match.flags };
                        } else if (typeof c.match === 'string') {
                            out.match = c.match;
                        } else if (typeof c.match === 'object') {
                            // 仅保留可序列化的基本键值
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

        const safeFeatures = Array.isArray(features) ? features.map(f => ({
            code: String(f?.code || ''),
            explain: String(f?.explain || ''),
            cmds: Array.isArray(f?.cmds) ? f.cmds.map(sanitizeCmd) : []
        })) : [];

        if (pluginManager) {
            const result = pluginManager.registerDynamicFeatures(pluginName, safeFeatures);
            invalidateSearchCatalog(`dynamic-features:${pluginName}`);
            return result;
        }
        return false;
    } catch (error) {
        console.error('注册插件动态功能失败:', error);
        return false;
    }
});

// 运行插件
ipcMain.handle('run-plugin', async (event, pluginPath, features) => {
    try {
        if (mergedHost) {
            const python = (await mergedHost.python.list({ includeHidden: true })).find(p => p.id === pluginPath || p.path === pluginPath);
            if (python) return await mergedHost.run(python.id);
        }
        if (pluginManager && mainWindow && !mainWindow.isDestroyed()) {
            const result = await pluginManager.runPlugin(pluginPath, features);
            if (result?.success === false) return result;

            // 插件运行后，自动注册其超级面板功能
            try {
                const pluginConfigPath = path.join(pluginPath, 'plugin.json');
                if (fs.existsSync(pluginConfigPath)) {
                    const pluginConfig = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf8'));
                    if (pluginConfig && pluginConfig.pluginName) {
                        autoRegisterPluginSuperPanelActions(pluginConfig.pluginName, pluginConfig, pluginPath);
                    }
                }
            } catch (regError) {
                console.error('自动注册插件超级面板功能失败:', regError);
            }
            return { success: true };
        } else {
            return { success: false, error: '插件管理器或主窗口不可用' };
        }
    } catch (error) {
        console.error('运行插件失败:', error);
        return { success: false, error: error.message, code: error.code || '' };
    }
});

// 停止插件
ipcMain.handle('stop-plugin', async (event, pluginName) => {
    try {
        if (pluginManager) {
            pluginManager.stopPlugin(pluginName);
        }
    } catch (error) {
        console.error('停止插件失败:', error);
    }
});

// 卸载插件
ipcMain.handle('uninstall-plugin', async (event, pluginName) => {
    try {
        if (pluginManager) {
            const result = await pluginManager.uninstallPlugin(pluginName);
            // 如果卸载成功，同时也清除超级面板中的相关功能
            if (result.success) {
                await refreshPluginCatalog('uninstall');
                invalidateSearchCatalog(`plugin-uninstalled:${pluginName}`);
                if (superPanelRegistry.has(pluginName)) {
                    superPanelRegistry.delete(pluginName);
                    notifySuperPanelUpdate();
                }
            }
            return result;
        }
        return { success: false, error: '插件管理器未初始化' };
    } catch (error) {
        console.error('卸载插件失败:', error);
        return { success: false, error: error.message };
    }
});

// 添加插件到超级面板
ipcMain.handle('add-plugin-to-super-panel', async (event, pluginName) => {
    try {
        if (!pluginManager) {
            return { success: false, error: '插件管理器未初始化' };
        }

        const plugins = await pluginManager.getPluginList();
        const plugin = plugins.find(p => p.name === pluginName);

        if (!plugin) {
            return { success: false, error: `找不到插件: ${pluginName}` };
        }

        // 读取插件配置
        const pluginConfigPath = path.join(plugin.path, 'plugin.json');
        if (!fs.existsSync(pluginConfigPath)) {
            return { success: false, error: '插件配置文件不存在' };
        }

        const pluginConfig = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf8'));
        
        // 注册超级面板功能
        autoRegisterPluginSuperPanelActions(pluginName, pluginConfig, plugin.path);
        
        return { success: true, message: `已将 ${pluginName} 添加到超级面板` };
    } catch (error) {
        console.error('添加插件到超级面板失败:', error);
        return { success: false, error: error.message };
    }
});

// 重新加载插件（用于开发调试）
ipcMain.handle('reload-plugin', async (event, pluginPath) => {
    try {
        if (pluginManager) {
            const result = await pluginManager.reloadPlugin(pluginPath);
            invalidateSearchCatalog(`plugin-reloaded:${pluginPath}`);
            return result;
        }
        return null;
    } catch (error) {
        console.error('重新加载插件失败:', error);
        throw error;
    }
});

// 关闭插件窗口
ipcMain.handle('close-plugin-window', (event, pluginName) => {
    try {
        if (pluginManager) {
            pluginManager.stopPlugin(pluginName);
        }
    } catch (error) {
        console.error('关闭插件窗口失败:', error);
    }
});

// 获取插件内容（如文本片段）
async function getPluginContents(pluginPath) {
    try {
        const pluginJsonPath = path.join(pluginPath, 'plugin.json');

        if (!fs.existsSync(pluginJsonPath)) {
            console.log('插件配置文件不存在:', pluginJsonPath);
            return [];
        }

        const pluginConfig = JSON.parse(await fs.promises.readFile(pluginJsonPath, 'utf8'));
        const allContents = [];

        console.log(`正在处理插件: ${pluginConfig.pluginName}`);

        // 1. 添加插件的 cmds 作为可搜索内容（支持对象型命令并去重）
        /**
         * 收集命令的文本标签
         * - 字符串命令：直接作为标签
         * - 对象命令：优先使用 `label` 字段；若为数组则展开所有标签
         * - 过滤空值并去重
         * @param {string|object} cmd
         * @returns {string[]}
         */
        function collectCommandLabels(cmd) {
            const labels = [];
            if (typeof cmd === 'string') {
                labels.push(cmd.trim());
            } else if (cmd && typeof cmd === 'object') {
                const raw = cmd.label;
                if (Array.isArray(raw)) {
                    raw.forEach(v => {
                        if (typeof v === 'string' && v.trim()) labels.push(v.trim());
                    });
                } else if (typeof raw === 'string' && raw.trim()) {
                    labels.push(raw.trim());
                }
            }
            return Array.from(new Set(labels));
        }

        if (pluginConfig.features && Array.isArray(pluginConfig.features)) {
            const seen = new Set(); // featureCode|label 去重
            pluginConfig.features.forEach(feature => {
                if (feature.cmds && Array.isArray(feature.cmds)) {
                    try {
                        const allLabels = feature.cmds.flatMap(collectCommandLabels);
                        if (allLabels.length > 0) {
                            console.log(`添加命令: ${allLabels.join(', ')}`);
                        }
                        allLabels.forEach(label => {
                            const key = `${String(feature.code || '')}|${label}`;
                            if (seen.has(key)) return;
                            seen.add(key);
                            allContents.push({
                                title: String(label),
                                content: String(feature.explain || '插件功能'),
                                preview: String(feature.explain || '插件功能') + ' - 点击回车打开插件',
                                type: 'command',
                                featureCode: String(feature.code || ''),
                                command: String(label)
                            });
                        });
                    } catch (e) {
                        console.error('处理 cmds 时出错:', e);
                    }
                }
            });
        }

        // 1.5 添加动态注册的功能 (如 AI 助手的快捷指令)
        if (pluginManager && pluginConfig.pluginName) {
            try {
                const dynamicFeatures = pluginManager.dynamicFeatures.get(pluginConfig.pluginName);
                if (dynamicFeatures && Array.isArray(dynamicFeatures)) {
                    console.log(`发现动态功能: ${pluginConfig.pluginName}, 数量: ${dynamicFeatures.length}`);
                    dynamicFeatures.forEach(feature => {
                        if (feature.cmds && Array.isArray(feature.cmds)) {
                            try {
                                const labels = feature.cmds.flatMap(collectCommandLabels);
                                if (labels.length > 0) {
                                    console.log(`添加动态命令: ${labels.join(', ')}`);
                                }
                                labels.forEach(label => {
                                    const exists = allContents.some(item =>
                                        item.type === 'command' &&
                                        item.title === String(label) &&
                                        item.featureCode === String(feature.code || '')
                                    );
                                    if (!exists) {
                                        allContents.push({
                                            title: String(label),
                                            content: String(feature.explain || '插件动态功能'),
                                            preview: String(feature.explain || '插件动态功能') + ' - 点击回车打开插件',
                                            type: 'command',
                                            featureCode: String(feature.code || ''),
                                            command: String(label)
                                        });
                                    }
                                });
                            } catch (e) {
                                console.error('处理动态 cmds 时出错:', e);
                            }
                        }
                    });
                }

                // 1.6 从持久化存储中加载动态功能 (通用配置实现，支持点路径)
                if (pluginConfig.storageFeatures && Array.isArray(pluginConfig.storageFeatures)) {
                    /**
                     * 解析存储点路径并返回目标数组
                     * 函数级注释：
                     * - 支持如 'ai-settings.quickCommands' 的路径表示，先读取顶层键，再按层级取子属性
                     * - 若任一层级不存在或类型不匹配，返回 null，调用方需做空值检查
                     */
                    function resolveStorageArrayByPath(pluginName, keyPath) {
                        try {
                            const parts = String(keyPath || '').split('.').filter(Boolean);
                            if (parts.length === 0) return null;
                            let current = pluginManager.getPluginStorageItem(pluginName, parts[0]);
                            for (let i = 1; i < parts.length; i++) {
                                if (!current || typeof current !== 'object') return null;
                                current = current[parts[i]];
                            }
                            return Array.isArray(current) ? current : null;
                        } catch (err) {
                            console.error('解析存储路径失败:', err);
                            return null;
                        }
                    }

                    pluginConfig.storageFeatures.forEach(config => {
                        try {
                            const items = resolveStorageArrayByPath(pluginConfig.pluginName, config.storageKey);
                            if (items && Array.isArray(items)) {
                                console.log(`从存储中发现动态功能: ${pluginConfig.pluginName} - ${config.storageKey}, 数量: ${items.length}`);

                                items.forEach((item, index) => {
                                    const titleKey = String(config.itemTitleKey || 'title');
                                    const label = item[titleKey] || `项目-${index + 1}`;

                                    // 生成唯一代码，与插件内部逻辑保持一致
                                    const slug = String(label).replace(/[^\w\u4e00-\u9fa5]+/g, '-').toLowerCase();
                                    const featureCode = `${String(config.codePrefix || '')}${slug}`;

                                    // 检查是否已存在
                                    const exists = allContents.some(c =>
                                        c.type === 'command' &&
                                        c.title === label &&
                                        c.featureCode === featureCode
                                    );

                                    if (!exists) {
                                        allContents.push({
                                            title: String(label),
                                            content: String(config.description || '插件动态功能'),
                                            preview: `${String(config.description || '插件动态功能')} - 点击回车执行`,
                                            type: 'command',
                                            featureCode: String(featureCode),
                                            command: String(label),
                                            isDynamic: true
                                        });
                                    }
                                });
                            }
                        } catch (e) {
                            console.error(`处理存储动态功能失败 ${pluginConfig.pluginName}:`, e);
                        }
                    });
                }
            } catch (dynError) {
                console.error('处理动态功能失败:', dynError);
            }
        }

        // 2. 根据插件类型加载具体的内容
        if (pluginConfig.pluginName === '余汉波文本片段助手') {
            console.log('开始加载余汉波文本片段助手的内容...');
            try {
                const textSnippets = await getTextSnippets(pluginPath);
                console.log(`文本片段助手返回了 ${textSnippets.length} 个片段`);

                // 为文本片段添加类型标识，确保所有字段都是可序列化的
                textSnippets.forEach(snippet => {
                    console.log(`添加文本片段: ${snippet.title}`);
                    allContents.push({
                        title: String(snippet.title || ''),
                        content: String(snippet.content || ''),
                        preview: String(snippet.preview || ''),
                        type: 'text-snippet',
                        path: String(snippet.path || '')
                    });
                });
            } catch (error) {
                console.error('加载文本片段失败:', error);
            }
        }

        console.log(`插件 ${pluginConfig.pluginName} 共加载 ${allContents.length} 个可搜索项`);

        return allContents;
    } catch (error) {
        console.error('获取插件内容失败:', error);
        return [];
    }
}

ipcMain.handle('get-plugin-contents', async (event, pluginPath) => getPluginContents(pluginPath));

// 插入内容（文本片段等）
ipcMain.handle('insert-content', async (event, content) => {
    try {
        console.log('准备复制内容:', content.title, '类型:', content.contentType || content.type);

        // 只处理文本片段类型的内容
        if (content.contentType !== 'text-snippet' && content.type !== 'text-snippet') {
            console.log('非文本片段类型，跳过复制操作');
            return { success: false, message: '不支持的内容类型' };
        }

        const { clipboard } = require('electron');

        clipboard.writeText(content.content || '');

        const directInsert = content && content.directInsert === true;

        if (!directInsert) {
            if (searchWindow && !searchWindow.isDestroyed() && searchWindow.isVisible()) {
                searchWindow.hide();
                lastSearchHotkeyTime = Date.now();
                console.log('搜索窗口已隐藏');
            }

            const { Notification } = require('electron');
            if (Notification.isSupported()) {
                new Notification({
                    title: '复制成功',
                    body: `"${content.title}" 已复制到剪贴板`,
                    silent: true
                }).show();
            }

            return { success: true, message: '文本片段已复制到剪贴板' };
        }

        if (searchWindow && !searchWindow.isDestroyed() && searchWindow.isVisible()) {
            searchWindow.close();
            lastSearchHotkeyTime = Date.now();
        }

        await new Promise(resolve => setTimeout(resolve, 120));
        restoreFocusToLastActiveWindow();
        await new Promise(resolve => setTimeout(resolve, 200));

        await new Promise((resolve, reject) => {
            const psScript = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')";
            const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
            const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-EncodedCommand', encoded], {
                windowsHide: true,
                stdio: ['ignore', 'ignore', 'pipe']
            });
            let stderr = '';
            proc.stderr.setEncoding('utf8');
            proc.stderr.on('data', (chunk) => {
                stderr += chunk;
            });
            proc.on('error', reject);
            proc.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error(stderr || `SendKeys exit code ${code}`));
            });
        });

        return { success: true, message: '文本片段已插入' };
    } catch (error) {
        console.error('复制内容失败:', error);
        return { success: false, error: error.message };
    }
});

// 带重试机制的粘贴函数


// 辅助函数：显示粘贴提示
function showPasteNotification(content) {
    setTimeout(() => {
        try {
            if (searchWindow && !searchWindow.isDestroyed()) {
                searchWindow.webContents.executeJavaScript(`
                    if (typeof showNotification === 'function') {
                        showNotification('${content.title.replace(/'/g, "\\'")} 已复制，请按 Ctrl+V 粘贴', 'info');
                    }
                `).catch(err => {
                    console.log('通知显示失败:', err.message);
                });
            }
        } catch (notifError) {
            console.log('通知系统错误:', notifError.message);
        }
    }, 50); // 减少通知延迟
}

// 获取设置
ipcMain.handle('get-settings', () => {
    return loadSettings();
});

ipcMain.handle('hotkey:begin-capture', (event, sessionId) => {
    if (event.sender !== mainWindow?.webContents || typeof sessionId !== 'string' || !/^(global|pin|super-panel)-hotkey-input:\d+$/.test(sessionId)) throw new Error('快捷键录入来源无效');
    return hotkeyController.beginCapture(sessionId);
});
ipcMain.handle('hotkey:end-capture', event => {
    if (event.sender !== mainWindow?.webContents) throw new Error('快捷键录入来源无效');
    hotkeyController.endCapture(); return { success: true };
});
ipcMain.on('hotkey:cancel-capture', event => {
    if (event.sender === mainWindow?.webContents) hotkeyController?.endCapture();
});

// 保存设置
ipcMain.handle('save-settings', (event, settings) => {
    try {
        const currentSettings = loadSettings({ strict: true });
        const requested = { ...currentSettings, ...settings };
        for (const key of ['globalHotkey', 'pinHotkey', 'superPanelHotkey']) {
            if (typeof requested[key] !== 'string') throw new Error('快捷键格式无效');
            requested[key] = requested[key].trim();
        }
        if (!requested.globalHotkey || !requested.pinHotkey) throw new Error('全局快捷键和钉住快捷键不能为空');
        const activeKeys = [requested.globalHotkey, requested.pinHotkey, requested.superPanelHotkey].filter(Boolean).map(key => key.toLowerCase());
        if (new Set(activeKeys).size !== activeKeys.length) throw new Error('全局、钉住和超级面板快捷键不能相同');
        if (Object.prototype.hasOwnProperty.call(settings, 'autoStart') && typeof settings.autoStart !== 'boolean') throw new Error('开机自启动选项必须为布尔值');
        const hotkeysChanged = Object.entries({ globalHotkey: 'global', pinHotkey: 'pin', superPanelHotkey: 'panel' }).some(([key, role]) => {
            if (!Object.prototype.hasOwnProperty.call(settings, key)) return false;
            const binding = hotkeyController?.bindings.get(role);
            // 未变且仍生效的组合键不重注册；已失效的绑定允许用户按原值重试保存。
            return requested[key] !== String(currentSettings[key] || '').trim()
                || Boolean(requested[key] && (!binding || !globalShortcut.isRegistered(binding.accelerator)))
                || Boolean(!requested[key] && binding);
        });
        const autoStartChanged = Object.prototype.hasOwnProperty.call(settings, 'autoStart') && requested.autoStart !== currentSettings.autoStart;
        const persist = () => {
            let previousLogin;
            let loginAttempted = false;
            try {
                if (autoStartChanged && !mergedAcceptance) {
                    previousLogin = { openAtLogin: app.getLoginItemSettings({ path: process.execPath }).openAtLogin, path: process.execPath };
                    loginAttempted = true;
                    app.setLoginItemSettings({ openAtLogin: requested.autoStart, path: process.execPath });
                }
                return saveSettings(requested);
            } catch (error) {
                // 系统自启动与设置落盘同成同败，不能先落盘后再把系统错误报告为保存失败。
                if (loginAttempted) {
                    try { app.setLoginItemSettings(previousLogin); }
                    catch (restoreError) { throw new Error(`${error.message}；系统自启动恢复失败：${restoreError.message}`); }
                }
                throw error;
            }
        };
        const savedSettings = hotkeysChanged && !mergedAcceptance ? hotkeyController.transaction(() => {
            for (const [register, key] of [[registerGlobalShortcut, requested.globalHotkey], [registerPinShortcut, requested.pinHotkey], [registerSuperPanelShortcut, requested.superPanelHotkey]]) {
                if (!register(key)) throw new Error(`快捷键 ${key || '(空)'} 注册失败，可能已被其他程序占用；原设置保持不变。`);
            }
            return persist();
        }) : persist();
        if (mergedAcceptance) return savedSettings;
        settings = savedSettings;

        // 如果右键设置发生变化，重新启动监听器
        if (process.platform === 'win32' &&
            (settings.enableRightClickPanel !== currentSettings.enableRightClickPanel ||
                settings.rightClickDelay !== currentSettings.rightClickDelay)) {
            console.log('右键设置已更改，重新启动监听器');
            stopMouseMonitor();
            if (settings.enableRightClickPanel) {
                setTimeout(() => {
                    startMouseMonitor();
                }, 1000);
            }
        }

        return savedSettings;
    } catch (error) {
        console.error('保存设置失败:', error);
        throw error;
    }
});

ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('account:login', async () => {
    if (accountLoggingOut) throw new Error('正在退出登录，请稍后再登录');
    accountSessionSuppressed = false;
    accountSnapshotGeneration++;
    openBuiltinBrowserWindow(SHOP_MEMBER_CENTER_URL);
    return { success: true, loginMode: 'browser', url: SHOP_MEMBER_CENTER_URL };
});

ipcMain.handle('account:logout', async () => {
    if (accountLoggingOut) return toSerializable(cachedAccount);
    // 先关闭认证通路，再异步删除 Cookie，避免清理事件或旧窗口把账号重新登录。
    accountLoggingOut = true;
    accountSessionSuppressed = true;
    accountSnapshotGeneration++;
    clearTimeout(accountRefreshTimer);
    cachedAccount = { authenticated: false, canDownloadUpdates: false, user: null, access: {}, reason: 'logout' };
    sendRendererEvent('account:changed', cachedAccount);
    let cleanupFailed = false;
    try {
        try { clearAccountToken(); } catch (_) { cleanupFailed = true; }
        try { await clearShopSession(); } catch (_) { cleanupFailed = true; }
    } finally {
        accountSnapshotGeneration++;
        clearTimeout(accountRefreshTimer);
        accountRefreshTimer = null;
        accountLoggingOut = false;
    }
    cachedAccount = { ...cachedAccount, cleanupFailed,
        ...(cleanupFailed ? { error: '已退出本地账号，但商店会话未完全清理，请重试退出。' } : {}) };
    sendRendererEvent('account:changed', cachedAccount);
    return toSerializable(cachedAccount);
});

ipcMain.handle('account:me', async () => {
    return toSerializable(await refreshAccountState());
});

ipcMain.handle('account:access', async () => {
    return toSerializable(await fetchToolsAccess());
});

ipcMain.handle('shop:open-member-center', async () => {
    openBuiltinBrowserWindow(SHOP_MEMBER_CENTER_URL);
    return { success: true };
});

ipcMain.handle('shop:open-python-store', async () => { openBuiltinBrowserWindow(`${SHOP_BASE_URL}/python`, 'Python 插件商店'); return { success: true }; });

ipcMain.handle('shop:open-tools-store', async () => {
    openBuiltinBrowserWindow(SHOP_TOOLS_STORE_URL);
    return { success: true };
});

ipcMain.handle('open-plugin-install-directory', async () => {
    const pluginDir = getPluginInstallDir();
    fs.mkdirSync(pluginDir, { recursive: true });
    const error = await shell.openPath(pluginDir);
    if (error) throw new Error(error);
    return { success: true, path: pluginDir };
});

ipcMain.handle('update:check', (event) => runUpdateAction(event, updater => updater.check()));
ipcMain.handle('update:download', (event) => runUpdateAction(event, updater => updater.download()));
ipcMain.handle('update:cancel', (event) => runUpdateAction(event, updater => {
    updater.cancel();
    return { success: true };
}));
ipcMain.handle('update:open-release', (event) => runUpdateAction(event, async () => {
    await shell.openExternal(GITHUB_RELEASES_URL);
    return { success: true };
}));
ipcMain.handle('update:install', (event) => runUpdateAction(event, async updater => {
    const downloaded = await updater.verifyDownloaded();
    if (downloaded.installAction === 'show-folder') {
        shell.showItemInFolder(downloaded.path);
        return { success: true, message: '已定位下载文件，请退出当前程序后按需替换 AppImage' };
    }
    const error = await shell.openPath(downloaded.path);
    if (error) throw new Error(`无法打开安装包：${error}`);
    if (downloaded.installAction === 'install') {
        // 安装程序成功交给系统后才退出，避免启动失败时丢失工作窗口。
        app.isQuiting = true;
        app.quit();
        return { success: true, message: '已启动安装程序，请按提示完成安装' };
    }
    return { success: true, message: '已打开 DMG，请退出当前程序后拖入“应用程序”完成更新' };
}));

// 隐藏搜索窗口
ipcMain.handle('hide-search-window', async (event, options = {}) => {
    if (searchWindow && !searchWindow.isDestroyed()) {
        const wasVisible = searchWindow.isVisible();
        searchWindow.hide();
        // 隐藏后开启一段时间的热键冷却，防止快速重复打开
        lastSearchHotkeyTime = Date.now();

        // 只有在需要恢复焦点且此前窗口为可见状态时才执行焦点恢复逻辑
        if (options.restoreFocus !== false && wasVisible) {
            try {
                console.log('搜索窗口被隐藏，开始恢复焦点');

                // Using a slightly longer delay here as well
                setTimeout(async () => {
                    try {
                        // 隐藏搜索窗口后恢复之前的活动窗口焦点
                        restoreFocusToLastActiveWindow();
                    } catch (error) {
                        console.error('隐藏后焦点恢复失败:', error.message, error.stack);
                    }
                }, 80); // Consistent delay

            } catch (error) {
                console.error('搜索窗口隐藏后处理失败:', error);
            }
        } else {
            console.log('搜索窗口被隐藏，跳过焦点恢复');
        }
    }
});

// 切换钉住状态
ipcMain.handle('toggle-pin', () => {
    return togglePin();
});

// 获取钉住状态
ipcMain.handle('get-pin-status', () => {
    return isPinned;
});

// 查询打开搜索窗口前是否处于文本输入环境（供渲染进程判断是否自动粘贴）
ipcMain.handle('was-text-input-active', () => {
    try {
        // 若检测到焦点控件句柄存在，也将其视为可能的文本输入环境（提高兼容性）
        const hasFocusHandle = lastActiveWindow && lastActiveWindow.focusHandle && lastActiveWindow.focusHandle !== '0';
        return wasTextInputBeforeSearch === true || Boolean(hasFocusHandle);
    } catch (e) {
        return false;
    }
});

// 显示文件选择对话框（同步）
ipcMain.on('show-open-dialog', (event, options) => {
    try {
        console.log('主进程收到文件选择请求:', options);

        const result = dialog.showOpenDialogSync(mainWindow, options);
        console.log('文件选择结果:', result);

        event.returnValue = result || null;
    } catch (error) {
        console.error('主进程文件选择错误:', error);
        event.returnValue = null;
    }
});

// 显示保存文件对话框（同步）
ipcMain.on('show-save-dialog', (event, options) => {
    try {
        console.log('主进程收到保存文件选择请求:', options);

        const result = dialog.showSaveDialogSync(mainWindow, options);
        console.log('保存文件选择结果:', result);

        event.returnValue = result || null;
    } catch (error) {
        console.error('主进程保存文件选择错误:', error);
        event.returnValue = null;
    }
});

// 添加 IPC 处理：切换插件窗口钉住状态
ipcMain.handle('toggle-plugin-pin-window', (event, pluginName) => {
    if (pluginManager) {
        return pluginManager.togglePluginPin(pluginName);
    }
    return false;
});

// 添加 IPC 处理：获取插件窗口钉住状态
ipcMain.handle('get-plugin-pin-status-window', (event, pluginName) => {
    if (pluginManager) {
        return pluginManager.getPluginPinStatus(pluginName);
    }
    return false;
});

// 添加 IPC 处理：最小化插件窗口
ipcMain.handle('minimize-plugin-window', (event, pluginName, options = {}) => {
    if (pluginManager) {
        return pluginManager.minimizePlugin(pluginName, options);
    }
    return false;
});
ipcMain.handle('create-plugin-indicator-window', (event, pluginName) => {
    if (pluginManager) {
        return pluginManager.createOrShowPluginIndicatorWindow(pluginName);
    }
    return false;
});
ipcMain.handle('close-plugin-indicator-window', (event, pluginName) => {
    if (pluginManager) {
        return pluginManager.closePluginIndicatorWindow(pluginName);
    }
    return false;
});

// 添加 IPC 处理：最大化/还原插件窗口
ipcMain.handle('maximize-plugin-window', (event, pluginName) => {
    if (pluginManager) {
        return pluginManager.maximizePlugin(pluginName);
    }
    return false;
});

// 添加 IPC 处理：恢复焦点到原窗口
/**
 * 恢复到显示搜索窗口之前的活动窗口焦点
 * 在插件层调用 closePlugin() 时会触发该接口
 */
ipcMain.handle('restore-previous-focus', async (event) => {
    console.log('收到恢复焦点请求');
    try {
        // 适度延迟，确保搜索窗口已隐藏
        await new Promise(resolve => setTimeout(resolve, 120));
        restoreFocusToLastActiveWindow();
        // 再等待一些时间让焦点稳定
        await new Promise(resolve => setTimeout(resolve, 100));
        return { success: true };
    } catch (error) {
        console.error('恢复焦点失败:', error);
        return { success: false, error: error.message };
    }
});



// 添加 IPC 处理：测试右键功能
ipcMain.handle('test-right-click-function', () => {
    try {
        console.log('🧪 手动测试右键功能');
        showSuperPanel();
        return { success: true, message: '超级面板已显示' };
    } catch (error) {
        console.error('测试右键功能失败:', error);
        return { success: false, error: error.message };
    }
});

// 添加 IPC 处理：获取剪贴板文本
function finishRegionCapture(result) {
    if (!activeRegionCapture) return;
    const session = activeRegionCapture;
    activeRegionCapture = null;
    for (const overlay of session.overlays) {
        try { if (!overlay.isDestroyed()) overlay.destroy(); } catch (_) { }
    }
    try {
        if (session.restoreOwner && session.owner && !session.owner.isDestroyed()) {
            session.owner.show();
            session.owner.focus();
        }
    } catch (_) { }
    session.resolve(result);
}

ipcMain.on('screenshot-region-cancel', () => finishRegionCapture({ cancelled: true }));

ipcMain.on('screenshot-region-selected', (event, payload) => {
    if (!activeRegionCapture || !payload?.rect) return;
    const sourceInfo = activeRegionCapture.sources.get(String(payload.displayId));
    if (!sourceInfo) return finishRegionCapture({ cancelled: true, error: '找不到截图对应的显示器' });
    const { thumbnail, display } = sourceInfo;
    const imageSize = thumbnail.getSize();
    // 框选坐标来自叠加层的 CSS 视口。Windows 缩放、多显示器 DPI 或无边框窗口
    // 均可能让该视口与 display.bounds 不完全一致；必须以发送方实测的视口尺寸换算，
    // 否则会出现“框选 A 区域，却截取到 B 区域”的问题。
    const viewportWidth = Number(payload.viewport?.width);
    const viewportHeight = Number(payload.viewport?.height);
    const coordinateWidth = Number.isFinite(viewportWidth) && viewportWidth > 0
        ? viewportWidth
        : display.bounds.width;
    const coordinateHeight = Number.isFinite(viewportHeight) && viewportHeight > 0
        ? viewportHeight
        : display.bounds.height;
    const scaleX = imageSize.width / coordinateWidth;
    const scaleY = imageSize.height / coordinateHeight;
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
        return finishRegionCapture({ cancelled: true, error: '截图坐标换算失败，请重新截图' });
    }
    const cropRect = {
        x: Math.max(0, Math.round(payload.rect.x * scaleX)),
        y: Math.max(0, Math.round(payload.rect.y * scaleY)),
        width: Math.max(1, Math.min(imageSize.width, Math.round(payload.rect.width * scaleX))),
        height: Math.max(1, Math.min(imageSize.height, Math.round(payload.rect.height * scaleY)))
    };
    if (cropRect.x + cropRect.width > imageSize.width) cropRect.width = imageSize.width - cropRect.x;
    if (cropRect.y + cropRect.height > imageSize.height) cropRect.height = imageSize.height - cropRect.y;
    const cropped = thumbnail.crop(cropRect);
    const croppedSize = cropped.getSize();
    if (cropped.isEmpty() || croppedSize.width < 1 || croppedSize.height < 1) {
        return finishRegionCapture({ cancelled: true, error: '截图区域为空，请重新框选' });
    }
    finishRegionCapture({
        cancelled: false,
        dataUrl: cropped.toDataURL(),
        width: croppedSize.width,
        height: croppedSize.height
    });
});

ipcMain.handle('capture-screen-region', async (event, options = {}) => {
    if (activeRegionCapture) finishRegionCapture({ cancelled: true, error: '已开始新的截图会话' });
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner && !owner.isDestroyed()) owner.hide();
    await new Promise(resolve => setTimeout(resolve, 120));

    const { screen } = require('electron');
    const displays = screen.getAllDisplays();
    let capturedSourceGroups;
    try {
        // desktopCapturer 的 thumbnailSize 会应用到本次返回的所有屏幕。若把普通屏与带鱼屏
        // 共用一组最大宽高，极端宽高比画面可能被拉伸或降采样。按每块屏幕的物理像素尺寸
        // 分别请求源图，确保 21:9、32:9 与混合 DPI 环境下仍保留原始比例和文字清晰度。
        capturedSourceGroups = await Promise.all(displays.map(display => desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: {
                width: Math.max(1, Math.ceil(display.bounds.width * display.scaleFactor)),
                height: Math.max(1, Math.ceil(display.bounds.height * display.scaleFactor))
            }
        })));
    } catch (error) {
        if (options.restoreOwner !== false && owner && !owner.isDestroyed()) {
            owner.show();
            owner.focus();
        }
        return { cancelled: true, error: `读取屏幕失败：${error.message}` };
    }
    const sources = new Map();
    for (const [displayIndex, display] of displays.entries()) {
        const capturedSources = capturedSourceGroups[displayIndex] || [];
        const source = capturedSources.find(item => String(item.display_id) === String(display.id)) || capturedSources[displayIndex];
        if (source) sources.set(String(display.id), { thumbnail: source.thumbnail, display });
    }
    if (sources.size === 0) {
        if (options.restoreOwner !== false && owner && !owner.isDestroyed()) owner.show();
        return { cancelled: true, error: '未能读取屏幕画面' };
    }

    return await new Promise(resolve => {
        const overlays = [];
        activeRegionCapture = { owner, overlays, sources, resolve, restoreOwner: options.restoreOwner !== false };
        for (const display of displays) {
            const sourceInfo = sources.get(String(display.id));
            if (!sourceInfo) continue;
            const overlay = new BrowserWindow({
                ...display.bounds,
                frame: false,
                transparent: false,
                resizable: false,
                movable: false,
                alwaysOnTop: true,
                skipTaskbar: true,
                fullscreenable: false,
                webPreferences: { nodeIntegration: true, contextIsolation: false }
            });
            overlays.push(overlay);
            overlay.setAlwaysOnTop(true, 'screen-saver');
            overlay.loadFile(path.join(app.getAppPath(), 'screenshot-overlay.html'));
            overlay.webContents.once('did-finish-load', () => {
                if (!overlay.isDestroyed()) overlay.webContents.send('screenshot-overlay-init', {
                    displayId: String(display.id),
                    dataUrl: sourceInfo.thumbnail.toDataURL()
                });
            });
            overlay.on('closed', () => {
                if (activeRegionCapture && activeRegionCapture.overlays.every(win => win.isDestroyed())) {
                    finishRegionCapture({ cancelled: true });
                }
            });
        }
        const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const focusOverlay = overlays[displays.findIndex(display => display.id === cursorDisplay.id)] || overlays[0];
        if (focusOverlay) focusOverlay.focus();
    });
});

/**
 * 将插件窗口切换为截图完成后的底部轻量确认条，或恢复原完整窗口。
 * 仅暴露窗口形态切换，不向插件页面开放 BrowserWindow 对象。
 */
ipcMain.handle('set-plugin-window-prompt-mode', (event, enabledValue) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const enabled = enabledValue === true;
    if (!window || window.isDestroyed()) return false;
    const { screen } = require('electron');
    if (enabled) {
        if (!pluginPromptWindowStates.has(window.id)) {
            pluginPromptWindowStates.set(window.id, {
                bounds: window.getBounds(),
                resizable: window.isResizable(),
                alwaysOnTop: window.isAlwaysOnTop()
            });
            window.once('closed', () => pluginPromptWindowStates.delete(window.id));
        }
        const currentBounds = window.getBounds();
        const center = { x: currentBounds.x + Math.round(currentBounds.width / 2), y: currentBounds.y + Math.round(currentBounds.height / 2) };
        const display = screen.getDisplayNearestPoint(center);
        const width = Math.min(560, display.workArea.width - 24);
        const height = 112;
        const x = display.workArea.x + Math.round((display.workArea.width - width) / 2);
        const y = display.workArea.y + display.workArea.height - height - 24;
        window.setResizable(false);
        window.setAlwaysOnTop(true, 'floating');
        window.setBounds({ x, y, width, height });
        window.show();
        window.focus();
        return true;
    }

    const previous = pluginPromptWindowStates.get(window.id);
    if (previous) {
        window.setAlwaysOnTop(previous.alwaysOnTop);
        window.setResizable(previous.resizable);
        window.setBounds(previous.bounds);
        pluginPromptWindowStates.delete(window.id);
    }
    window.show();
    window.focus();
    return true;
});

ipcMain.handle('get-clipboard-text', () => {
    try {
        const { clipboard } = require('electron');
        return clipboard.readText();
    } catch (error) {
        console.error('获取剪贴板文本失败:', error);
        return '';
    }
});

// 已移除重复的 get-super-panel-actions 处理器

// 计算功能与剪贴板文本的匹配度
function calculateMatchScore(clipboardText, feature) {
    if (!clipboardText || !feature) return 0;

    let score = 0;
    const text = clipboardText.toLowerCase();

    // 检查命令关键词匹配
    if (feature.cmds) {
        feature.cmds.forEach(cmd => {
            if (typeof cmd === 'string') {
                if (text.includes(cmd.toLowerCase())) score += 10;
                return;
            }
            if (cmd && typeof cmd === 'object') {
                if (cmd.type === 'over') {
                    const min = typeof cmd.minLength === 'number' ? cmd.minLength : 0;
                    const max = typeof cmd.maxLength === 'number' ? cmd.maxLength : Infinity;
                    if (clipboardText.length >= min && clipboardText.length <= max) score += 6;
                }
                const label = cmd.label;
                if (typeof label === 'string') {
                    if (text.includes(label.toLowerCase())) score += 6;
                } else if (Array.isArray(label)) {
                    label.forEach(l => {
                        if (typeof l === 'string' && text.includes(l.toLowerCase())) score += 4;
                    });
                }
            }
        });
    }

    // 检查功能说明匹配
    if (feature.explain) {
        const explain = feature.explain.toLowerCase();
        if (text.includes('图片') && explain.includes('图')) score += 8;
        if (text.includes('文本') && explain.includes('文本')) score += 8;
        if (text.includes('翻译') && explain.includes('翻译')) score += 8;
        if (text.includes('密码') && explain.includes('密码')) score += 8;
    }

    // 基础分数
    if (feature.superPanel) score += 5;
    if (feature.contextMenu) score += 3;

    return score;
}

function normalizeSuperPanelContext(input) {
    if (typeof input === 'string') return { text: input, hasImage: false, source: 'clipboard' };
    return {
        text: typeof input?.text === 'string' ? input.text : '',
        hasImage: input?.hasImage === true,
        source: typeof input?.source === 'string' ? input.source : 'clipboard'
    };
}

function detectSuperPanelContextTypes(context) {
    const text = context.text.trim();
    const types = new Set(detectTextContextTypes(text, context.hasImage));
    try {
        const cleanPath = normalizeClipboardPath(text);
        if (cleanPath && path.isAbsolute(cleanPath) && fs.existsSync(cleanPath)) {
            const stat = fs.statSync(cleanPath);
            types.add(stat.isDirectory() ? 'directory' : 'file');
            if (stat.isFile() && isImageFilePath(cleanPath)) types.add('image');
        }
    } catch (_) { }
    return Array.from(types);
}

function rankSuperPanelActions(actionList, context) {
    const detectedTypes = detectSuperPanelContextTypes(context);
    const typeSet = new Set(detectedTypes);
    const text = context.text.trim();
    const scoreKeywords = (action) => `${action.title || ''} ${action.description || ''} ${action.category || ''}`.toLowerCase();

    return actionList.map((action, originalIndex) => {
        const words = scoreKeywords(action);
        let score = Math.max(0, 40 - Number(action.priority || 10));
        const feature = action.feature || {};
        score += calculateMatchScore(text, feature);

        if (typeSet.has('image') && /(截图|图片|ocr|image)/i.test(words)) score += 70;
        if ((typeSet.has('file') || typeSet.has('directory')) && /(文件|目录|文件夹|终端|path|file)/i.test(words)) score += 60;
        if (typeSet.has('url') && /(链接|网页|浏览器|url)/i.test(words)) score += 65;
        if (typeSet.has('email') && /(邮件|邮箱|email)/i.test(words)) score += 65;
        if (typeSet.has('expression') && /(计算|算式|calculator)/i.test(words)) score += 65;
        if ((typeSet.has('code') || typeSet.has('json')) && /(代码|格式|json|ai|解释|处理)/i.test(words)) score += 45;
        if ((typeSet.has('chinese') || typeSet.has('english')) && /(翻译|translate)/i.test(words)) score += 55;
        if (typeSet.has('text') && /(文本|ai|搜索|复制|处理)/i.test(words)) score += 20;

        const featureCmds = Array.isArray(feature.cmds) ? feature.cmds : [];
        for (const cmd of featureCmds) {
            if (!cmd || typeof cmd !== 'object') continue;
            if (cmd.type === 'img' && typeSet.has('image')) score += 80;
            if (cmd.type === 'over' && text.length >= Number(cmd.minLength || 0) && text.length <= Number(cmd.maxLength || Infinity)) score += 35;
        }

        let group = '常用功能';
        if (typeSet.has('image') && /(截图|图片|ocr|image)/i.test(words)) group = '图片处理';
        else if (typeSet.has('url')) group = '链接处理';
        else if (typeSet.has('file') || typeSet.has('directory')) group = '文件处理';
        else if (typeSet.has('text')) group = '文本处理';
        return { ...action, contextTypes: detectedTypes, matchScore: score, group, __originalIndex: originalIndex };
    }).sort((a, b) => b.matchScore - a.matchScore || a.__originalIndex - b.__originalIndex)
        .map(({ __originalIndex, ...action }) => action);
}

// 通用插件图标获取函数 - 优先使用 logo.ico，否则使用 logo.png
function getPluginIconPath(pluginPath, returnDefault = true) {
    try {
        const logoIcoPath = path.join(pluginPath, 'logo.ico');
        const logoPngPath = path.join(pluginPath, 'logo.png');

        // 优先检查 logo.ico
        if (fs.existsSync(logoIcoPath)) {
            console.log(`插件图标找到 logo.ico: ${logoIcoPath}`);
            return logoIcoPath;
        }

        // 其次检查 logo.png
        if (fs.existsSync(logoPngPath)) {
            console.log(`插件图标找到 logo.png: ${logoPngPath}`);
            return logoPngPath;
        }

        // 如果都没有，返回默认图标或undefined
        if (returnDefault) {
            const appIconPath = app.isPackaged
                ? path.join(process.resourcesPath, 'build', 'icon.ico')
                : path.join(__dirname, 'build', 'icon.ico');

            if (fs.existsSync(appIconPath)) {
                console.log(`插件无自定义图标，使用主应用图标: ${appIconPath}`);
                return appIconPath;
            }
        }

        console.log('未找到插件图标文件');
        return undefined;
    } catch (error) {
        console.error('获取插件图标路径失败:', error);
        return undefined;
    }
}

function getPluginIcon(pluginName) {
    const iconMap = {
        '余汉波文本片段助手': '📝',
        '密码管理器': '🔐',
        '插件下载': '📦',
        '余汉波AI助手': '🤖'
    };

    return iconMap[pluginName] || '🔧';
}

// 添加 IPC 处理：运行插件操作
ipcMain.handle('run-plugin-action', async (event, { pluginPath, feature, clipboardText }) => {
    try {
        console.log('运行插件操作:', { pluginPath, feature: feature.code, clipboardText });

        if (pluginManager) {
            // 传递剪贴板文本到插件
            if (clipboardText && feature.useClipboardText !== false) {
                // 可以在这里将剪贴板文本传递给插件
                feature.clipboardText = clipboardText;
                feature.payload = clipboardText; // 为了兼容性，也可以设置payload
            }

            const result = await pluginManager.runPlugin(pluginPath, [feature]);
            return result?.success === false ? result : { success: true };
        } else {
            throw new Error('插件管理器未初始化');
        }

    } catch (error) {
        console.error('运行插件操作失败:', error);
        throw error;
    }
});

// 添加 IPC 处理：执行系统命令
ipcMain.handle('execute-system-command', async (event, { command, args, clipboardText }) => {
    try {
        console.log('执行系统命令:', { command, args, clipboardText });

        const { shell } = require('electron');

        switch (command) {
            case 'search-web':
                const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query || clipboardText)}`;
                await shell.openExternal(searchUrl);
                break;

            case 'open-url':
                await shell.openExternal(args.url || clipboardText);
                break;

            case 'send-email':
                const emailUrl = `mailto:${args.email || clipboardText}`;
                await shell.openExternal(emailUrl);
                break;

            case 'translate':
                const translateUrl = `https://translate.google.com/?sl=${args.from}&tl=${args.to}&text=${encodeURIComponent(args.text || clipboardText)}`;
                await shell.openExternal(translateUrl);
                break;

            case 'open-app':
                // 打开本地应用程序
                const appPath = args.app;
                if (appPath) {
                    const { spawn } = require('child_process');
                    try {
                        spawn(appPath, [], {
                            detached: true,
                            stdio: 'ignore'
                        }).unref();
                    } catch (error) {
                        console.error('打开应用失败:', error);
                        throw new Error(`无法打开应用: ${appPath}`);
                    }
                } else {
                    throw new Error('未指定应用路径');
                }
                break;

            default:
                throw new Error(`未知命令: ${command}`);
        }

        return { success: true };

    } catch (error) {
        console.error('执行系统命令失败:', error);
        throw error;
    }
});

// 添加 IPC 处理：关闭超级面板
ipcMain.handle('close-super-panel', () => {
    if (superPanelWindow && !superPanelWindow.isDestroyed()) {
        superPanelWindow.hide();

        // 恢复焦点到原窗口
        setTimeout(async () => {
            try {
                console.log('超级面板已关闭，无需焦点恢复');
            } catch (error) {
                console.error('关闭超级面板后焦点恢复失败:', error);
            }
        }, 100);
    }
});

ipcMain.handle('has-super-panel-child-window', () => {
    return hasActiveSuperPanelChildWindow();
});

ipcMain.handle('close-super-panel-child-window', (event, childType) => {
    try {
        if (childType === 'clock') {
            if (clockWindow && !clockWindow.isDestroyed()) {
                clockWindow.close();
            }
            return true;
        }
        if (childType === 'image') {
            if (imagePreviewWindow && !imagePreviewWindow.isDestroyed()) {
                imagePreviewWindow.close();
            }
            return true;
        }

        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
            win.close();
            return true;
        }
        return false;
    } catch (error) {
        console.error('关闭子窗口失败:', error);
        return false;
    }
});

ipcMain.handle('toggle-super-panel-child-window-pin', () => {
    try {
        if (!clockWindow || clockWindow.isDestroyed()) {
            return { success: false, error: '时钟窗口不存在' };
        }
        clockWindowPinned = !clockWindowPinned;
        clockWindow.setAlwaysOnTop(clockWindowPinned, 'screen-saver');
        return { success: true, pinned: clockWindowPinned };
    } catch (error) {
        console.error('切换时钟置顶失败:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('reveal-path-in-folder', () => {
    try {
        if (!lastPreviewImagePath) {
            return { success: false, error: '无可定位的路径' };
        }
        shell.showItemInFolder(lastPreviewImagePath);
        return { success: true };
    } catch (error) {
        console.error('定位路径失败:', error);
        return { success: false, error: error.message };
    }
});



// ==================== 超级面板插件API ==================== //

// 超级面板功能注册表
let superPanelRegistry = new Map();

// 插件API：注册功能到超级面板
ipcMain.handle('register-super-panel-action', (event, pluginName, action) => {
    try {
        console.log(`🔌 插件 ${pluginName} 注册功能:`, action.title);

        if (!superPanelRegistry.has(pluginName)) {
            superPanelRegistry.set(pluginName, []);
        }

        const actions = superPanelRegistry.get(pluginName);

        // 检查是否已存在相同ID的功能
        const existingIndex = actions.findIndex(a => a.id === action.id);
        if (existingIndex >= 0) {
            actions[existingIndex] = action; // 更新现有功能
        } else {
            actions.push(action); // 添加新功能
        }

        superPanelRegistry.set(pluginName, actions);

        // 通知超级面板更新
        notifySuperPanelUpdate();

        return true;
    } catch (error) {
        console.error('注册超级面板功能失败:', error);
        return false;
    }
});

// 插件API：取消注册功能
ipcMain.handle('unregister-super-panel-action', (event, pluginName, actionId) => {
    try {
        console.log(`🔌 插件 ${pluginName} 取消注册功能:`, actionId);

        if (superPanelRegistry.has(pluginName)) {
            const actions = superPanelRegistry.get(pluginName);
            const filteredActions = actions.filter(a => a.id !== actionId);
            superPanelRegistry.set(pluginName, filteredActions);

            // 通知超级面板更新
            notifySuperPanelUpdate();
        }

        return true;
    } catch (error) {
        console.error('取消注册超级面板功能失败:', error);
        return false;
    }
});

// 插件API：清除插件的所有功能
ipcMain.handle('clear-super-panel-actions', (event, pluginName) => {
    try {
        console.log(`🔌 清除插件 ${pluginName} 的所有超级面板功能`);
        superPanelRegistry.delete(pluginName);

        // 通知超级面板更新
        notifySuperPanelUpdate();

        return true;
    } catch (error) {
        console.error('清除超级面板功能失败:', error);
        return false;
    }
});

// 获取超级面板功能（新的统一接口）
/**
 * 获取超级面板功能（统一聚合所有来源并去重）
 * - 来源：插件注册的功能、自定义持久化功能、内置功能、动态功能
 * - 排序：按类型优先级 dynamic > plugin > custom > builtin
 * - 去重：按 id 去重，保留优先级更高的项
 * @param {Electron.IpcMainInvokeEvent} event IPC 调用事件
 * @param {string} clipboardText 当前剪贴板文本
 * @returns {Promise<Array>} 聚合后的功能列表
 */
ipcMain.handle('get-super-panel-actions', async (event, contextInput) => {
    try {
        const context = normalizeSuperPanelContext(contextInput);
        const clipboardText = context.text;
        console.log('🎯 获取超级面板功能，上下文:', { source: context.source, textLength: clipboardText.length, hasImage: context.hasImage });

        // 获取设置中保存的功能列表
        const settings = loadSettings();
        let configuredActions = settings.superPanelActions || [];
        console.log(`从设置中加载已配置功能: ${configuredActions.length}个`);

        // 总是重新加载功能，确保获取最新的功能列表
        let allActions = [];

        // 1. 获取插件注册的功能
        for (const [pluginName, actions] of superPanelRegistry) {
            console.log(`📦 加载插件功能: ${pluginName} (${actions.length}个)`);
            allActions = allActions.concat(actions.map(action => ({
                ...action,
                source: 'plugin',
                pluginName: pluginName
            })));
        }

        // 2. 获取持久化的自定义功能
        const customActions = await getCustomSuperPanelActions();
        allActions = allActions.concat(customActions);

        // 3. 获取内置功能
        const builtinActions = await getBuiltinSuperPanelActions();
        allActions = allActions.concat(builtinActions);

        // 4. 获取动态功能（基于剪贴板内容）
        const dynamicActions = await getDynamicSuperPanelActions(clipboardText);
        allActions = allActions.concat(dynamicActions);

        console.log(`🔧 总共可用功能: ${allActions.length}个`);

        // 如果设置中有指定的功能列表，则过滤出已配置的功能
        if (configuredActions.length > 0) {
            const configuredIds = new Set(configuredActions.map(action => action.id));
            const filteredActions = allActions.filter(action => configuredIds.has(action.id));
            console.log(`🎯 已配置功能: ${filteredActions.length}个`);

            const sortedActions = configuredActions.map(configAction => {
                const foundAction = allActions.find(action => action.id === configAction.id);
                return foundAction || configAction;
            }).filter(action => action);

            const combined = [...(dynamicActions || []), ...sortedActions];
            const uniqueById = new Map();
            for (const action of combined) {
                if (!action || !action.id) continue;
                if (!uniqueById.has(action.id)) {
                    uniqueById.set(action.id, action);
                }
            }
            return rankSuperPanelActions(Array.from(uniqueById.values()), context);
        }

        // 否则返回所有功能（首次使用时）
        console.log('返回所有可用功能');

        // 按类型和优先级排序
        allActions.sort((a, b) => {
            const priorityMap = { dynamic: 1, plugin: 2, custom: 3, builtin: 4 };
            return (priorityMap[a.type] || 5) - (priorityMap[b.type] || 5);
        });

        // 根据 id 去重（保留优先级排序后靠前的项）
        const uniqueById = new Map();
        for (const action of allActions) {
            if (!action || !action.id) continue;
            if (!uniqueById.has(action.id)) {
                uniqueById.set(action.id, action);
            }
        }
        const dedupedActions = Array.from(uniqueById.values());
        console.log(`去重后功能数量: ${dedupedActions.length}`);

        return rankSuperPanelActions(dedupedActions, context);
    } catch (error) {
        console.error('获取超级面板功能失败:', error);
        return [];
    }
});

// 通知超级面板更新
function notifySuperPanelUpdate() {
    if (superPanelWindow && !superPanelWindow.isDestroyed()) {
        superPanelWindow.webContents.send('refresh-super-panel');
    }
}

// 插件管理器接口：当插件启动时自动注册其超级面板功能
function autoRegisterPluginSuperPanelActions(pluginName, pluginConfig, pluginPath = null, notify = true) {
    try {
        if (!pluginConfig || !pluginConfig.features) return;

        console.log(`🚀 自动注册插件 ${pluginName} 的超级面板功能`);

        // 如果没有提供 pluginPath，尝试推算
        if (!pluginPath && pluginManager && pluginManager.getPluginPath) {
            pluginPath = pluginManager.getPluginPath(pluginName);
        }

        const resolvedPluginPath = resolvePluginPathByName(pluginName, pluginPath);
        if (resolvedPluginPath) {
            pluginPath = resolvedPluginPath;
        }

        console.log(`插件 ${pluginName} 的路径: ${pluginPath}`);

        pluginConfig.features.forEach(rawFeature => {
            // 检查功能是否支持超级面板
            if (rawFeature.superPanel !== false) { // 默认启用，除非明确禁用
                // 处理图标：优先使用插件目录中的logo.ico，其次使用logo.png，最后使用默认emoji
                let icon = getPluginDefaultIcon(pluginName);

                // 尝试查找插件目录中的图标文件
                try {
                    // 首先尝试 logo.ico
                    const icoPath = path.join(pluginPath, 'logo.ico');
                    if (fs.existsSync(icoPath)) {
                        // 读取图片文件并转换为base64
                        try {
                            const imageBuffer = fs.readFileSync(icoPath);
                            const base64Image = imageBuffer.toString('base64');
                            icon = `data:image/x-icon;base64,${base64Image}`;
                            console.log(`使用ICO图标(base64): ${icoPath}`);
                        } catch (error) {
                            console.error(`读取ICO图标失败:`, error);
                            icon = getPluginDefaultIcon(pluginName);
                        }
                    } else {
                        // 然后尝试 logo.png
                        const pngPath = path.join(pluginPath, 'logo.png');
                        if (fs.existsSync(pngPath)) {
                            // 读取图片文件并转换为base64
                            try {
                                const imageBuffer = fs.readFileSync(pngPath);
                                const base64Image = imageBuffer.toString('base64');
                                icon = `data:image/png;base64,${base64Image}`;
                                console.log(`使用PNG图标(base64): ${pngPath}`);
                            } catch (error) {
                                console.error(`读取PNG图标失败:`, error);
                                icon = getPluginDefaultIcon(pluginName);
                            }
                        } else {
                            // 如果指定了图标文件，尝试使用指定的文件
                            if (rawFeature.icon && rawFeature.icon.includes('.')) {
                                const customIconPath = path.join(pluginPath, rawFeature.icon);
                                if (fs.existsSync(customIconPath)) {
                                    try {
                                        const imageBuffer = fs.readFileSync(customIconPath);
                                        const base64Image = imageBuffer.toString('base64');
                                        const ext = path.extname(customIconPath).toLowerCase();
                                        const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.svg' ? 'image/svg+xml' : 'image/x-icon';
                                        icon = `data:${mimeType};base64,${base64Image}`;
                                        console.log(`使用自定义图标(base64): ${customIconPath}`);
                                    } catch (error) {
                                        console.error(`读取自定义图标失败:`, error);
                                        icon = getPluginDefaultIcon(pluginName);
                                    }
                                }
                            }
                            // 如果是emoji，直接使用
                            else if (rawFeature.icon && /^[\u{1F000}-\u{1F9FF}]|^[\u{2600}-\u{26FF}]|^[\u{2700}-\u{27BF}]/u.test(rawFeature.icon)) {
                                icon = rawFeature.icon;
                                console.log(`使用emoji图标: ${rawFeature.icon}`);
                            }
                        }
                    }
                } catch (error) {
                    console.error(`查找插件图标失败:`, error);
                }

                // 清洗 feature，确保可序列化
                /**
                 * 函数级注释：
                 * - 将插件 feature 精简为可跨 IPC 传输的形态：仅保留 code/explain/cmds
                 * - 对 cmds 进行逐项清洗，剔除函数/RegExp 等不可克隆对象，避免“An object could not be cloned”
                 */
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

                const feature = {
                    code: String(rawFeature.code || ''),
                    explain: String(rawFeature.explain || ''),
                    cmds: Array.isArray(rawFeature.cmds) ? rawFeature.cmds.map(sanitizeCmd) : []
                };

                const action = {
                    id: `plugin-${pluginName}-${feature.code}`,
                    title: feature.explain || feature.code,
                    description: rawFeature.description || `使用 ${pluginName} 的 ${rawFeature.explain || rawFeature.code} 功能`,
                    icon: icon,
                    type: 'plugin',
                    category: rawFeature.category || '插件功能',
                    pluginPath: pluginPath,
                    feature: feature,
                    priority: rawFeature.priority || 10
                };

                console.log(`注册功能: ${action.title} (${action.id})`);

                // 直接添加到注册表
                if (!superPanelRegistry.has(pluginName)) {
                    superPanelRegistry.set(pluginName, []);
                }

                const actions = superPanelRegistry.get(pluginName);
                const existingIndex = actions.findIndex(a => a.id === action.id);
                if (existingIndex >= 0) {
                    actions[existingIndex] = action;
                } else {
                    actions.push(action);
                }

                superPanelRegistry.set(pluginName, actions);
            }
        });

        const registeredCount = superPanelRegistry.get(pluginName)?.length || 0;
        console.log(`插件 ${pluginName} 共注册了 ${registeredCount} 个超级面板功能`);

        // 通知更新
        if (notify) notifySuperPanelUpdate();

    } catch (error) {
        console.error('自动注册插件超级面板功能失败:', error);
    }
}

// 根据插件名称获取文件夹名称
function getPluginFolderName(pluginName) {
    const foundPath = findPluginPathByName(pluginName);
    if (foundPath) {
        return path.basename(foundPath);
    }

    return pluginName ? pluginName.toLowerCase().replace(/\s+/g, '-') : '';
}

function getPluginRootDirs() {
    if (app.isPackaged) return [getPluginInstallDir()];
    return Array.from(new Set([
        path.join(app.getAppPath(), 'app', 'software'),
        path.join(__dirname, 'app', 'software')
    ]));
}

function findPluginPathByName(pluginName) {
    if (!pluginName) return null;

    const pluginDirs = getPluginRootDirs();
    for (const pluginDir of pluginDirs) {
        if (!fs.existsSync(pluginDir)) continue;
        try {
            const items = fs.readdirSync(pluginDir, { withFileTypes: true });
            for (const item of items) {
                if (!item.isDirectory()) continue;
                const pluginPath = path.join(pluginDir, item.name);
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
            console.error('扫描插件目录失败:', pluginDir, error);
        }
    }

    return null;
}

function resolvePluginPathByName(pluginName, pluginPath) {
    if (pluginPath && fs.existsSync(pluginPath)) {
        const pluginJsonPath = path.join(pluginPath, 'plugin.json');
        if (fs.existsSync(pluginJsonPath)) {
            try {
                const pluginConfig = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
                const resolvedName = pluginConfig.pluginName || path.basename(pluginPath);
                if (!pluginName || resolvedName === pluginName) {
                    return pluginPath;
                }
            } catch (error) {
                console.error('读取插件配置失败:', pluginJsonPath, error);
            }
        }
    }

    const foundPath = findPluginPathByName(pluginName);
    if (foundPath) return foundPath;

    return pluginPath;
}

// 获取插件默认图标
function getPluginDefaultIcon(pluginName) {
    const iconMap = {
        '余汉波文本片段助手': '📝',
        'sanrenjz-tools-text': '📝',
        '密码管理器': '🔐',
        'sanrenjz-tools-password': '🔐',
        '插件下载': '📦',
        'sanrenjz-tools-download_plugin': '📦',
        'sanrenjz-tools-download': '📦',
        '余汉波AI助手': '🤖',
        'sanrenjz.tools-ai': '🤖'
    };

    return iconMap[pluginName] || '🔧';
}

// 初始化超级面板默认功能
/**
 * 初始化并合并超级面板默认功能
 * - 若用户配置文件不存在：优先从示例文件复制；若示例不存在则写入基础内置配置
 * - 若用户配置文件已存在：与示例文件进行按 id 合并（仅补充新增示例项，不覆盖用户自定义）
 */
async function initializeSuperPanelDefaults() {
    try {
        console.log('🚀 初始化超级面板默认功能');

        const customActionsPath = path.join(app.getPath('userData'), 'custom-super-panel-actions.json');

        // 检查是否已经初始化过
        if (fs.existsSync(customActionsPath)) {
            console.log('超级面板配置文件已存在，跳过初始化');
            return;
        }

        // 读取示例配置文件并初始化
        const exampleConfigPath = path.join(__dirname, 'custom-super-panel-actions-example.json');
        if (fs.existsSync(exampleConfigPath)) {
            console.log('从示例配置初始化超级面板');
            const exampleData = fs.readFileSync(exampleConfigPath, 'utf8');
            fs.writeFileSync(customActionsPath, exampleData);
            console.log('✅ 超级面板默认功能初始化完成');
        } else {
            console.log('示例配置文件不存在，创建基础配置');
            const basicActions = [
                {
                    id: 'generate-password-simple',
                    title: '简单密码',
                    description: '生成8位简单密码（无特殊字符）',
                    icon: '🔒',
                    type: 'builtin',
                    category: '密码生成',
                    priority: 1
                },
                {
                    id: 'generate-password-strong',
                    title: '强密码',
                    description: '生成16位强密码（包含特殊字符）',
                    icon: '🔐',
                    type: 'builtin',
                    category: '密码生成',
                    priority: 2
                },
                {
                    id: 'current-time',
                    title: '当前时间',
                    description: '获取当前时间并复制到剪贴板',
                    icon: '🕐',
                    type: 'builtin',
                    category: '时间工具',
                    priority: 4
                },
                {
                    id: 'custom-calculator',
                    title: '计算器',
                    description: '打开系统计算器',
                    icon: '🧮',
                    type: 'custom',
                    category: '系统工具',
                    command: 'open-app',
                    args: { app: 'calc.exe' },
                    priority: 10
                },
                {
                    id: 'custom-notepad',
                    title: '记事本',
                    description: '打开记事本',
                    icon: '📝',
                    type: 'custom',
                    category: '系统工具',
                    command: 'open-app',
                    args: { app: 'notepad.exe' },
                    priority: 11
                }
            ];
            fs.writeFileSync(customActionsPath, JSON.stringify(basicActions, null, 2));
            console.log('✅ 超级面板基础功能初始化完成');
        }

    } catch (error) {
        console.error('初始化超级面板默认功能失败:', error);
    }

    // 合并示例与用户自定义（若用户文件已存在）
    try {
        const customActionsPath = path.join(app.getPath('userData'), 'custom-super-panel-actions.json');
        const exampleConfigPath = path.join(__dirname, 'custom-super-panel-actions-example.json');
        if (fs.existsSync(customActionsPath) && fs.existsSync(exampleConfigPath)) {
            console.log('🔧 合并示例功能到用户配置（仅补充新增项，不覆盖用户修改）');
            const userData = JSON.parse(fs.readFileSync(customActionsPath, 'utf8') || '[]');
            const exampleData = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf8') || '[]');
            const merged = mergeActionsByIdPreserveUser(userData, exampleData);
            fs.writeFileSync(customActionsPath, JSON.stringify(merged, null, 2));
            console.log('✅ 合并完成');
        }

    } catch (mergeError) {
        console.error('合并示例与用户自定义失败:', mergeError);
    }
}

/**
 * 将示例动作合并到用户自定义动作（按 id 去重）
 * - 用户动作优先：若 id 已存在，则保留用户版本，不覆盖
 * - 仅补充：将示例中不存在于用户的动作追加到末尾
 * @param {Array} userActions 用户自定义动作数组
 * @param {Array} exampleActions 示例动作数组
 * @returns {Array} 合并后的动作数组
 */
function mergeActionsByIdPreserveUser(userActions = [], exampleActions = []) {
    try {
        const byId = new Map();
        const result = [];
        // 先放入用户动作
        for (const a of (Array.isArray(userActions) ? userActions : [])) {
            if (!a || !a.id) continue;
            byId.set(a.id, true);
            result.push(a);
        }
        // 再补充示例中新增的动作
        for (const a of (Array.isArray(exampleActions) ? exampleActions : [])) {
            if (!a || !a.id) continue;
            if (!byId.has(a.id)) {
                result.push(a);
            }
        }
        return result;
    } catch (error) {
        console.error('mergeActionsByIdPreserveUser 失败:', error);
        return Array.isArray(userActions) ? userActions : [];
    }
}

// 初始化插件的超级面板功能
async function initializePluginSuperPanelActions() {
    try {
        console.log('🔌 开始初始化插件超级面板功能');

        const entries = await pluginManager.catalog.read();
        const registered = new Set();
        for (const entry of entries) {
            const pluginName = entry.config.pluginName || entry.folder;
            if (registered.has(pluginName)) continue;
            try {
                superPanelRegistry.delete(pluginName);
                autoRegisterPluginSuperPanelActions(pluginName, entry.config, entry.path, false);
                registered.add(pluginName);
            } catch (error) {
                console.warn(`注册插件超级面板功能失败 ${pluginName}:`, error.message);
            }
        }
        console.log(`已读取 ${entries.length} 个插件清单`);

        console.log('✅ 插件超级面板功能初始化完成');

        // 通知超级面板更新
        notifySuperPanelUpdate();

    } catch (error) {
        console.error('初始化插件超级面板功能失败:', error);
    }
}

// 添加 IPC 处理：获取用户自定义功能
ipcMain.handle('get-custom-super-panel-actions', () => {
    try {
        const customActionsPath = path.join(app.getPath('userData'), 'custom-super-panel-actions.json');
        if (fs.existsSync(customActionsPath)) {
            const data = fs.readFileSync(customActionsPath, 'utf8');
            return JSON.parse(data);
        }
        return [];
    } catch (error) {
        console.error('读取自定义功能失败:', error);
        return [];
    }
});

// 添加 IPC 处理：保存用户自定义功能
ipcMain.handle('save-custom-super-panel-actions', (event, actions) => {
    try {
        const customActionsPath = path.join(app.getPath('userData'), 'custom-super-panel-actions.json');
        fs.writeFileSync(customActionsPath, JSON.stringify(actions, null, 2));
        return true;
    } catch (error) {
        console.error('保存自定义功能失败:', error);
        return false;
    }
});

// 已移除：自动粘贴与输入框直接插入相关逻辑。
// 说明：根据最新需求，所有插入行为统一改为“复制到剪贴板”，不再尝试在输入框中自动粘贴或直接写入。

// 插件存储相关的IPC处理器（同步）
ipcMain.on('plugin-storage-set', (event, pluginName, key, value) => {
    try {
        if (pluginManager) {
            const result = pluginManager.setPluginStorageItem(pluginName, key, value);
            if (pluginName === '余汉波文本片段助手' && key === 'snippets-settings') invalidateTextSnippetCache('settings-changed');
            else invalidateSearchCatalog(`storage-set:${pluginName}:${key}`);
            console.log(`插件存储设置: ${pluginName} - ${key}`, '成功:', result);
            event.returnValue = result;
        } else {
            console.error('插件管理器未初始化');
            event.returnValue = false;
        }
    } catch (error) {
        console.error('插件存储设置失败:', error);
        event.returnValue = false;
    }
});

ipcMain.on('plugin-storage-get', (event, pluginName, key) => {
    try {
        if (pluginManager) {
            const result = pluginManager.getPluginStorageItem(pluginName, key);
            console.log(`插件存储获取: ${pluginName} - ${key}`, '结果:', result);
            event.returnValue = result;
        } else {
            console.error('插件管理器未初始化');
            event.returnValue = null;
        }
    } catch (error) {
        console.error('插件存储获取失败:', error);
        event.returnValue = null;
    }
});

ipcMain.on('plugin-storage-remove', (event, pluginName, key) => {
    try {
        if (pluginManager) {
            const result = pluginManager.removePluginStorageItem(pluginName, key);
            if (pluginName === '余汉波文本片段助手' && key === 'snippets-settings') invalidateTextSnippetCache('settings-removed');
            else invalidateSearchCatalog(`storage-remove:${pluginName}:${key}`);
            console.log(`插件存储删除: ${pluginName} - ${key}`, '成功:', result);
            event.returnValue = result;
        } else {
            console.error('插件管理器未初始化');
            event.returnValue = false;
        }
    } catch (error) {
        console.error('插件存储删除失败:', error);
        event.returnValue = false;
    }
});

// 异步插件存储API (用于渲染进程，避免阻塞)
ipcMain.handle('plugin-storage-get-async', (event, pluginName, key) => {
    try {
        if (pluginManager) {
            return pluginManager.getPluginStorageItem(pluginName, key);
        }
        return null;
    } catch (error) {
        console.error('插件存储获取失败(Async):', error);
        return null;
    }
});

ipcMain.handle('plugin-storage-set-async', (event, pluginName, key, value) => {
    try {
        if (pluginManager) {
            const result = pluginManager.setPluginStorageItem(pluginName, key, value);
            if (pluginName === '余汉波文本片段助手' && key === 'snippets-settings') invalidateTextSnippetCache('settings-changed');
            else invalidateSearchCatalog(`storage-set:${pluginName}:${key}`);
            return result;
        }
        return false;
    } catch (error) {
        console.error('插件存储设置失败(Async):', error);
        return false;
    }
});

ipcMain.handle('plugin-storage-remove-async', (event, pluginName, key) => {
    try {
        if (pluginManager) {
            const result = pluginManager.removePluginStorageItem(pluginName, key);
            if (pluginName === '余汉波文本片段助手' && key === 'snippets-settings') invalidateTextSnippetCache('settings-removed');
            else invalidateSearchCatalog(`storage-remove:${pluginName}:${key}`);
            return result;
        }
        return false;
    } catch (error) {
        console.error('插件存储删除失败(Async):', error);
        return false;
    }
});

ipcMain.handle('get-clipboard-context', () => {
    const { clipboard } = require('electron');
    const image = clipboard.readImage();
    return { text: clipboard.readText() || '', hasImage: Boolean(image && !image.isEmpty()), source: 'clipboard' };
});

function getPluginSecretPath(pluginName) {
    const dataDir = pluginManager?.getPluginDataDirectory?.() || path.join(app.getPath('userData'), 'plugin-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const safeName = String(pluginName || 'plugin').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    return path.join(dataDir, `${safeName}-secrets.bin`);
}

function readPluginSecrets(pluginName) {
    const secretPath = getPluginSecretPath(pluginName);
    if (!fs.existsSync(secretPath)) return {};
    const buffer = fs.readFileSync(secretPath);
    try {
        const prefix = buffer.subarray(0, 6).toString('utf8');
        const json = prefix === 'plain:' ? buffer.subarray(6).toString('utf8') : safeStorage.decryptString(buffer);
        return JSON.parse(json) || {};
    } catch (error) {
        console.warn(`读取插件密钥失败 ${pluginName}:`, error.message);
        return {};
    }
}

function writePluginSecrets(pluginName, secrets) {
    const json = JSON.stringify(secrets || {});
    const encrypted = safeStorage.isEncryptionAvailable();
    const payload = encrypted ? safeStorage.encryptString(json) : Buffer.from(`plain:${json}`, 'utf8');
    fs.writeFileSync(getPluginSecretPath(pluginName), payload);
    return encrypted;
}

ipcMain.handle('plugin-secret-get', (event, pluginName, key) => {
    const secrets = readPluginSecrets(pluginName);
    return { value: String(secrets[key] || ''), encryptionAvailable: safeStorage.isEncryptionAvailable() };
});

ipcMain.handle('plugin-secret-set', (event, pluginName, key, value) => {
    const secrets = readPluginSecrets(pluginName);
    secrets[key] = String(value || '');
    const encryptionAvailable = writePluginSecrets(pluginName, secrets);
    return { success: true, encryptionAvailable };
});

ipcMain.handle('plugin-secret-remove', (event, pluginName, key) => {
    const secrets = readPluginSecrets(pluginName);
    delete secrets[key];
    const encryptionAvailable = writePluginSecrets(pluginName, secrets);
    return { success: true, encryptionAvailable };
});

ipcMain.handle('ai-opencode-list-models', async () => openCodeRuntime.listModels());
ipcMain.handle('ai-opencode-complete', async (event, request) => openCodeRuntime.complete(request));
ipcMain.handle('ai-opencode-cancel', (event, requestId) => openCodeRuntime.cancel(requestId));

// 获取插件数据存储目录
// 函数级注释：
// - 优先返回当前插件管理器正在使用的目录，保证与实际读写一致
// - 若管理器未初始化或目录不存在，则回退到设置中的自定义目录；如仍无效，则回退到默认目录
ipcMain.handle('get-plugin-data-directory', () => {
    try {
        // 优先使用管理器的当前目录
        if (pluginManager && typeof pluginManager.getPluginDataDirectory === 'function') {
            const managerDir = pluginManager.getPluginDataDirectory();
            if (managerDir && fs.existsSync(managerDir)) {
                return managerDir;
            }
        }

        // 其次使用设置中的自定义路径
        const settings = loadSettings();
        if (settings.customPluginDataPath && fs.existsSync(settings.customPluginDataPath)) {
            return settings.customPluginDataPath;
        }

        // 最后回退到默认路径
        return path.join(app.getPath('userData'), 'plugin-data');
    } catch (error) {
        console.error('获取插件数据目录失败:', error);
        return null;
    }
});

// 设置自定义插件数据存储目录
ipcMain.handle('set-custom-plugin-data-directory', async (event) => {
    try {
        const result = await dialog.showOpenDialog({
            title: '选择插件数据存储目录',
            properties: ['openDirectory', 'createDirectory'],
            buttonLabel: '选择目录'
        });

        if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
            return { success: false, message: '用户取消选择' };
        }

        const selectedPath = result.filePaths[0];

        // 验证目录是否可写
        try {
            const testFile = path.join(selectedPath, '.test_write_permission');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
        } catch (writeError) {
            return { success: false, message: '所选目录没有写入权限，请选择其他目录' };
        }

        // 创建插件数据子目录
        const pluginDataPath = path.join(selectedPath, 'plugin-data');
        if (!fs.existsSync(pluginDataPath)) {
            fs.mkdirSync(pluginDataPath, { recursive: true });
        }

        // 更新设置
        const settings = loadSettings();
        settings.customPluginDataPath = pluginDataPath;
        saveSettings(settings);

        // 更新插件管理器的数据目录
        if (pluginManager) {
            pluginManager.updatePluginDataDirectory(pluginDataPath);
        }

        return { success: true, path: pluginDataPath };
    } catch (error) {
        console.error('设置自定义插件数据目录失败:', error);
        return { success: false, message: error.message };
    }
});

// 重置插件数据存储目录为默认值
ipcMain.handle('reset-plugin-data-directory', () => {
    try {
        const settings = loadSettings();
        settings.customPluginDataPath = null;
        saveSettings(settings);

        const defaultPath = path.join(app.getPath('userData'), 'plugin-data');

        // 更新插件管理器的数据目录
        if (pluginManager) {
            pluginManager.updatePluginDataDirectory(defaultPath);
        }

        return { success: true, path: defaultPath };
    } catch (error) {
        console.error('重置插件数据目录失败:', error);
        return { success: false, message: error.message };
    }
});

// 监听插件自动分离状态变更
ipcMain.on('plugin-auto-separate-changed', (event, { pluginName, value }) => {
    try {
        if (pluginManager) {
            // 获取当前插件窗口
            const win = pluginManager.pluginWindows.get(pluginName);
            if (win && !win.isDestroyed()) {
                // 如果开启自动分离，立即钉住窗口
                if (value) {
                    if (!pluginManager.getPluginPinStatus(pluginName)) {
                        pluginManager.togglePluginPin(pluginName);
                    }
                } else {
                    // 如果关闭自动分离，取消钉住
                    if (pluginManager.getPluginPinStatus(pluginName)) {
                        pluginManager.togglePluginPin(pluginName);
                    }
                }
            }
        }
    } catch (error) {
        console.error('处理插件自动分离变更失败:', error);
    }
});

// 应用程序生命周期事件

app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
        if (mergedAcceptance) return;

        initializeMobileRemote();
        return;
    }
    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }
    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(false);
        }
    }, 100);
});

// 当Electron完成初始化时创建窗口
app.whenReady().then(async () => {
    try {
        if (!gotSingleInstanceLock) return;
        configureLoggingAndCache();
        // 初始化remote模块
        if (remoteMain) {
            remoteMain.initialize();
            console.log('✅ @electron/remote模块初始化成功');
        } else {
            console.warn('⚠️ @electron/remote模块未加载，某些功能可能受限');
        }

        // 初始化插件管理器
        PluginManager = require(app.isPackaged
            ? path.join(process.resourcesPath, 'app', 'software_manager.js')
            : './app/software_manager.js');
        bindBuiltinSessionEvents();
        preparePluginStore();

        // 在应用准备就绪时就设置空菜单，确保所有平台都生效
        Menu.setApplicationMenu(null);

        createWindow();
        if (mergedAcceptance) return;

        initializeMobileRemote();

        // 注册全局快捷键
        if (mobileAcceptance) {
            await require('./tests/remote-main-live').run({ service: mobileRemoteService, manager: pluginManager, mainWindow });
            return;
        }
        const settings = loadSettings();
        if (!registerGlobalShortcut(settings.globalHotkey || 'Alt+Space')) {
            mainWindow.webContents.once('dom-ready', () => sendRendererEvent('notify', {
                title: '全局快捷键未生效',
                message: `${settings.globalHotkey || 'Alt+Space'} 已被其他程序占用，请释放该组合键后重新保存。`, type: 'warning'
            }));
        }

        // 注册钉住快捷键
        registerPinShortcut(settings.pinHotkey);

        // 启动鼠标监控（右键长按）
        if (process.platform === 'win32') {
            startMouseMonitor();
        }

        // 设置开机自启动
        if (settings.autoStart) {
            try {
                app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
            } catch (error) {
                console.warn('系统自启动未能启用:', error.message);
                const notify = () => sendRendererEvent('notify', { title: '开机自启动未生效', message: error.message, type: 'warning' });
                if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('dom-ready', notify);
                else notify();
            }
        }

        // 监听主窗口关闭事件，隐藏到托盘而不是退出
        mainWindow.on('close', (event) => {
            if (!app.isQuiting) {
                console.log('主窗口关闭，隐藏到托盘');
                event.preventDefault();
                mainWindow.hide();
            }
        });

        // 注册超级面板快捷键
        if (settings.superPanelHotkey && settings.superPanelHotkey.trim() !== '') {
            const ok = registerSuperPanelShortcut(settings.superPanelHotkey);
            if (!ok) {
                console.log('超级面板快捷键注册失败:', settings.superPanelHotkey);
            }
        }

        // 初始化超级面板默认功能
        await initializeSuperPanelDefaults();

        // 自动加载和注册所有插件的超级面板功能
        await initializePluginSuperPanelActions();

        console.log('应用初始化完成');

    } catch (error) {
        console.error('初始化失败:', error);
        app.quit();
    }
});

// 当所有窗口关闭时的处理
app.on('window-all-closed', () => {
    // 不自动退出，保持在托盘中运行
    console.log('所有窗口已关闭，应用继续在托盘中运行');
});

app.on('activate', () => {
    // macOS 下点击程序坞图标时重新创建窗口
    if (mainWindow === null) {
        createWindow();
    } else if (!mainWindow.isVisible()) {
        mainWindow.show();
        mainWindow.focus();
    }
});

// 两阶段退出：先等 Python 子进程及安装暂存清理，再放行 Electron 退出。
let mergedShutdownStarted = false;
let mergedShutdownComplete = false;
app.on('before-quit', event => {
    if (mergedHost && !mergedShutdownComplete) {
        event.preventDefault();
        app.isQuiting = true;
        if (!mergedShutdownStarted) {
            mergedShutdownStarted = true;
            let deadline;
            Promise.race([
                Promise.allSettled([mergedHost.python.shutdown(), mergedHost.environment.shutdown()]),
                new Promise(resolve => { deadline = setTimeout(resolve, 10000); })
            ]).finally(() => {
                clearTimeout(deadline);
                mergedShutdownComplete = true;
                app.quit();
            });
        }
        return;
    }
    mobileRemoteService?.stop().catch(() => {});
    mobileRemoteService?.castPlugins?.close();
    console.log('应用即将退出，清理资源...');
    app.isQuiting = true;

    // 注销本应用录入会话和全局快捷键。
    hotkeyController?.dispose();
    globalShortcut.unregisterAll();

    // 停止鼠标监控
    stopMouseMonitor();
    closeTextSnippetWatchers();
    openCodeRuntime.stop();

    // 停止所有插件
    if (pluginManager) {
        pluginManager.stopAllPlugins();
    }

    // 销毁托盘图标
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

// 添加 IPC 处理：打开插件管理器
ipcMain.handle('open-plugin-manager', () => {
    try {
        // 创建插件管理窗口
        createPluginManagerWindow();
    } catch (error) {
        console.error('打开插件管理器失败:', error);
    }
});

// 添加 IPC 处理：显示消息框
ipcMain.handle('show-message-box', async (event, options) => {
    try {
        const result = await dialog.showMessageBox(mainWindow, options);
        return result;
    } catch (error) {
        console.error('显示消息框失败:', error);
        throw error;
    }
});

// 添加 IPC 处理：显示打开对话框
ipcMain.handle('show-open-dialog', async (event, options) => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, options);
        return result;
    } catch (error) {
        console.error('显示打开对话框失败:', error);
        throw error;
    }
});

// 添加 IPC 处理：打开添加插件功能对话框
ipcMain.handle('open-add-plugin-dialog', async () => {
    try {
        // 获取鼠标位置并计算窗口显示位置
        let windowOptions = {
            width: 600,
            height: 500,
            modal: true,
            parent: superPanelWindow || mainWindow,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                enableRemoteModule: true
            },
            frame: false,
            resizable: false,
            transparent: true,
            alwaysOnTop: true
        };

        try {
            // 获取鼠标位置并在鼠标所在的屏幕显示窗口
            const { screen } = require('electron');
            const cursorPoint = screen.getCursorScreenPoint();
            const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

            // 计算窗口位置，在屏幕中央显示
            let x = currentDisplay.workArea.x + Math.round((currentDisplay.workArea.width - 600) / 2);
            let y = currentDisplay.workArea.y + Math.round((currentDisplay.workArea.height - 500) / 2);

            // 边界检查
            if (x < currentDisplay.workArea.x) x = currentDisplay.workArea.x + 10;
            if (x + 600 > currentDisplay.workArea.x + currentDisplay.workArea.width) {
                x = currentDisplay.workArea.x + currentDisplay.workArea.width - 600 - 10;
            }
            if (y < currentDisplay.workArea.y) y = currentDisplay.workArea.y + 10;
            if (y + 500 > currentDisplay.workArea.y + currentDisplay.workArea.height) {
                y = currentDisplay.workArea.y + currentDisplay.workArea.height - 500 - 10;
            }

            windowOptions.x = x;
            windowOptions.y = y;
            console.log(`添加插件对话框将在屏幕 ${currentDisplay.id} 显示，位置: (${x}, ${y})`);
        } catch (error) {
            console.error('设置添加插件对话框位置失败，使用默认位置:', error);
        }

        // 创建添加插件功能的对话框窗口
        const addPluginWindow = new BrowserWindow(windowOptions);
        trackSuperPanelChildWindow(addPluginWindow);

        // 启用remote模块
        if (remoteMain) {
            remoteMain.enable(addPluginWindow.webContents);
        }

        // 创建添加插件功能的HTML内容
        const addPluginHtml = createAddPluginDialogHtml();
        addPluginWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(addPluginHtml)}`);

        addPluginWindow.on('closed', () => {
            // 窗口关闭后的清理工作
        });

        return true;
    } catch (error) {
        console.error('打开添加插件对话框失败:', error);
        return false;
    }
});

// 删除重复的处理器 - 已在上面统一定义

// 添加 IPC 处理：统一执行超级面板功能
ipcMain.handle('execute-super-panel-action', async (event, { action, clipboardText }) => {
    try {
        console.log('执行超级面板功能:', action);

        // 根据操作类型执行不同的逻辑
        if (action.type === 'builtin') {
            // 执行内置功能
            return await executeBuiltinAction(action, clipboardText);
        } else if (action.type === 'custom') {
            // 执行自定义功能
            return await executeCustomAction(action, clipboardText);
        } else if (action.type === 'plugin') {
            // 运行插件
            return await runPluginAction(action.pluginPath, action.feature, clipboardText);
        } else if (action.type === 'dynamic') {
            // 执行动态功能
            return await executeDynamicAction(action, clipboardText);
        }

        return { success: true };
    } catch (error) {
        console.error('执行超级面板功能失败:', error);
        throw error;
    }
});

function normalizeClipboardPath(input) {
    if (!input || typeof input !== 'string') {
        return null;
    }
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.replace(/^"|"$/g, '');
}

function escapePowerShellSingleQuotedString(value) {
    return String(value).replace(/'/g, "''");
}

function openTerminalAtDirectory(targetDirectory) {
    const dir = targetDirectory || app.getPath('home');
    if (process.platform !== 'win32') {
        try {
            spawn('x-terminal-emulator', [], { cwd: dir, detached: true, stdio: 'ignore' }).unref();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    try {
        const wt = spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' });
        wt.unref();
        return { success: true };
    } catch (_) {
        try {
            const escapedDir = escapePowerShellSingleQuotedString(dir);
            const ps = spawn('powershell.exe', ['-NoExit', '-Command', `Set-Location -LiteralPath '${escapedDir}'`], { detached: true, stdio: 'ignore' });
            ps.unref();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

function resolveDirectoryFromPathMaybeFile(targetPath) {
    if (!targetPath) {
        return app.getPath('home');
    }

    try {
        const cleanPath = normalizeClipboardPath(targetPath);
        if (!cleanPath) {
            return app.getPath('home');
        }
        if (!path.isAbsolute(cleanPath) || !fs.existsSync(cleanPath)) {
            return app.getPath('home');
        }
        const stat = fs.statSync(cleanPath);
        if (stat.isDirectory()) {
            return cleanPath;
        }
        return path.dirname(cleanPath);
    } catch (_) {
        return app.getPath('home');
    }
}

function isImageFilePath(targetPath) {
    try {
        const cleanPath = normalizeClipboardPath(targetPath);
        if (!cleanPath) return false;
        const ext = path.extname(cleanPath).toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tif', '.tiff'].includes(ext);
    } catch (_) {
        return false;
    }
}

function toFileUrl(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    return `file:///${encodeURI(normalized)}`;
}

function createClockWindowHtml() {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>时钟</title>
  <style>
    :root { --bg: rgba(20, 20, 24, 0.92); --fg: rgba(255,255,255,0.92); --sub: rgba(255,255,255,0.55); --bd: rgba(255,255,255,0.12); }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; background: var(--bg); color: var(--fg); font-family: 'Segoe UI','Microsoft YaHei',sans-serif; border-radius: 16px; overflow: hidden; border: 1px solid var(--bd); user-select: none; -webkit-app-region: drag; }
    .wrap { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 16px; }
    .time { font-size: 34px; font-weight: 700; letter-spacing: 1px; }
    .date { font-size: 12px; color: var(--sub); }
    .hint { font-size: 11px; color: rgba(255,255,255,0.35); margin-top: 6px; }
    .btns { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; -webkit-app-region: no-drag; }
    .btn { width: 26px; height: 26px; border-radius: 8px; border: 1px solid var(--bd); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.85); cursor: pointer; font-size: 14px; }
    .btn:hover { background: rgba(255,255,255,0.12); }
  </style>
</head>
<body>
  <div class="btns">
    <button class="btn" id="pin">📌</button>
    <button class="btn" id="close">✕</button>
  </div>
  <div class="wrap">
    <div class="time" id="time">--:--:--</div>
    <div class="date" id="date">----</div>
    <div class="hint">拖动窗口可移动</div>
  </div>
  <script>
    const { ipcRenderer } = require('electron');

    function pad(n){ return String(n).padStart(2,'0'); }
    function tick(){
      const now = new Date();
      const h = pad(now.getHours());
      const m = pad(now.getMinutes());
      const s = pad(now.getSeconds());
      document.getElementById('time').textContent = h + ':' + m + ':' + s;
      document.getElementById('date').textContent = now.toLocaleString('zh-CN', { weekday:'long', year:'numeric', month:'2-digit', day:'2-digit' });
    }
    tick();
    setInterval(tick, 250);

    document.getElementById('close').addEventListener('click', () => ipcRenderer.invoke('close-super-panel-child-window', 'clock'));
    document.getElementById('pin').addEventListener('click', () => ipcRenderer.invoke('toggle-super-panel-child-window-pin', 'clock'));
  </script>
</body>
</html>
`;
}

let clockWindow = null;
let clockWindowPinned = false;

function openClockWindow() {
    if (clockWindow && !clockWindow.isDestroyed()) {
        clockWindow.show();
        clockWindow.focus();
        return { success: true };
    }

    clockWindowPinned = false;
    clockWindow = new BrowserWindow({
        width: 240,
        height: 150,
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        movable: true,
        parent: superPanelWindow || mainWindow,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });
    trackSuperPanelChildWindow(clockWindow);
    if (remoteMain) {
        remoteMain.enable(clockWindow.webContents);
    }
    clockWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createClockWindowHtml())}`);
    clockWindow.on('closed', () => {
        clockWindow = null;
        clockWindowPinned = false;
    });
    return { success: true };
}

function createImagePreviewHtml(imageUrl, title) {
    const safeTitle = String(title || '图片').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <style>
    :root { --bg: rgba(18,18,22,0.96); --bd: rgba(255,255,255,0.12); --fg: rgba(255,255,255,0.92); --sub: rgba(255,255,255,0.55); }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; background: var(--bg); color: var(--fg); font-family: 'Segoe UI','Microsoft YaHei',sans-serif; overflow: hidden; border-radius: 12px; border: 1px solid var(--bd); }
    .bar { height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 0 10px; background: rgba(255,255,255,0.04); border-bottom: 1px solid var(--bd); -webkit-app-region: drag; }
    .title { font-size: 12px; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%; }
    .btns { display: flex; gap: 6px; -webkit-app-region: no-drag; }
    .btn { width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--bd); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.85); cursor: pointer; font-size: 14px; }
    .btn:hover { background: rgba(255,255,255,0.12); }
    .stage { height: calc(100vh - 40px); display: flex; align-items: center; justify-content: center; overflow: auto; padding: 14px; }
    img { max-width: 100%; max-height: 100%; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.35); }
  </style>
</head>
<body>
  <div class="bar">
    <div class="title">${safeTitle}</div>
    <div class="btns">
      <button class="btn" id="reveal">📁</button>
      <button class="btn" id="close">✕</button>
    </div>
  </div>
  <div class="stage">
    <img id="img" src="${imageUrl}" />
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    document.getElementById('close').addEventListener('click', () => ipcRenderer.invoke('close-super-panel-child-window', 'image'));
    document.getElementById('reveal').addEventListener('click', () => ipcRenderer.invoke('reveal-path-in-folder'));
  </script>
</body>
</html>
`;
}

let imagePreviewWindow = null;
let lastPreviewImagePath = null;

function openImagePreviewWindow(imagePath) {
    const cleanPath = normalizeClipboardPath(imagePath);
    if (!cleanPath || !path.isAbsolute(cleanPath) || !fs.existsSync(cleanPath)) {
        return { success: false, error: '图片路径无效' };
    }

    lastPreviewImagePath = cleanPath;
    const imageUrl = toFileUrl(cleanPath);

    if (imagePreviewWindow && !imagePreviewWindow.isDestroyed()) {
        imagePreviewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createImagePreviewHtml(imageUrl, path.basename(cleanPath)))}`);
        imagePreviewWindow.show();
        imagePreviewWindow.focus();
        return { success: true };
    }

    imagePreviewWindow = new BrowserWindow({
        width: 900,
        height: 650,
        frame: false,
        transparent: true,
        resizable: true,
        alwaysOnTop: true,
        parent: superPanelWindow || mainWindow,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        }
    });
    trackSuperPanelChildWindow(imagePreviewWindow);
    if (remoteMain) {
        remoteMain.enable(imagePreviewWindow.webContents);
    }
    imagePreviewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createImagePreviewHtml(imageUrl, path.basename(cleanPath)))}`);
    imagePreviewWindow.on('closed', () => {
        imagePreviewWindow = null;
        lastPreviewImagePath = null;
    });
    return { success: true };
}

async function pickImageAndOpenPreview(parentWindow) {
    const result = await dialog.showOpenDialog(parentWindow || superPanelWindow || mainWindow, {
        title: '选择图片',
        properties: ['openFile'],
        filters: [
            { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff'] },
            { name: '所有文件', extensions: ['*'] }
        ]
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, error: '已取消选择' };
    }
    return openImagePreviewWindow(result.filePaths[0]);
}

// 执行内置功能
async function executeBuiltinAction(action, clipboardText) {
    try {
        const { clipboard } = require('electron');

        switch (action.id) {
            case 'generate-password-simple':
                const simplePassword = generateRandomPassword(8, { includeSymbols: false });
                clipboard.writeText(simplePassword);
                console.log('简单密码已复制:', simplePassword);
                break;
            case 'generate-password-strong':
                const strongPassword = generateRandomPassword(16);
                clipboard.writeText(strongPassword);
                console.log('强密码已复制:', strongPassword);
                break;
            case 'generate-password-ultra':
                const ultraPassword = generateRandomPassword(24);
                clipboard.writeText(ultraPassword);
                console.log('超强密码已复制:', ultraPassword);
                break;
            case 'current-time':
                const timeStr = new Date().toLocaleString('zh-CN');
                clipboard.writeText(timeStr);
                console.log('当前时间已复制:', timeStr);
                break;
            case 'timestamp':
                const timestamp = Date.now().toString();
                clipboard.writeText(timestamp);
                console.log('时间戳已复制:', timestamp);
                break;
            case 'uuid':
                const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                    const r = Math.random() * 16 | 0;
                    const v = c == 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                });
                clipboard.writeText(uuid);
                console.log('UUID已复制:', uuid);
                break;
            case 'open-terminal': {
                const targetDir = resolveDirectoryFromPathMaybeFile(clipboardText);
                const result = openTerminalAtDirectory(targetDir);
                if (!result.success) {
                    return result;
                }
                break;
            }
            case 'open-clock': {
                const result = openClockWindow();
                if (!result.success) {
                    return result;
                }
                break;
            }
            case 'open-image': {
                const cleanPath = normalizeClipboardPath(clipboardText);
                if (cleanPath && isImageFilePath(cleanPath) && path.isAbsolute(cleanPath) && fs.existsSync(cleanPath)) {
                    const result = openImagePreviewWindow(cleanPath);
                    if (!result.success) {
                        return result;
                    }
                } else {
                    const result = await pickImageAndOpenPreview(superPanelWindow || mainWindow);
                    if (!result.success) {
                        return result;
                    }
                }
                break;
            }
            case 'screenshot': {
                if (process.platform === 'win32') {
                    try {
                        await shell.openExternal('ms-screenclip:');
                    } catch (_) {
                        try {
                            exec('snippingtool.exe', () => { });
                        } catch (error) {
                            return { success: false, error: error.message };
                        }
                    }
                } else {
                    return { success: false, error: '当前系统不支持该截图方式' };
                }
                break;
            }
            default:
                console.log('未知的内置功能:', action.id);
        }
        return { success: true };
    } catch (error) {
        console.error('执行内置功能失败:', error);
        throw error;
    }
}

// 执行自定义功能
async function executeCustomAction(action, clipboardText) {
    try {
        if (action.command) {
            // 直接执行系统命令
            return await executeSystemCommand(action.command, action.args || {}, clipboardText);
        } else if (action.script) {
            // 执行自定义脚本
            try {
                eval(action.script);
                return { success: true };
            } catch (scriptError) {
                console.error('自定义脚本执行失败:', scriptError);
                throw scriptError;
            }
        }
        return { success: true };
    } catch (error) {
        console.error('执行自定义功能失败:', error);
        throw error;
    }
}

// 执行动态功能
async function executeDynamicAction(action, clipboardText) {
    try {
        switch (action.action || action.command) {
            case 'search-web':
                const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(clipboardText)}`;
                require('electron').shell.openExternal(searchUrl);
                break;
            case 'search-bing':
                const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(clipboardText)}`;
                require('electron').shell.openExternal(bingUrl);
                break;
            case 'search-baidu':
                const baiduUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(clipboardText)}`;
                require('electron').shell.openExternal(baiduUrl);
                break;
            case 'open-url':
                require('electron').shell.openExternal(action.args?.url || clipboardText);
                break;
            case 'send-email':
                const emailUrl = `mailto:${action.args?.email || clipboardText}`;
                require('electron').shell.openExternal(emailUrl);
                break;
            case 'translate':
                const translateUrl = `https://translate.google.com/?sl=${action.args?.from || 'auto'}&tl=${action.args?.to || 'en'}&text=${encodeURIComponent(clipboardText)}`;
                require('electron').shell.openExternal(translateUrl);
                break;
            case 'open-path': {
                const target = normalizeClipboardPath(action.args?.path || clipboardText);
                if (target) {
                    await shell.openPath(target);
                }
                break;
            }
            case 'reveal-path': {
                const target = normalizeClipboardPath(action.args?.path || clipboardText);
                if (target) {
                    shell.showItemInFolder(target);
                }
                break;
            }
            case 'open-terminal': {
                const targetDir = resolveDirectoryFromPathMaybeFile(action.args?.path || clipboardText);
                const result = openTerminalAtDirectory(targetDir);
                if (!result.success) {
                    return result;
                }
                break;
            }
            case 'open-image-preview': {
                const target = normalizeClipboardPath(action.args?.path || clipboardText);
                if (target && isImageFilePath(target) && path.isAbsolute(target) && fs.existsSync(target)) {
                    const result = openImagePreviewWindow(target);
                    if (!result.success) {
                        return result;
                    }
                } else {
                    return { success: false, error: '未检测到有效图片路径' };
                }
                break;
            }
            default:
                console.log('未知的动态功能:', action.action);
        }
        return { success: true };
    } catch (error) {
        console.error('执行动态功能失败:', error);
        throw error;
    }
}

// 已在上面定义，删除重复定义

// 获取自定义超级面板功能
async function getCustomSuperPanelActions() {
    try {
        const customActionsPath = path.join(app.getPath('userData'), 'custom-super-panel-actions.json');

        if (!fs.existsSync(customActionsPath)) {
            return [];
        }

        const data = fs.readFileSync(customActionsPath, 'utf8');
        const actions = JSON.parse(data);

        // 返回所有从配置文件读取的功能，包括自定义和内置
        return actions || [];
    } catch (error) {
        console.error('读取自定义超级面板功能失败:', error);
        return [];
    }
}

// 获取内置超级面板功能
async function getBuiltinSuperPanelActions() {
    return [
        {
            id: 'generate-password-simple',
            title: '简单密码',
            description: '生成8位简单密码（无特殊字符）',
            icon: '🔒',
            type: 'builtin',
            category: '密码生成',
            priority: 1
        },
        {
            id: 'generate-password-strong',
            title: '强密码',
            description: '生成16位强密码（包含特殊字符）',
            icon: '🔐',
            type: 'builtin',
            category: '密码生成',
            priority: 2
        },
        {
            id: 'generate-password-ultra',
            title: '超强密码',
            description: '生成24位超强密码',
            icon: '🛡️',
            type: 'builtin',
            category: '密码生成',
            priority: 3
        },
        {
            id: 'current-time',
            title: '当前时间',
            description: '获取当前时间并复制到剪贴板',
            icon: '🕐',
            type: 'builtin',
            category: '时间工具',
            priority: 4
        },
        {
            id: 'timestamp',
            title: '时间戳',
            description: '获取当前时间戳并复制到剪贴板',
            icon: '⏱️',
            type: 'builtin',
            category: '时间工具',
            priority: 5
        },
        {
            id: 'uuid',
            title: 'UUID',
            description: '生成UUID并复制到剪贴板',
            icon: '🆔',
            type: 'builtin',
            category: '生成工具',
            priority: 6
        },
        {
            id: 'open-terminal',
            title: '终端打开',
            description: '在终端中打开剪贴板路径（文件将打开其所在目录）',
            icon: '🖥️',
            type: 'builtin',
            category: '系统工具',
            priority: 7
        },
        {
            id: 'open-clock',
            title: '时钟',
            description: '打开置顶时钟小窗',
            icon: '🕒',
            type: 'builtin',
            category: '系统工具',
            priority: 8
        },
        {
            id: 'open-image',
            title: '图片',
            description: '预览剪贴板图片路径，或选择图片打开',
            icon: '🖼️',
            type: 'builtin',
            category: '系统工具',
            priority: 9
        },
        {
            id: 'screenshot',
            title: '截图',
            description: '调用系统截图并将结果写入剪贴板',
            icon: '✂️',
            type: 'builtin',
            category: '系统工具',
            priority: 10
        }
    ];
}

// 获取动态超级面板功能（基于剪贴板内容）
async function getDynamicSuperPanelActions(clipboardText) {
    const dynamicActions = [];

    if (!clipboardText || clipboardText.trim() === '') {
        return dynamicActions;
    }

    const text = clipboardText.trim();

    try {
        const cleanPath = normalizeClipboardPath(text);
        if (cleanPath && path.isAbsolute(cleanPath) && fs.existsSync(cleanPath)) {
            const stat = fs.statSync(cleanPath);
            if (stat.isDirectory()) {
                dynamicActions.push({
                    id: 'open-terminal-dir-' + Date.now(),
                    title: '终端打开',
                    description: '在终端中打开该文件夹',
                    icon: '🖥️',
                    type: 'dynamic',
                    category: '文件夹操作',
                    command: 'open-terminal',
                    args: { path: cleanPath },
                    priority: 1
                });
                dynamicActions.push({
                    id: 'open-folder-' + Date.now(),
                    title: '打开目录',
                    description: '在资源管理器中打开该文件夹',
                    icon: '📁',
                    type: 'dynamic',
                    category: '文件夹操作',
                    command: 'open-path',
                    args: { path: cleanPath },
                    priority: 2
                });
            } else {
                dynamicActions.push({
                    id: 'open-file-' + Date.now(),
                    title: '打开文件',
                    description: '使用系统默认方式打开该文件',
                    icon: '📄',
                    type: 'dynamic',
                    category: '文件操作',
                    command: 'open-path',
                    args: { path: cleanPath },
                    priority: 1
                });
                dynamicActions.push({
                    id: 'reveal-file-' + Date.now(),
                    title: '定位文件',
                    description: '在资源管理器中定位该文件',
                    icon: '📌',
                    type: 'dynamic',
                    category: '文件操作',
                    command: 'reveal-path',
                    args: { path: cleanPath },
                    priority: 2
                });
                dynamicActions.push({
                    id: 'open-terminal-file-' + Date.now(),
                    title: '终端目录',
                    description: '在终端中打开该文件所在目录',
                    icon: '🖥️',
                    type: 'dynamic',
                    category: '文件操作',
                    command: 'open-terminal',
                    args: { path: cleanPath },
                    priority: 3
                });
                if (isImageFilePath(cleanPath)) {
                    dynamicActions.push({
                        id: 'preview-image-' + Date.now(),
                        title: '预览图片',
                        description: '在小窗中预览该图片',
                        icon: '🖼️',
                        type: 'dynamic',
                        category: '图片操作',
                        command: 'open-image-preview',
                        args: { path: cleanPath },
                        priority: 0
                    });
                }
            }
        }
    } catch (_) { }

    // URL 检测
    if (text.match(/^https?:\/\/.+/)) {
        dynamicActions.push({
            id: 'open-url-' + Date.now(),
            title: '打开链接',
            description: `在浏览器中打开该URL`,
            icon: '🔗',
            type: 'dynamic',
            category: '链接操作',
            command: 'open-url',
            args: { url: text },
            priority: 1
        });
    }

    // 邮箱检测
    if (text.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
        dynamicActions.push({
            id: 'send-email-' + Date.now(),
            title: '发送邮件',
            description: '发送邮件到该地址',
            icon: '📧',
            type: 'dynamic',
            category: '邮件操作',
            command: 'send-email',
            args: { email: text },
            priority: 2
        });
    }

    // 数字检测（计算器）
    if (text.match(/^[\d\+\-\*\/\.\(\)\s]+$/)) {
        dynamicActions.push({
            id: 'calculate-' + Date.now(),
            title: '计算式',
            description: `计算 ${text}`,
            icon: '🧮',
            type: 'dynamic',
            category: '计算工具',
            command: 'calculate',
            args: { expression: text },
            priority: 3
        });
    }

    // 中文文本检测（翻译）
    if (/[\u4e00-\u9fa5]/.test(text)) {
        dynamicActions.push({
            id: 'translate-zh-en-' + Date.now(),
            title: '译成英文',
            description: '翻译剪贴板中的中文文本到英文',
            icon: '🌍',
            type: 'dynamic',
            category: '翻译工具',
            command: 'translate',
            args: { text: text, from: 'zh', to: 'en' },
            priority: 4
        });
    }

    // 英文文本检测（翻译）
    if (/^[a-zA-Z\s.,!?'\"]+$/.test(text)) {
        dynamicActions.push({
            id: 'translate-en-zh-' + Date.now(),
            title: '译成中文',
            description: '翻译剪贴板中的英文文本到中文',
            icon: '🌏',
            type: 'dynamic',
            category: '翻译工具',
            command: 'translate',
            args: { text: text, from: 'en', to: 'zh' },
            priority: 5
        });
    }

    const pluginMatches = [];
    for (const [pluginName, actions] of superPanelRegistry) {
        for (const action of actions) {
            if (!action || !action.feature) continue;
            let score = calculateMatchScore(text, action.feature);
            if (action.title && text.includes(action.title.toLowerCase())) score += 6;
            if (action.description && text.includes(action.description.toLowerCase())) score += 3;
            if (score > 0) {
                pluginMatches.push({ action, score, pluginName });
            }
        }
    }

    if (pluginMatches.length > 0) {
        pluginMatches.sort((a, b) => b.score - a.score);
        const topPlugins = pluginMatches.slice(0, 6);
        topPlugins.forEach(item => {
            dynamicActions.push({
                ...item.action,
                priority: Math.min(item.action.priority || 10, 1)
            });
        });
    }

    // 搜索功能（对所有文本）
    dynamicActions.push({
        id: 'search-web-' + Date.now(),
        title: '网页搜索',
        description: `搜索 "${text.length > 20 ? text.substring(0, 20) + '...' : text}"`,
        icon: '🔍',
        type: 'dynamic',
        category: '搜索工具',
        command: 'search-web',
        args: { query: text },
        priority: 10
    });

    dynamicActions.push({
        id: 'search-bing-' + Date.now(),
        title: '必应搜索',
        description: `在Bing搜索 "${text.length > 20 ? text.substring(0, 20) + '...' : text}"`,
        icon: '🧭',
        type: 'dynamic',
        category: '搜索工具',
        command: 'search-bing',
        args: { query: text },
        priority: 11
    });

    dynamicActions.push({
        id: 'search-baidu-' + Date.now(),
        title: '百度搜索',
        description: `在百度搜索 "${text.length > 20 ? text.substring(0, 20) + '...' : text}"`,
        icon: '🔎',
        type: 'dynamic',
        category: '搜索工具',
        command: 'search-baidu',
        args: { query: text },
        priority: 12
    });

    return dynamicActions;
}

// 删除重复定义

// 删除重复定义

// 生成随机密码
function generateRandomPassword(length = 12, options = {}) {
    const defaults = {
        includeNumbers: true,
        includeLowercase: true,
        includeUppercase: true,
        includeSymbols: true
    };
    const settings = { ...defaults, ...options };

    let charset = '';
    if (settings.includeNumbers) charset += '0123456789';
    if (settings.includeLowercase) charset += 'abcdefghijklmnopqrstuvwxyz';
    if (settings.includeUppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (settings.includeSymbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';

    if (!charset) return '';

    let password = '';
    for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
    }

    return password;
}

// 创建添加插件功能对话框的HTML内容
function createAddPluginDialogHtml() {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>添加功能到超级面板</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
            background: rgba(40, 44, 52, 0.95);
            color: #ffffff;
            user-select: none;
            overflow: hidden;
            border-radius: 12px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .dialog-header {
            padding: 8px 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .dialog-title {
            font-size: 12px;
            font-weight: 500;
            color: #ffffff;
        }
        
        .close-btn {
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.7);
            font-size: 16px;
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            transition: all 0.2s ease;
        }
        
        .close-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #ffffff;
        }
        
        .tabs {
            display: flex;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.05);
        }
        
        .tab {
            padding: 6px 12px;
            cursor: pointer;
            transition: all 0.2s ease;
            font-size: 12px;
            color: rgba(255, 255, 255, 0.7);
            border-bottom: 2px solid transparent;
        }
        
        .tab:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #ffffff;
        }
        
        .tab.active {
            color: #60a5fa;
            border-bottom-color: #60a5fa;
        }
        
        .dialog-content {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
        }
        
        .tab-content {
            display: none;
        }
        
        .tab-content.active {
            display: block;
        }
        
        .plugins-list, .builtin-list, .custom-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 16px;
        }
        
        .feature-card, .plugin-card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 16px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: all 0.2s ease;
            cursor: pointer;
        }
        
        .feature-card:hover, .plugin-card:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(96, 165, 250, 0.5);
        }
        
        .feature-header {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .feature-icon {
            font-size: 20px;
            margin-right: 10px;
        }
        
        .plugin-name, .feature-name {
            font-size: 14px;
            font-weight: 500;
            color: #ffffff;
            margin-bottom: 8px;
        }
        
        .feature-description {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.7);
            margin-bottom: 10px;
        }
        
        .feature-meta {
            font-size: 11px;
            color: rgba(255, 255, 255, 0.5);
        }
        
        .plugin-features {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        
        .feature-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.03);
            transition: all 0.2s ease;
        }
        
        .feature-item:hover {
            background: rgba(96, 165, 250, 0.1);
        }
        
        .feature-checkbox {
            margin-right: 8px;
        }
        
        .dialog-footer {
            padding: 16px 20px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.05);
            display: flex;
            justify-content: flex-end;
            gap: 12px;
        }
        
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .btn-cancel {
            background: rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.8);
        }
        
        .btn-cancel:hover {
            background: rgba(255, 255, 255, 0.2);
        }
        
        .btn-save {
            background: #60a5fa;
            color: #ffffff;
        }
        
        .btn-save:hover {
            background: #3b82f6;
        }
        
        .loading-spinner {
            display: inline-block;
            width: 24px;
            height: 24px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: #60a5fa;
            animation: spin 1s ease-in-out infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: rgba(255, 255, 255, 0.6);
        }
        
        .empty-icon {
            font-size: 32px;
            margin-bottom: 16px;
            opacity: 0.3;
        }
        
        .empty-title {
            font-size: 14px;
            margin-bottom: 8px;
            color: rgba(255, 255, 255, 0.8);
        }
    </style>
</head>
<body>
    <div class="dialog-header">
        <div class="dialog-title">添加功能到超级面板</div>
        <button class="close-btn" onclick="closeDialog()">✕</button>
    </div>
    
    <div class="tabs">
        <div class="tab active" data-tab="plugins" onclick="switchTab('plugins')">🔌 插件功能</div>
        <div class="tab" data-tab="builtin" onclick="switchTab('builtin')">⚙️ 内置功能</div>
        <div class="tab" data-tab="custom" onclick="switchTab('custom')">🎨 自定义功能</div>
    </div>
    
    <div class="dialog-content">
        <!-- 插件功能选项卡 -->
        <div class="tab-content active" id="tab-plugins">
            <div class="plugins-list" id="plugins-list">
                <div class="empty-state">
                    <div class="loading-spinner"></div>
                    <div class="empty-title">正在加载插件功能...</div>
                </div>
            </div>
        </div>
        
        <!-- 内置功能选项卡 -->
        <div class="tab-content" id="tab-builtin">
            <div class="builtin-list" id="builtin-list">
                <div class="empty-state">
                    <div class="loading-spinner"></div>
                    <div class="empty-title">正在加载内置功能...</div>
                </div>
            </div>
        </div>
        
        <!-- 自定义功能选项卡 -->
        <div class="tab-content" id="tab-custom">
            <div class="custom-list" id="custom-list">
                <div class="empty-state">
                    <div class="loading-spinner"></div>
                    <div class="empty-title">正在加载自定义功能...</div>
                </div>
            </div>
        </div>
    </div>
    
    <div class="dialog-footer">
        <button class="btn btn-cancel" onclick="closeDialog()">取消</button>
        <button class="btn btn-save" onclick="saveSelectedFeatures()">保存</button>
    </div>

    <script>
        const { ipcRenderer } = require('electron');
        
        let plugins = [];
        let builtinFeatures = [];
        let customFeatures = [];
        let selectedFeatures = new Set();
        let activeTabName = 'plugins';
        
        // 初始化对话框
        async function initDialog() {
            try {
                // 1. 加载插件功能
                loadPluginFeatures();
                
                // 2. 加载内置功能
                loadBuiltinFeatures();
                
                // 3. 加载自定义功能
                loadCustomFeatures();
                
            } catch (error) {
                console.error('初始化对话框失败:', error);
                showError('初始化失败: ' + error.message);
            }
        }
        
        // 加载插件功能
        async function loadPluginFeatures() {
            try {
                plugins = await ipcRenderer.invoke('get-plugin-list');
                console.log('获取到插件列表:', plugins);
                renderPluginsList();
            } catch (error) {
                console.error('加载插件功能失败:', error);
                document.getElementById('plugins-list').innerHTML = 
                    '<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">加载插件列表失败</div></div>';
            }
        }
        
        // 加载内置功能
        async function loadBuiltinFeatures() {
            try {
                // 获取所有内置功能
                const allFeatures = await ipcRenderer.invoke('get-builtin-actions');
                
                // 获取当前已启用的功能ID
                const activeFeatures = await ipcRenderer.invoke('get-active-action-ids');
                
                // 筛选出未启用的内置功能
                builtinFeatures = allFeatures.filter(feature => 
                    feature.type === 'builtin' && !activeFeatures.includes(feature.id)
                );
                
                console.log('可添加的内置功能:', builtinFeatures);
                renderBuiltinList();
            } catch (error) {
                console.error('加载内置功能失败:', error);
                document.getElementById('builtin-list').innerHTML = 
                    '<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">加载内置功能失败</div></div>';
            }
        }
        
        // 加载自定义功能
        async function loadCustomFeatures() {
            try {
                // 获取所有可用的自定义功能
                const availableCustomFeatures = await ipcRenderer.invoke('get-available-custom-actions');
                customFeatures = availableCustomFeatures || [];
                
                console.log('可添加的自定义功能:', customFeatures);
                renderCustomList();
            } catch (error) {
                console.error('加载自定义功能失败:', error);
                document.getElementById('custom-list').innerHTML = 
                    '<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">加载自定义功能失败</div></div>';
            }
        }
        
        // 渲染插件列表
        // 函数级注释：为避免在内联事件参数中使用 Windows 路径时出现反斜杠转义问题，
        // 在渲染阶段对插件路径进行 URL 编码，事件处理函数内部再解码。
        function renderPluginsList() {
            const container = document.getElementById('plugins-list');
            
            if (!plugins || plugins.length === 0) {
                container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">未找到插件</div></div>';
                return;
            }
            
            container.innerHTML = '';
            
            plugins.forEach(plugin => {
                const features = Array.isArray(plugin.features) ? plugin.features : [];
                const safePath = encodeURIComponent(plugin.path);
                
                const pluginDiv = document.createElement('div');
                pluginDiv.className = 'plugin-card';
                
                pluginDiv.innerHTML = \`
                    <div class="plugin-name">\${plugin.name || '未知插件'}</div>
                    <div class="feature-meta">可添加 \${features.length} 个功能</div>
                    <div class="plugin-features" style="margin-top: 10px;">
                        \${features.map(feature => \`
                            <div class="feature-item" style="padding: 6px; display: flex; align-items: center;">
                            <input type="checkbox" class="feature-checkbox" 
                                       id="feature-\${safePath}-\${feature.code}" 
                                       onchange="togglePluginFeature('\${safePath}', '\${feature.code}')">
                            <span style="font-size: 12px;">\${feature.explain || feature.code}</span>
                            </div>
                        \`).join('')}
                    </div>
                \`;
                
                container.appendChild(pluginDiv);
            });
        }
        
        // 渲染内置功能列表
        function renderBuiltinList() {
            const container = document.getElementById('builtin-list');
            
            if (!builtinFeatures || builtinFeatures.length === 0) {
                container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">所有内置功能已添加</div></div>';
                return;
            }
            
            container.innerHTML = '';
            
            builtinFeatures.forEach(feature => {
                const featureDiv = document.createElement('div');
                featureDiv.className = 'feature-card';
                
                featureDiv.innerHTML = \`
                    <div class="feature-header">
                        <div class="feature-icon">\${feature.icon || '⚙️'}</div>
                        <div class="feature-name">\${feature.title}</div>
                    </div>
                    <div class="feature-description">\${feature.description || '无描述'}</div>
                    <div class="feature-meta">
                        <input type="checkbox" class="feature-checkbox" 
                               id="builtin-\${feature.id}" 
                               onchange="toggleBuiltinFeature('\${feature.id}')">
                        <label for="builtin-\${feature.id}">添加此功能</label>
                    </div>
                \`;
                
                container.appendChild(featureDiv);
            });
        }
        
        // 渲染自定义功能列表
        function renderCustomList() {
            const container = document.getElementById('custom-list');
            
            if (!customFeatures || customFeatures.length === 0) {
                container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">暂无可添加的自定义功能</div></div>';
                return;
            }
            
            container.innerHTML = '';
            
            customFeatures.forEach(feature => {
                const featureDiv = document.createElement('div');
                featureDiv.className = 'feature-card';
                
                featureDiv.innerHTML = \`
                    <div class="feature-header">
                        <div class="feature-icon">\${feature.icon || '🎨'}</div>
                        <div class="feature-name">\${feature.title}</div>
                    </div>
                    <div class="feature-description">\${feature.description || '无描述'}</div>
                    <div class="feature-meta">
                        <input type="checkbox" class="feature-checkbox" 
                               id="custom-\${feature.id}" 
                               onchange="toggleCustomFeature('\${feature.id}')">
                        <label for="custom-\${feature.id}">添加此功能</label>
                    </div>
                \`;
                
                container.appendChild(featureDiv);
            });
        }
        
        // 切换选项卡
        function switchTab(tabName) {
            // 更新标签页状态
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
            });
            
            // 更新内容区域
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById('tab-' + tabName).classList.add('active');
            
            // 记录当前选项卡
            activeTabName = tabName;
        }
        
        // 切换插件功能选择状态
        // 函数级注释：接收已编码的插件路径，避免反斜杠在内联事件中被错误转义；
        // 在此函数内对路径进行解码后再写入选择集合，同时用编码值定位复选框。
        function togglePluginFeature(encodedPluginPath, featureCode) {
            const pluginPath = decodeURIComponent(encodedPluginPath);
            const featureId = \`plugin|\${pluginPath}|\${featureCode}\`;
            const checkbox = document.getElementById(\`feature-\${encodedPluginPath}-\${featureCode}\`);
            if (!checkbox) return;
            if (checkbox.checked) {
                selectedFeatures.add(featureId);
            } else {
                selectedFeatures.delete(featureId);
            }
        }
        
        // 切换内置功能选择状态
        function toggleBuiltinFeature(featureId) {
            const fullId = \`builtin:\${featureId}\`;
            const checkbox = document.getElementById(\`builtin-\${featureId}\`);
            
            if (selectedFeatures.has(fullId)) {
                selectedFeatures.delete(fullId);
                checkbox.checked = false;
            } else {
                selectedFeatures.add(fullId);
                checkbox.checked = true;
            }
        }
        
        // 切换自定义功能选择状态
        function toggleCustomFeature(featureId) {
            const fullId = \`custom:\${featureId}\`;
            const checkbox = document.getElementById(\`custom-\${featureId}\`);
            
            if (selectedFeatures.has(fullId)) {
                selectedFeatures.delete(fullId);
                checkbox.checked = false;
            } else {
                selectedFeatures.add(fullId);
                checkbox.checked = true;
            }
        }
        
        // 保存选中的功能
        async function saveSelectedFeatures() {
            try {
                // 将选中的功能转换为适当的格式
                const features = [];
                
                for (const featureId of selectedFeatures) {
                    const isPlugin = featureId.startsWith('plugin|');
                    const [type, ...rest] = isPlugin ? featureId.split('|') : featureId.split(':');
                    
                    if (type === 'plugin') {
                        const featureCode = rest[rest.length - 1];
                        const pluginPath = isPlugin ? rest.slice(0, -1).join('|') : rest.slice(0, -1).join(':');
                        const plugin = plugins.find(p => p.path === pluginPath);
                        const feature = Array.isArray(plugin?.features) ? plugin.features.find(f => f.code === featureCode) : null;
                        
                        if (plugin && feature) {
                            features.push({
                                id: \`plugin-\${plugin.name}-\${featureCode}\`,
                                title: feature.explain || featureCode,
                                description: \`使用 \${plugin.name} 处理内容\`,
                                icon: getPluginIcon(plugin.name),
                                type: 'plugin',
                                category: '插件功能',
                                pluginPath: pluginPath,
                                feature: feature
                            });
                        }
                    } 
                    else if (type === 'builtin') {
                        const builtinId = rest.join(':');
                        const feature = builtinFeatures.find(f => f.id === builtinId);
                        
                        if (feature) {
                            features.push(feature);
                        }
                    }
                    else if (type === 'custom') {
                        const customId = rest.join(':');
                        const feature = customFeatures.find(f => f.id === customId);
                        
                        if (feature) {
                            features.push(feature);
                        }
                    }
                }
                
                if (features.length === 0) {
                    alert('请至少选择一个功能');
                    return;
                }
                
                // 保存到自定义功能配置
                const success = await ipcRenderer.invoke('add-features-to-super-panel', features);
                
                if (success) {
                    alert(\`成功添加 \${features.length} 个功能到超级面板\`);
                    closeDialog();
                } else {
                    alert('保存失败');
                }
                
            } catch (error) {
                console.error('保存功能失败:', error);
                alert('保存失败: ' + error.message);
            }
        }
        
        // 获取插件图标
        function getPluginIcon(pluginName) {
            const iconMap = {
                'sanrenjz-tools-password': '🔐',
                'sanrenjz-tools-text': '📝',
                'sanrenjz-tools-download': '⬇️',
                'sanrenjz.tools-ai': '🤖',
                '余汉波文本片段助手': '📝',
                '密码管理器': '🔐',
                '插件下载': '📦',
                '余汉波AI助手': '🤖'
            };
            return iconMap[pluginName] || '🔧';
        }
        
        // 显示错误信息
        function showError(message) {
            document.querySelectorAll('.tab-content').forEach(content => {
                content.innerHTML = \`
                    <div class="empty-state">
                        <div class="empty-icon">❌</div>
                        <div class="empty-title">\${message}</div>
                    </div>
                \`;
            });
        }
        
        // 关闭对话框
        function closeDialog() {
            ipcRenderer.invoke('close-current-window');
        }
        
        // 窗口加载完成后初始化
        window.addEventListener('DOMContentLoaded', () => {
            initDialog();
        });
    </script>
</body>
</html>
    `;
}

// 添加 IPC 处理：关闭当前窗口
ipcMain.handle('close-current-window', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
        window.close();
    }
});



// 运行插件功能
// 函数级注释：
// - 将剪贴板文本以 actionContext 传递给插件，从而支持 "over" 模式
// - 当 feature.args.quickCommand 存在时，向插件窗口注入 pendingQuickCommand 与 pendingText，
//   以便 AI 插件在打开后自动应用指定快捷指令
// - 保持对其它插件通用的执行路径；若插件管理器不可用则返回错误
async function runPluginAction(pluginPath, feature, clipboardText) {
    try {
        if (!pluginManager) {
            console.error('插件管理器未初始化');
            return { success: false, error: '插件管理器未初始化' };
        }

        // 先确保插件窗口已创建
        const pluginJsonPath = path.join(pluginPath, 'plugin.json');
        if (!fs.existsSync(pluginJsonPath)) {
            return { success: false, error: `插件配置文件不存在: ${pluginJsonPath}` };
        }
        const pluginConfig = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
        const configuredFeature = Array.isArray(pluginConfig.features)
            ? pluginConfig.features.find(item => item.code === feature.code)
            : null;
        const startHidden = configuredFeature?.startHidden === true;
        const pluginWindow = await pluginManager.createPluginWindow(pluginPath, pluginConfig, { startHidden });
        if (startHidden && pluginWindow && !pluginWindow.isDestroyed()) pluginWindow.hide();
        // 新建窗口需要等待 DOM 初始化；复用已打开窗口时必须立即继续，
        // 否则等待一个不会再次触发的 dom-ready 会让第二次总指挥派发永久卡住。
        await waitForPluginWindowReady(pluginWindow.webContents);

        // 构造上下文对象并安全序列化
        const actionContext = {
            type: 'over',
            payload: clipboardText || '',
            featureArgs: feature?.args || null
        };
        const ctxJson = JSON.stringify(actionContext);

        // 在插件窗口中执行功能
        const execScript = `(() => {
            try {
                const actionCtx = ${ctxJson};
                // 注入待处理文本和快捷指令（供 AI 插件使用）
                try {
                    if (actionCtx && typeof actionCtx.payload === 'string') {
                        window.pendingText = actionCtx.payload;
                    }
                    if (actionCtx && actionCtx.featureArgs && actionCtx.featureArgs.quickCommand) {
                        window.pendingQuickCommand = actionCtx.featureArgs.quickCommand;
                    }
                } catch (_) {}

                if (typeof window.exports === 'object' && window.exports && window.exports['${feature.code}']) {
                    const featureHandler = window.exports['${feature.code}'];
                    if (featureHandler && featureHandler.args && typeof featureHandler.args.enter === 'function') {
                        if (featureHandler.mode === 'list') {
                            featureHandler.args.enter(actionCtx, function(items){
                                console.log('列表项数量:', Array.isArray(items) ? items.length : 0);
                            });
                            return { success: true, message: '插件功能已启动(列表模式)' };
                        }
                        featureHandler.args.enter(actionCtx);
                        return { success: true, message: '插件功能已执行' };
                    }
                    return { success: false, error: '未找到可执行的功能入口' };
                }
                return { success: false, error: '插件未导出指定功能: ${feature.code}' };
            } catch (e) {
                return { success: false, error: e.message };
            }
        })();`;

        const result = await pluginWindow.webContents.executeJavaScript(execScript);
        return result || { success: true };
    } catch (error) {
        console.error('运行插件功能失败:', error);
        return { success: false, error: error.message };
    }
}

// 执行系统命令
async function executeSystemCommand(command, args, clipboardText) {
    try {
        const { shell } = require('electron');

        switch (command) {
            case 'open-app':
                if (args.app) {
                    const { exec } = require('child_process');
                    exec(args.app, (error) => {
                        if (error) {
                            console.error('打开应用失败:', error);
                        }
                    });
                    return { success: true };
                }
                break;

            case 'open-url':
                if (args.url || clipboardText) {
                    await shell.openExternal(args.url || clipboardText);
                    return { success: true };
                }
                break;

            case 'search-web':
                if (args.query || clipboardText) {
                    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query || clipboardText)}`;
                    await shell.openExternal(searchUrl);
                    return { success: true };
                }
                break;

            case 'send-email':
                if (args.email || clipboardText) {
                    const emailUrl = `mailto:${args.email || clipboardText}`;
                    await shell.openExternal(emailUrl);
                    return { success: true };
                }
                break;

            case 'open-path': {
                const target = normalizeClipboardPath(args.path || clipboardText);
                if (!target) {
                    return { success: false, error: '缺少必要参数' };
                }
                await shell.openPath(target);
                return { success: true };
            }

            case 'reveal-path': {
                const target = normalizeClipboardPath(args.path || clipboardText);
                if (!target) {
                    return { success: false, error: '缺少必要参数' };
                }
                shell.showItemInFolder(target);
                return { success: true };
            }

            case 'open-terminal': {
                const targetDir = resolveDirectoryFromPathMaybeFile(args.path || clipboardText);
                const result = openTerminalAtDirectory(targetDir);
                return result;
            }

            case 'screenclip': {
                if (process.platform !== 'win32') {
                    return { success: false, error: '当前系统不支持该截图方式' };
                }
                try {
                    await shell.openExternal('ms-screenclip:');
                } catch (_) {
                    try {
                        exec('snippingtool.exe', () => { });
                    } catch (error) {
                        return { success: false, error: error.message };
                    }
                }
                return { success: true };
            }

            case 'open-clock': {
                return openClockWindow();
            }

            case 'open-image': {
                const target = normalizeClipboardPath(args.path || clipboardText);
                if (target && isImageFilePath(target) && path.isAbsolute(target) && fs.existsSync(target)) {
                    return openImagePreviewWindow(target);
                }
                return await pickImageAndOpenPreview(superPanelWindow || mainWindow);
            }

            default:
                console.log('未知的系统命令:', command);
                return { success: false, error: '未知的系统命令' };
        }

        return { success: false, error: '缺少必要参数' };
    } catch (error) {
        console.error('执行系统命令失败:', error);
        return { success: false, error: error.message };
    }
}

// 创建超级面板管理器窗口
function createSuperPanelManagerWindow() {
    // 获取鼠标位置并计算窗口显示位置
    let windowOptions = {
        width: 800,
        height: 600,
        modal: true,
        parent: superPanelWindow || mainWindow,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        frame: false,
        resizable: true,
        transparent: true,
        alwaysOnTop: false,
        movable: true
    };

    try {
        // 获取鼠标位置并在鼠标所在的屏幕显示窗口
        const cursorPoint = screen.getCursorScreenPoint();
        const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

        // 计算窗口位置，在屏幕中央显示
        let x = currentDisplay.workArea.x + Math.round((currentDisplay.workArea.width - 800) / 2);
        let y = currentDisplay.workArea.y + Math.round((currentDisplay.workArea.height - 600) / 2);

        // 边界检查
        if (x < currentDisplay.workArea.x) x = currentDisplay.workArea.x + 10;
        if (x + 800 > currentDisplay.workArea.x + currentDisplay.workArea.width) {
            x = currentDisplay.workArea.x + currentDisplay.workArea.width - 800 - 10;
        }
        if (y < currentDisplay.workArea.y) y = currentDisplay.workArea.y + 10;
        if (y + 600 > currentDisplay.workArea.y + currentDisplay.workArea.height) {
            y = currentDisplay.workArea.y + currentDisplay.workArea.height - 600 - 10;
        }

        windowOptions.x = x;
        windowOptions.y = y;
        console.log(`管理器窗口将在屏幕 ${currentDisplay.id} 显示，位置: (${x}, ${y})`);
    } catch (error) {
        console.error('设置管理器窗口位置失败，使用默认位置:', error);
    }

    const managerWindow = new BrowserWindow(windowOptions);
    trackSuperPanelChildWindow(managerWindow);

    // 启用remote模块
    if (remoteMain) {
        remoteMain.enable(managerWindow.webContents);
    }

    // 创建管理器的HTML内容
    const managerHtml = createSuperPanelManagerHtml();
    managerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(managerHtml)}`);

    managerWindow.on('closed', () => {
        // 窗口关闭后的清理工作
    });

    return managerWindow;
}

// 创建超级面板设置窗口
function createSuperPanelSettingsWindow() {
    // 获取鼠标位置并计算窗口显示位置
    let windowOptions = {
        width: 600,
        height: 500,
        modal: true,
        parent: superPanelWindow || mainWindow,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true
        },
        frame: false,
        resizable: true,
        transparent: true,
        alwaysOnTop: false,
        movable: true
    };

    try {
        // 获取鼠标位置并在鼠标所在的屏幕显示窗口
        const { screen } = require('electron');
        const cursorPoint = screen.getCursorScreenPoint();
        const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);

        // 计算窗口位置，在屏幕中央显示
        let x = currentDisplay.workArea.x + Math.round((currentDisplay.workArea.width - 600) / 2);
        let y = currentDisplay.workArea.y + Math.round((currentDisplay.workArea.height - 500) / 2);

        // 边界检查
        if (x < currentDisplay.workArea.x) x = currentDisplay.workArea.x + 10;
        if (x + 600 > currentDisplay.workArea.x + currentDisplay.workArea.width) {
            x = currentDisplay.workArea.x + currentDisplay.workArea.width - 600 - 10;
        }
        if (y < currentDisplay.workArea.y) y = currentDisplay.workArea.y + 10;
        if (y + 500 > currentDisplay.workArea.y + currentDisplay.workArea.height) {
            y = currentDisplay.workArea.y + currentDisplay.workArea.height - 500 - 10;
        }

        windowOptions.x = x;
        windowOptions.y = y;
        console.log(`设置窗口将在屏幕 ${currentDisplay.id} 显示，位置: (${x}, ${y})`);
    } catch (error) {
        console.error('设置窗口位置失败，使用默认位置:', error);
    }

    const settingsWindow = new BrowserWindow(windowOptions);
    trackSuperPanelChildWindow(settingsWindow);

    // 启用remote模块
    if (remoteMain) {
        remoteMain.enable(settingsWindow.webContents);
    }

    // 创建设置界面的HTML内容
    const settingsHtml = createSuperPanelSettingsHtml();
    settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(settingsHtml)}`);

    settingsWindow.on('closed', () => {
        // 窗口关闭后的清理工作
    });

    return settingsWindow;
}

// 创建超级面板管理器的HTML内容
function createSuperPanelManagerHtml() {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>超级面板管理器</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
            background: rgba(40, 44, 52, 0.95);
            color: #ffffff;
            user-select: none;
            border-radius: 12px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .manager-header {
            padding: 16px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
            justify-content: space-between;
            -webkit-app-region: drag; /* 允许拖拽窗口 */
        }
        
        .manager-header button {
            -webkit-app-region: no-drag; /* 按钮区域不可拖拽 */
        }
        
        .manager-title {
            font-size: 16px;
            font-weight: 500;
            color: #ffffff;
        }
        
        .header-buttons {
            display: flex;
            gap: 8px;
        }
        
        .header-btn {
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: rgba(255, 255, 255, 0.8);
            font-size: 12px;
            cursor: pointer;
            padding: 6px 12px;
            border-radius: 4px;
            transition: all 0.2s ease;
        }
        
        .header-btn:hover {
            background: rgba(96, 165, 250, 0.2);
            color: #60a5fa;
        }
        
        .manager-content {
            flex: 1;
            display: flex;
            overflow: hidden;
        }
        
        .sidebar {
            width: 200px;
            background: rgba(255, 255, 255, 0.03);
            border-right: 1px solid rgba(255, 255, 255, 0.1);
            padding: 16px;
        }
        
        .category-item {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s ease;
            margin-bottom: 4px;
            font-size: 13px;
        }
        
        .category-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }
        
        .category-item.active {
            background: rgba(96, 165, 250, 0.2);
            color: #60a5fa;
        }
        
        .main-content {
            flex: 1;
            padding: 20px;
            overflow-y: auto;
        }
        
        .actions-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 16px;
        }
        
        .action-card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 16px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: all 0.2s ease;
            position: relative;
        }
        
        .action-card:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(96, 165, 250, 0.5);
        }
        
        .action-card.active {
            background: rgba(96, 165, 250, 0.1);
            border-color: rgba(96, 165, 250, 0.5);
        }
        
        .action-status {
            position: absolute;
            top: 8px;
            right: 8px;
            font-size: 12px;
            border-radius: 4px;
            padding: 2px 6px;
        }
        
        .action-status.active {
            background: rgba(52, 211, 153, 0.2);
            color: #34d399;
        }
        
        .action-status.inactive {
            background: rgba(239, 68, 68, 0.2);
            color: #ef4444;
            cursor: pointer;
        }
        
        .action-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
        }
        
        .action-icon {
            font-size: 20px;
            margin-right: 8px;
            width: 20px;
            height: 20px;
            display: inline-block;
            vertical-align: middle;
        }
        
        .action-title {
            font-size: 14px;
            font-weight: 500;
            color: #ffffff;
            flex: 1;
        }
        
        .action-menu {
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.6);
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            font-size: 12px;
        }
        
        .action-menu:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #ffffff;
        }
        
        .action-description {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.7);
            margin-bottom: 12px;
            line-height: 1.4;
        }
        
        .action-meta {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: rgba(255, 255, 255, 0.5);
        }
        
        .action-type {
            background: rgba(96, 165, 250, 0.2);
            color: #60a5fa;
            padding: 2px 6px;
            border-radius: 3px;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: rgba(255, 255, 255, 0.6);
        }
        
        .empty-icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.3;
        }
        
        .empty-title {
            font-size: 16px;
            margin-bottom: 8px;
            color: rgba(255, 255, 255, 0.8);
        }
        
        .delete-btn {
            position: absolute;
            top: 10px;
            right: 10px;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            background: rgba(239, 68, 68, 0.8);
            color: white;
            border: none;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            opacity: 0;
            transition: opacity 0.2s ease;
        }
        
        .action-card:hover .delete-btn {
            opacity: 1;
        }
        
        .delete-btn:hover {
            background: #ef4444;
            transform: scale(1.1);
        }
        
        .loading-spinner {
            display: inline-block;
            width: 24px;
            height: 24px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            border-top-color: #60a5fa;
            animation: spin 1s ease-in-out infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="manager-header">
        <div class="manager-title">超级面板管理器</div>
        <div class="header-buttons">
            <button class="header-btn" onclick="addNewAction()">➕ 添加功能</button>
            <button class="header-btn" onclick="importActions()">📥 导入</button>
            <button class="header-btn" onclick="exportActions()">📤 导出</button>
            <button class="header-btn" onclick="closeManager()">✕</button>
        </div>
    </div>
    
    <div class="manager-content">
        <div class="sidebar">
            <div class="category-item active" onclick="filterByCategory('all')">
                🔧 全部功能
            </div>
            <div class="category-item" onclick="filterByCategory('builtin')">
                ⚙️ 内置功能
            </div>
            <div class="category-item" onclick="filterByCategory('custom')">
                🎨 自定义功能
            </div>
            <div class="category-item" onclick="filterByCategory('plugin')">
                🔌 插件功能
            </div>
            <div class="category-item" onclick="filterByCategory('dynamic')">
                ⚡ 动态功能
            </div>
        </div>
        
        <div class="main-content">
            <div class="actions-list" id="actions-list">
                <div class="empty-state">
                    <div class="loading-spinner"></div>
                    <div class="empty-title">正在加载功能列表...</div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const { ipcRenderer } = require('electron');
        
        let allActions = [];
        let currentFilter = 'all';
        
        // 初始化管理器
        async function initManager() {
            try {
                // 1. 获取当前所有可用功能（包括已启用和可添加的）
                allActions = await ipcRenderer.invoke('get-all-available-actions');
                
                // 2. 获取当前激活的功能ID
                const activeActionIds = await ipcRenderer.invoke('get-manager-active-action-ids');
                
                // 3. 标记每个功能的激活状态
                allActions.forEach(action => {
                    action.isActive = activeActionIds.includes(action.id);
                });
                
                console.log('获取到功能列表:', allActions.length, '个', '其中激活的:', activeActionIds.length, '个');
                renderActionsList();
            } catch (error) {
                console.error('初始化管理器失败:', error);
                showEmptyState('❌', '加载失败', '无法加载功能列表: ' + error.message);
            }
        }
        
        // 渲染功能列表
        function renderActionsList() {
            const container = document.getElementById('actions-list');
            
            const filteredActions = currentFilter === 'all' 
                ? allActions 
                : allActions.filter(action => action.type === currentFilter);
                
            if (filteredActions.length === 0) {
                showEmptyState('📭', '暂无功能', '此分类下暂无功能，点击"添加功能"按钮添加');
                return;
            }
            
            container.innerHTML = '';
            
            filteredActions.forEach(action => {
                const actionDiv = document.createElement('div');
                actionDiv.className = 'action-card' + (action.isActive ? ' active' : '');
                
                // 准备状态按钮HTML
                const statusBtnHTML = action.isActive
                    ? \`<span class="action-status active">已添加</span>\`
                    : \`<span class="action-status inactive" onclick="addAction('\${action.id}')">未添加</span>\`;
                
                // 处理图标显示：如果是数据URL或文件路径则用img标签，否则直接显示
                const iconHTML = action.icon && (action.icon.startsWith('data:') || action.icon.startsWith('file://') || action.icon.includes('.ico') || action.icon.includes('.png') || action.icon.includes('.jpg') || action.icon.includes('.svg'))
                    ? \`<img src="\${action.icon}" alt="icon" style="width: 20px; height: 20px; object-fit: contain;" class="action-icon">\`
                    : \`<span class="action-icon">\${action.icon || '🔧'}</span>\`;
                
                actionDiv.innerHTML = \`
                    <div class="action-header">
                        <div style="display: flex; align-items: center;">
                            \${iconHTML}
                            <span class="action-title">\${action.title}</span>
                        </div>
                    </div>
                    <div class="action-description">\${action.description || '无描述'}</div>
                    <div class="action-meta">
                        <span class="action-type">\${getTypeLabel(action.type)}</span>
                        <span>\${action.category || '未分类'}</span>
                    </div>
                    \${statusBtnHTML}
                    \${action.isActive ? \`<button class="delete-btn" title="从超级面板中移除此功能" onclick="deleteAction('\${action.id}')">✕</button>\` : ''}
                \`;
                
                container.appendChild(actionDiv);
            });
        }
        
        // 显示空状态
        function showEmptyState(icon, title, description) {
            const container = document.getElementById('actions-list');
            container.innerHTML = \`
                <div class="empty-state">
                    <div class="empty-icon">\${icon}</div>
                    <div class="empty-title">\${title}</div>
                    <div class="empty-description">\${description}</div>
                </div>
            \`;
        }
        
        // 获取类型标签
        function getTypeLabel(type) {
            const labels = {
                'builtin': '内置',
                'custom': '自定义',
                'plugin': '插件',
                'dynamic': '动态'
            };
            return labels[type] || type;
        }
        
        // 按分类筛选
        function filterByCategory(category) {
            currentFilter = category;
            
            // 更新侧边栏活动状态
            document.querySelectorAll('.category-item').forEach(item => {
                item.classList.remove('active');
            });
            event.target.classList.add('active');
            
            renderActionsList();
        }
        
        // 删除功能
        async function deleteAction(actionId) {
            if (confirm('确定要从超级面板中移除这个功能吗？')) {
                try {
                    const success = await ipcRenderer.invoke('delete-super-panel-action', actionId);
                    if (success) {
                        // 更新本地功能状态
                        const action = allActions.find(a => a.id === actionId);
                        if (action) {
                            action.isActive = false;
                        }
                        renderActionsList();
                    } else {
                        alert('移除失败');
                    }
                } catch (error) {
                    alert('移除失败: ' + error.message);
                }
            }
        }
        
        // 添加功能到超级面板
        async function addAction(actionId) {
            try {
                const success = await ipcRenderer.invoke('add-super-panel-action', actionId);
                if (success) {
                    // 更新本地功能状态
                    const action = allActions.find(a => a.id === actionId);
                    if (action) {
                        action.isActive = true;
                    }
                    renderActionsList();
                } else {
                    alert('添加失败');
                }
            } catch (error) {
                alert('添加失败: ' + error.message);
            }
        }
        
        // 添加新功能
        function addNewAction() {
            ipcRenderer.invoke('open-add-plugin-dialog');
        }
        
        // 导入功能
        function importActions() {
            alert('导入功能即将支持');
        }
        
        // 导出功能
        function exportActions() {
            alert('导出功能即将支持');
        }
        
        // 关闭管理器
        function closeManager() {
            ipcRenderer.invoke('close-current-window');
        }
        
        // 窗口加载完成后初始化
        window.addEventListener('DOMContentLoaded', () => {
            initManager();
        });
    </script>
</body>
</html>
    `;
}

// 添加 IPC 处理：获取所有可用功能（包括已启用和未启用的）
ipcMain.handle('get-all-available-actions', async (event) => {
    try {
        console.log('获取所有可用功能...');

        // 1. 获取内置功能
        const builtinActions = await getBuiltinSuperPanelActions();
        console.log(`获取到内置功能: ${builtinActions.length}个`);

        // 2. 获取自定义功能
        const customActionsPath = path.join(app.getPath('userData'), 'custom-super-panel-actions.json');
        let customActions = [];
        if (fs.existsSync(customActionsPath)) {
            const data = fs.readFileSync(customActionsPath, 'utf8');
            customActions = JSON.parse(data);
            console.log(`获取到自定义功能: ${customActions.length}个`);
        }

        // 3. 获取插件功能
        let pluginActions = [];
        for (const [pluginName, actions] of superPanelRegistry) {
            console.log(`从插件获取功能: ${pluginName} (${actions.length}个)`);
            pluginActions = pluginActions.concat(actions.map(action => ({
                ...action,
                source: 'plugin',
                pluginName: pluginName
            })));
        }
        console.log(`获取到插件功能: ${pluginActions.length}个`);

        // 4. 合并所有功能并确保ID唯一
        const allActions = [...builtinActions, ...customActions, ...pluginActions];
        const uniqueActions = [];
        const seenIds = new Set();

        for (const action of allActions) {
            if (action && action.id && !seenIds.has(action.id)) {
                seenIds.add(action.id);
                uniqueActions.push(action);
            }
        }

        console.log(`获取到唯一功能: ${uniqueActions.length}个`);
        return uniqueActions;
    } catch (error) {
        console.error('获取所有可用功能失败:', error);
        return [];
    }
});

// 添加 IPC 处理：获取当前超级面板中激活的功能ID
ipcMain.handle('get-manager-active-action-ids', async (event) => {
    try {
        // 获取当前超级面板中的功能ID
        const settings = loadSettings();
        const activeIds = new Set();

        if (settings && settings.superPanelActions && Array.isArray(settings.superPanelActions)) {
            settings.superPanelActions.forEach(action => {
                if (action && action.id) {
                    activeIds.add(action.id);
                }
            });
        }

        console.log('当前激活的功能ID:', Array.from(activeIds));
        return Array.from(activeIds);
    } catch (error) {
        console.error('获取超级面板管理器中激活功能ID失败:', error);
        return [];
    }
});

// 添加 IPC 处理：添加功能到超级面板
ipcMain.handle('add-super-panel-action', async (event, actionId) => {
    try {
        console.log(`正在尝试添加功能: ${actionId}`);

        // 1. 获取所有可用功能
        const allBuiltinActions = await getBuiltinSuperPanelActions();
        console.log(`获取到内置功能: ${allBuiltinActions.length}个`);

        const allCustomActions = await getCustomSuperPanelActions();
        console.log(`获取到自定义功能: ${allCustomActions.length}个`);

        // 2. 尝试获取插件功能
        let pluginActions = [];
        for (const [pluginName, actions] of superPanelRegistry) {
            pluginActions = pluginActions.concat(actions);
        }
        console.log(`获取到插件功能: ${pluginActions.length}个`);

        // 3. 合并所有功能
        const allActions = [...allBuiltinActions, ...allCustomActions, ...pluginActions];
        console.log(`总功能数: ${allActions.length}个`);

        // 4. 查找要添加的功能
        const actionToAdd = allActions.find(action => action.id === actionId);

        if (!actionToAdd) {
            console.error(`未找到ID为 ${actionId} 的功能`);

            // 调试信息
            console.log('可用功能ID列表:');
            allActions.forEach(a => console.log(`- ${a.id}`));

            return false;
        }

        console.log(`找到功能: ${actionToAdd.title || actionToAdd.id}`);

        // 5. 获取当前设置
        const settings = loadSettings();
        if (!settings.superPanelActions) {
            settings.superPanelActions = [];
        }

        // 6. 检查功能是否已存在
        const exists = settings.superPanelActions.some(action => action.id === actionId);
        if (exists) {
            console.log(`功能 ${actionId} 已存在于超级面板中`);
            return true; // 已存在视为成功
        }

        // 7. 添加功能到超级面板
        settings.superPanelActions.push(actionToAdd);
        saveSettings(settings);

        console.log(`成功添加功能到超级面板: ${actionId}`);

        // 8. 直接通知超级面板更新
        if (superPanelWindow && !superPanelWindow.isDestroyed()) {
            console.log('向超级面板发送添加功能的更新通知');
            superPanelWindow.webContents.send('refresh-super-panel');

            // 同时发送更新后的功能列表
            superPanelWindow.webContents.send('super-panel-actions-updated', settings.superPanelActions);
        } else {
            console.log('超级面板窗口不存在，无法发送添加功能的更新');
        }

        return true;
    } catch (error) {
        console.error('添加功能到超级面板失败:', error);
        console.error(error.stack);
        return false;
    }
});

// 添加 IPC 处理：删除超级面板功能
ipcMain.handle('delete-super-panel-action', (event, actionId) => {
    try {
        console.log(`开始处理功能删除: ${actionId}`);

        // 获取当前设置
        const settings = loadSettings();
        if (!settings.superPanelActions) {
            console.log('超级面板功能列表为空');
            return false;
        }

        // 检查功能是否存在
        const initialLength = settings.superPanelActions.length;
        settings.superPanelActions = settings.superPanelActions.filter(action => action.id !== actionId);

        if (settings.superPanelActions.length === initialLength) {
            console.log(`未找到ID为 ${actionId} 的功能`);
            return false;
        }

        console.log(`已从设置中移除功能，剩余功能: ${settings.superPanelActions.length}个`);

        // 保存设置
        saveSettings(settings);

        // 立即通知超级面板更新
        if (superPanelWindow && !superPanelWindow.isDestroyed()) {
            console.log('向超级面板发送更新通知');
            superPanelWindow.webContents.send('refresh-super-panel');

            // 为了更可靠地更新，也发送功能列表
            superPanelWindow.webContents.send('super-panel-actions-updated', settings.superPanelActions);
        } else {
            console.log('超级面板窗口不存在，无法发送更新');
        }

        console.log(`成功从超级面板移除功能: ${actionId}`);
        return true;
    } catch (error) {
        console.error('从超级面板移除功能失败:', error);
        console.error(error.stack);
        return false;
    }
});

// 添加 IPC 处理：打开超级面板管理器
ipcMain.handle('open-super-panel-manager', () => {
    try {
        createSuperPanelManagerWindow();
        return true;
    } catch (error) {
        console.error('打开超级面板管理器失败:', error);
        return false;
    }
});

// 添加 IPC 处理：打开超级面板设置
ipcMain.handle('open-super-panel-settings', () => {
    try {
        createSuperPanelSettingsWindow();
        return true;
    } catch (error) {
        console.error('打开超级面板设置失败:', error);
        return false;
    }
});

// 添加 IPC 处理：获取内置功能列表
ipcMain.handle('get-builtin-actions', async () => {
    try {
        return await getBuiltinSuperPanelActions();
    } catch (error) {
        console.error('获取内置功能失败:', error);
        return [];
    }
});

// 添加 IPC 处理：获取当前激活的功能ID
ipcMain.handle('get-active-action-ids', async () => {
    try {
        const settings = loadSettings();
        const actions = settings.superPanelActions || [];
        return actions.map(action => action.id);
    } catch (error) {
        console.error('获取激活功能ID失败:', error);
        return [];
    }
});

// 添加 IPC 处理：批量添加功能到超级面板
ipcMain.handle('add-features-to-super-panel', async (event, features) => {
    /**
     * 批量添加超级面板功能
     * 函数级注释：将用户在“添加功能”对话框中选择的功能批量写入设置；
     * - 去重：按 `id` 去重，已存在的功能不重复写入；
     * - 成功判定：只要没有异常，即使全是已存在的功能也返回 true，避免前端误报“保存失败”。
     */
    try {
        console.log(`批量添加功能到超级面板: ${features.length}个`);

        const settings = loadSettings();
        if (!settings.superPanelActions) {
            settings.superPanelActions = [];
        }

        let addedCount = 0;

        // 遍历要添加的功能
        for (const feature of features) {
            // 规范化对象，确保包含 id 和 title
            if (!feature || !feature.id) {
                console.warn('跳过无效功能条目:', feature);
                continue;
            }

            const exists = settings.superPanelActions.some(action => action.id === feature.id);
            if (!exists) {
                settings.superPanelActions.push(feature);
                addedCount++;
                console.log(`添加功能: ${feature.title || feature.id} (${feature.id})`);
            } else {
                console.log(`功能已存在: ${feature.title || feature.id} (${feature.id})`);
            }
        }

        // 无论是否新增，只要流程正常即视为成功，避免 UI 误报失败
        saveSettings(settings);
        const existedCount = Math.max(0, (features || []).length - addedCount);
        console.log(`批量添加完成，新增: ${addedCount}，已存在: ${existedCount}，总计: ${settings.superPanelActions.length}`);

        // 通知超级面板更新
        if (superPanelWindow && !superPanelWindow.isDestroyed()) {
            superPanelWindow.webContents.send('refresh-super-panel');
            superPanelWindow.webContents.send('super-panel-actions-updated', settings.superPanelActions);
        }

        return { success: true, addedCount, existedCount };
    } catch (error) {
        console.error('批量添加功能到超级面板失败:', error);
        return false;
    }
});

// 创建超级面板设置的HTML内容
function createSuperPanelSettingsHtml() {
    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>超级面板设置</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif;
            background: rgba(40, 44, 52, 0.95);
            color: #ffffff;
            user-select: none;
            border-radius: 12px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        .settings-header {
            padding: 8px 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(255, 255, 255, 0.05);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .settings-title {
            font-size: 12px;
            font-weight: 500;
            color: #ffffff;
        }
        
        .close-btn {
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.7);
            font-size: 16px;
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            transition: all 0.2s ease;
        }
        
        .close-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #ffffff;
        }
        
        .settings-content {
            flex: 1;
            padding: 16px;
            overflow-y: auto;
        }
        
        .settings-section {
            margin-bottom: 16px;
        }
        
        .section-title {
            font-size: 12px;
            font-weight: 500;
            color: #60a5fa;
            margin-bottom: 8px;
            border-bottom: 1px solid rgba(96, 165, 250, 0.3);
            padding-bottom: 4px;
        }
        
        .setting-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        
        .setting-item:last-child {
            border-bottom: none;
        }
        
        .setting-label {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.9);
        }
        
        .setting-description {
            font-size: 10px;
            color: rgba(255, 255, 255, 0.6);
            margin-top: 2px;
        }
        
        .setting-control {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .toggle {
            position: relative;
            display: inline-block;
            width: 38px;
            height: 20px;
        }
        
        .toggle input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(255, 255, 255, 0.2);
            transition: .4s;
            border-radius: 12px;
        }
        
        .slider:before {
            position: absolute;
            content: "";
            height: 16px;
            width: 16px;
            left: 2px;
            bottom: 2px;
            background-color: white;
            transition: .4s;
            border-radius: 50%;
        }
        
        input:checked + .slider {
            background-color: #60a5fa;
        }
        
        input:checked + .slider:before {
            transform: translateX(18px);
        }
        
        .btn {
            background: rgba(96, 165, 250, 0.2);
            border: 1px solid rgba(96, 165, 250, 0.4);
            color: #60a5fa;
            padding: 6px 12px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s ease;
        }
        
        .btn:hover {
            background: rgba(96, 165, 250, 0.3);
            border-color: rgba(96, 165, 250, 0.6);
        }
        
        .btn-danger {
            background: rgba(239, 68, 68, 0.2);
            border-color: rgba(239, 68, 68, 0.4);
            color: #ef4444;
        }
        
        .btn-danger:hover {
            background: rgba(239, 68, 68, 0.3);
            border-color: rgba(239, 68, 68, 0.6);
        }
        
        .plugin-list {
            max-height: 160px;
            overflow-y: auto;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.02);
        }
        
        .plugin-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        
        .plugin-item:last-child {
            border-bottom: none;
        }
        
        .plugin-info {
            flex: 1;
        }
        
        .plugin-name {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.9);
        }
        
        .plugin-features {
            font-size: 10px;
            color: rgba(255, 255, 255, 0.6);
            margin-top: 2px;
        }
    </style>
</head>
<body>
    <div class="settings-header">
        <div class="settings-title">超级面板设置</div>
        <button class="close-btn" onclick="closeSettings()">✕</button>
    </div>
    
    <div class="settings-content">
        <div class="settings-section">
            <div class="section-title">基本设置</div>
            
            <div class="setting-item">
                <div>
                    <div class="setting-label">启用右键长按</div>
                    <div class="setting-description">长按右键显示超级面板</div>
                </div>
                <div class="setting-control">
                    <label class="toggle">
                        <input type="checkbox" id="enable-right-click" checked>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
            
            <div class="setting-item">
                <div>
                    <div class="setting-label">长按延迟时间</div>
                    <div class="setting-description">右键长按触发时间（毫秒）</div>
                </div>
                <div class="setting-control">
                    <input type="number" id="right-click-delay" value="350" min="100" max="2000"
                           style="width: 80px; padding: 4px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 4px;">
                </div>
            </div>
            
            <div class="setting-item">
                <div>
                    <div class="setting-label">自动隐藏面板</div>
                    <div class="setting-description">失去焦点时自动隐藏面板</div>
                </div>
                <div class="setting-control">
                    <label class="toggle">
                        <input type="checkbox" id="auto-hide" checked>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>
        </div>
        
        <div class="settings-section">
            <div class="section-title">插件管理</div>
            
            <div class="setting-item">
                <div>
                    <div class="setting-label">已注册插件</div>
                    <div class="setting-description">显示在超级面板中的插件功能</div>
                </div>
                <div class="setting-control">
                    <button class="btn" onclick="refreshPlugins()">刷新</button>
                    <button class="btn" onclick="addNewPlugin()">添加插件</button>
                </div>
            </div>
            
            <div class="plugin-list" id="plugin-list">
                <div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.6);">
                    正在加载插件列表...
                </div>
            </div>
        </div>
        
        <div class="settings-section">
            <div class="section-title">高级设置</div>
            
            <div class="setting-item">
                <div>
                    <div class="setting-label">导出配置</div>
                    <div class="setting-description">导出超级面板配置到文件</div>
                </div>
                <div class="setting-control">
                    <button class="btn" onclick="exportConfig()">导出</button>
                </div>
            </div>
            
            <div class="setting-item">
                <div>
                    <div class="setting-label">导入配置</div>
                    <div class="setting-description">从文件导入超级面板配置</div>
                </div>
                <div class="setting-control">
                    <button class="btn" onclick="importConfig()">导入</button>
                </div>
            </div>
            
            <div class="setting-item">
                <div>
                    <div class="setting-label">重置面板</div>
                    <div class="setting-description">清除所有自定义配置</div>
                </div>
                <div class="setting-control">
                    <button class="btn btn-danger" onclick="resetPanel()">重置</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        const { ipcRenderer } = require('electron');
        
        let registeredPlugins = [];
        
        // 初始化设置
        async function initSettings() {
            try {
                // 加载当前设置
                const settings = await ipcRenderer.invoke('get-settings');
                
                // 更新UI
                document.getElementById('enable-right-click').checked = settings.enableRightClickPanel !== false;
                document.getElementById('right-click-delay').value = (typeof settings.rightClickDelay === 'number' ? settings.rightClickDelay : 350);
                document.getElementById('auto-hide').checked = true; // 默认启用自动隐藏
                
                // 加载插件列表
                await refreshPlugins();
                
            } catch (error) {
                console.error('初始化设置失败:', error);
            }
        }
        
        // 刷新插件列表
        async function refreshPlugins() {
            try {
                const actions = await ipcRenderer.invoke('get-super-panel-actions', '');
                const pluginMap = new Map();
                
                // 按插件名分组
                actions.forEach(action => {
                    if (action.source === 'plugin') {
                        const pluginName = action.pluginName || '未知插件';
                        if (!pluginMap.has(pluginName)) {
                            pluginMap.set(pluginName, []);
                        }
                        pluginMap.get(pluginName).push(action);
                    }
                });
                
                // 渲染插件列表
                const container = document.getElementById('plugin-list');
                
                if (pluginMap.size === 0) {
                    container.innerHTML = '<div style="text-align: center; padding: 20px; color: rgba(255,255,255,0.6);">暂无已注册的插件</div>';
                    return;
                }
                
                container.innerHTML = '';
                
                for (const [pluginName, actions] of pluginMap) {
                    const pluginDiv = document.createElement('div');
                    pluginDiv.className = 'plugin-item';
                    
                    pluginDiv.innerHTML = \`
                        <div class="plugin-info">
                            <div class="plugin-name">\${pluginName}</div>
                            <div class="plugin-features">\${actions.length} 个功能: \${actions.map(a => a.title).join(', ')}</div>
                        </div>
                        <div class="setting-control">
                            <button class="btn btn-danger" onclick="removePlugin('\${pluginName}')">移除</button>
                        </div>
                    \`;
                    
                    container.appendChild(pluginDiv);
                }
                
            } catch (error) {
                console.error('刷新插件列表失败:', error);
            }
        }
        
        // 保存设置
        async function saveSettings() {
            try {
                const settings = {
                    enableRightClickPanel: document.getElementById('enable-right-click').checked,
                    rightClickDelay: parseInt(document.getElementById('right-click-delay').value) || 500
                };
                
                await ipcRenderer.invoke('save-settings', settings);
                console.log('设置已保存');
                
            } catch (error) {
                console.error('保存设置失败:', error);
                alert('保存设置失败: ' + error.message);
            }
        }
        
        // 添加插件
        function addNewPlugin() {
            ipcRenderer.invoke('open-add-plugin-dialog');
        }
        
        // 移除插件
        async function removePlugin(pluginName) {
            if (confirm(\`确定要移除插件 "\${pluginName}" 的所有功能吗？\`)) {
                try {
                    await ipcRenderer.invoke('clear-super-panel-actions', pluginName);
                    await refreshPlugins();
                } catch (error) {
                    console.error('移除插件失败:', error);
                    alert('移除插件失败: ' + error.message);
                }
            }
        }
        
        // 导出配置
        function exportConfig() {
            alert('导出配置功能待实现');
        }
        
        // 导入配置
        function importConfig() {
            alert('导入配置功能待实现');
        }
        
        // 重置面板
        async function resetPanel() {
            if (confirm('确定要重置超级面板吗？这将清除所有自定义配置。')) {
                try {
                    await ipcRenderer.invoke('save-custom-super-panel-actions', []);
                    await refreshPlugins();
                    alert('面板已重置');
                } catch (error) {
                    console.error('重置面板失败:', error);
                    alert('重置失败: ' + error.message);
                }
            }
        }
        
        // 关闭设置
        function closeSettings() {
            saveSettings().then(() => {
                ipcRenderer.invoke('close-current-window');
            });
        }
        
        // 监听设置变化
        document.getElementById('enable-right-click').addEventListener('change', saveSettings);
        document.getElementById('right-click-delay').addEventListener('change', saveSettings);
        document.getElementById('auto-hide').addEventListener('change', saveSettings);
        
        // 初始化
        window.addEventListener('DOMContentLoaded', () => {
            initSettings();
        });
    </script>
</body>
</html>
    `;
}

// 添加 IPC 处理：获取所有超级面板功能
ipcMain.handle('get-all-super-panel-actions', async (event, selectedText) => {
    try {
        console.log('🎯 获取所有超级面板功能，选中文本:', selectedText);

        let allActions = [];

        // 1. 获取插件注册的功能
        for (const [pluginName, actions] of superPanelRegistry) {
            console.log(`📦 加载插件功能: ${pluginName} (${actions.length}个)`);
            allActions = allActions.concat(actions.map(action => ({
                ...action,
                source: 'plugin',
                pluginName: pluginName
            })));
        }

        // 2. 获取持久化的自定义功能
        const customActions = await getCustomSuperPanelActions();
        allActions = allActions.concat(customActions);

        // 3. 获取内置功能
        const builtinActions = await getBuiltinSuperPanelActions();
        allActions = allActions.concat(builtinActions);

        // 4. 获取动态功能（基于选中内容）
        const dynamicActions = await getDynamicSuperPanelActions(selectedText);
        allActions = allActions.concat(dynamicActions);

        console.log(`🔧 总共加载功能: ${allActions.length}个`);

        // 按类型和优先级排序
        allActions.sort((a, b) => {
            const priorityMap = { dynamic: 1, plugin: 2, custom: 3, builtin: 4 };
            return (priorityMap[a.type] || 5) - (priorityMap[b.type] || 5);
        });

        return allActions;
    } catch (error) {
        console.error('获取所有超级面板功能失败:', error);
        return [];
    }
});



// 添加 IPC 处理：获取可用的自定义功能
ipcMain.handle('get-available-custom-actions', async () => {
    try {
        // 这里可以返回一些预定义的自定义功能模板
        // 例如系统工具、网络工具等
        return [
            {
                id: 'custom-calculator',
                title: '计算器',
                description: '打开系统计算器',
                icon: '🧮',
                type: 'custom',
                category: '系统工具',
                command: 'open-app',
                args: { app: 'calc.exe' }
            },
            {
                id: 'custom-notepad',
                title: '记事本',
                description: '打开记事本',
                icon: '📝',
                type: 'custom',
                category: '系统工具',
                command: 'open-app',
                args: { app: 'notepad.exe' }
            },
            {
                id: 'custom-open-terminal',
                title: '终端打开',
                description: '在终端中打开剪贴板路径（文件将打开其所在目录）',
                icon: '🖥️',
                type: 'custom',
                category: '系统工具',
                command: 'open-terminal',
                args: {}
            },
            {
                id: 'custom-clock',
                title: '时钟',
                description: '打开置顶时钟小窗',
                icon: '🕒',
                type: 'custom',
                category: '系统工具',
                command: 'open-clock',
                args: {}
            },
            {
                id: 'custom-image',
                title: '图片',
                description: '预览剪贴板图片路径，或选择图片打开',
                icon: '🖼️',
                type: 'custom',
                category: '系统工具',
                command: 'open-image',
                args: {}
            },
            {
                id: 'custom-screenshot',
                title: '截图',
                description: '调用系统截图并将结果写入剪贴板',
                icon: '✂️',
                type: 'custom',
                category: '系统工具',
                command: 'screenclip',
                args: {}
            },
            {
                id: 'custom-google-search',
                title: '谷歌搜索',
                description: '使用Google搜索选中内容',
                icon: '🔍',
                type: 'custom',
                category: '网络工具',
                command: 'search-web',
                args: { engine: 'google' }
            }
        ];
    } catch (error) {
        console.error('获取可用自定义功能失败:', error);
        return [];
    }
});

// 监听输入框活动状态
ipcMain.handle('notify-input-active', async (event, isActive) => {
    hasActiveInput = isActive;
    console.log('🔍 输入框活动状态更新:', isActive ? '活动' : '非活动');
    return true;
});
