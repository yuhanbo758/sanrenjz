const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { zipSync } = require('fflate');
const PluginManager = require('../app/software_manager');
const { normalizePluginIdentity } = require('../app/plugin_store');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-plugin-refresh-'));
app.setPath('userData', path.join(temporary, 'user-data'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

// 复用真实主进程处理函数，隔离托盘、全局快捷键、网络及真实插件目录。
function section(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert(from >= 0 && to > from, `找不到源码区段 ${start}`);
    return source.slice(from, to);
}

function writePlugin(base, folder, name, feature = 'refresh-test', version = '1.0.0') {
    const directory = path.join(base, folder);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({
        pluginName: name, description: '插件刷新回归样本', version,
        main: 'index.html', features: [{ code: feature, explain: `${name}功能`, cmds: [name], superPanel: true, startHidden: true }]
    }), 'utf8');
    fs.writeFileSync(path.join(directory, 'index.html'), `<html><body>刷新样本<script>
        window.exports = { [${JSON.stringify(feature)}]: { mode: 'none', args: { enter: () => { window.executed = true; } } } };
    </script></body></html>`, 'utf8');
    fs.writeFileSync(path.join(directory, 'marker.txt'), 'original', 'utf8');
    return directory;
}

async function until(window, expression) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (await window.webContents.executeJavaScript(`Boolean(${expression})`)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`等待超时：${expression}`);
}

app.whenReady().then(async () => {
    const windows = [];
    const manager = new PluginManager(null);
    manager.pluginDir = path.join(temporary, 'installed-app', 'plugins');
    fs.mkdirSync(manager.pluginDir, { recursive: true });
    const bundledDir = path.join(temporary, 'installed-app', 'resources', 'app', 'software');
    fs.mkdirSync(bundledDir, { recursive: true });
    const registry = new Map();
    const calls = new Map();
    const handlers = new Map();
    const builtinSession = new EventEmitter();
    let selection = { canceled: true, filePaths: [] };
    let contentGate = null;
    const context = vm.createContext({
        fs, path, process, spawn, console: { log() {}, error() {}, warn() {} },
        app, __dirname: root, pluginManager: manager, mainWindow: null, searchWindow: null,
        superPanelWindow: null, superPanelRegistry: registry,
        normalizePluginIdentity, loadSettings: () => ({}),
        toSerializable: value => JSON.parse(JSON.stringify(value)),
        builtinSessionEventsBound: false, getBuiltinSession: () => builtinSession,
        sanitizeFileName: name => path.basename(name),
        isPluginDownloadUrl: () => true,
        isSupportedPluginDownload: name => name.endsWith('.zip'),
        resolvePluginPathByName: (_name, directory) => directory,
        getPluginDefaultIcon: () => '🔧',
        dialog: { showOpenDialog: async () => selection },
        getPluginContents: async directory => {
            if (contentGate) await contentGate;
            const config = JSON.parse(fs.readFileSync(path.join(directory, 'plugin.json'), 'utf8'));
            return config.features.map(feature => ({ title: feature.explain, type: 'feature', featureCode: feature.code }));
        },
        ipcMain: { handle(channel, handler) {
            handlers.set(channel, handler);
            ipcMain.handle(channel, (event, ...args) => {
                calls.set(channel, (calls.get(channel) || 0) + 1);
                return handler(event, ...args);
            });
        } }
    });
    vm.runInContext([
        section('function getPluginInstallDir()', 'function getInstalledAppDir()'),
        section('function ensureDir(', 'function sanitizeFileName('),
        section('function uniquePath(', 'function tokenPath('),
        section('function sendRendererEvent(', 'function ensureDir('),
        section('function notifySuperPanelUpdate()', '// 根据插件名称获取文件夹名称'),
        section('const searchCatalogCache =', '/**\n * 采集当前选区'),
        section('function toFileUrl(', '// 注册插件动态功能'),
        section("ipcMain.handle('run-plugin',", '// 停止插件')
    ].join('\n'), context, { filename: 'main-plugin-refresh-handlers.js' });

    ipcMain.handle('get-plugin-list', () => manager.getPluginList());
    ipcMain.handle('get-settings', () => ({}));
    ipcMain.handle('get-version', () => 'test');
    ipcMain.handle('account:me', () => ({ authenticated: false }));
    ipcMain.handle('get-plugin-data-directory', () => manager.pluginDataDir);
    ipcMain.handle('plugin-storage-get-async', () => false);
    ipcMain.handle('get-pin-status', () => false);
    ipcMain.handle('get-plugin-pin-status-window', () => false);
    const unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(error));
    try {
        const createWindow = async file => {
            const window = new BrowserWindow({ show: false, width: 1000, height: 800,
                webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
            windows.push(window);
            await window.loadFile(path.join(root, file));
            assert.strictEqual(window.isVisible(), false);
            return window;
        };
        context.mainWindow = await createWindow('index.html');
        const mainWindow = context.mainWindow;
        context.searchWindow = await createWindow('search-window.html');
        const searchWindow = context.searchWindow;
        await until(searchWindow, 'catalogVersion >= 0 && !catalogLoading');
        await until(mainWindow, 'Array.isArray(cachedPlugins)');

        const alpha = writePlugin(path.join(temporary, 'incoming'), 'alpha-folder', '新增测试甲');
        const invalid = path.join(temporary, 'incoming', 'invalid');
        fs.mkdirSync(invalid, { recursive: true });
        fs.writeFileSync(path.join(invalid, 'plugin.json'), '{broken', 'utf8');
        selection = { canceled: false, filePaths: [alpha, invalid] };
        await mainWindow.webContents.executeJavaScript("document.getElementById('local-file-btn').click(); true");
        await until(mainWindow, "!document.getElementById('local-file-btn').disabled && cachedPlugins.length === 1");
        await until(searchWindow, "plugins.some(plugin => plugin.name === '新增测试甲')");
        assert.strictEqual(calls.get('import-local-plugins'), 1);
        assert(fs.existsSync(path.join(manager.pluginDir, 'alpha-folder', 'index.html')));
        assert.strictEqual(fs.readdirSync(bundledDir).length, 0, '导入不得写入内置 resources 目录');
        assert.strictEqual(fs.readdirSync(path.join(manager.pluginDir, '.downloads')).length, 0);
        assert(registry.get('新增测试甲').some(action => action.feature.code === 'refresh-test'));
        assert((await mainWindow.webContents.executeJavaScript("document.querySelector('.notification-message').textContent")).includes('invalid'));
        console.log('PASS 本地按钮导入后自动更新主界面、快捷搜索和超级面板，隔离无效插件');

        await mainWindow.webContents.executeJavaScript("document.querySelector('.plugin-card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true");
        const launchDeadline = Date.now() + 10000;
        while (!manager.pluginWindows.has('新增测试甲') && Date.now() < launchDeadline) await new Promise(resolve => setTimeout(resolve, 50));
        const pluginWindow = manager.pluginWindows.get('新增测试甲');
        assert(pluginWindow, '新增插件应可从主界面立即启动');
        await until(pluginWindow, 'window.executed === true');
        assert.strictEqual(pluginWindow.isVisible(), false);
        const pluginWindowId = pluginWindow.id;
        const mainWindowId = mainWindow.id;
        console.log('PASS 导入后的插件可从主界面双击立即启动并执行功能');

        fs.writeFileSync(path.join(alpha, 'marker.txt'), 'must-not-overwrite', 'utf8');
        selection = { canceled: false, filePaths: [alpha] };
        const repeated = await handlers.get('import-local-plugins')();
        assert.strictEqual(repeated.skipped.length, 1);
        assert.strictEqual(fs.readFileSync(path.join(manager.pluginDir, 'alpha-folder', 'marker.txt'), 'utf8'), 'original');
        assert.strictEqual((await manager.getPluginList()).length, 1);
        selection = { canceled: true, filePaths: [] };
        assert.strictEqual((await handlers.get('import-local-plugins')()).canceled, true);
        console.log('PASS 同名导入保留已有文件，取消导入无副作用');

        const beta = writePlugin(manager.pluginDir, 'direct-folder', '直接复制测试乙');
        writePlugin(manager.pluginDir, 'alpha-folder', '新增测试甲', 'updated-feature');
        registry.get('新增测试甲').push({ id: 'runtime-custom', title: '运行时动作', type: 'plugin' });
        await mainWindow.webContents.executeJavaScript("document.getElementById('settings-btn').click(); true");
        await until(mainWindow, "document.getElementById('settings-modal').classList.contains('show')");
        await mainWindow.webContents.executeJavaScript("document.getElementById('refresh-plugins-btn').click(); document.getElementById('refresh-plugins-btn').click(); true");
        await until(mainWindow, "document.getElementById('plugin-refresh-status').textContent.includes('共 2 个插件') && !document.getElementById('refresh-plugins-btn').disabled");
        await until(searchWindow, "plugins.length === 2 && pluginContents.some(content => content.featureCode === 'updated-feature')");
        assert.strictEqual(calls.get('refresh-plugins'), 1, '重复点击不应启动重复扫描');
        assert(registry.get('新增测试甲').some(action => action.id === 'runtime-custom'));
        assert(registry.get('新增测试甲').some(action => action.feature?.code === 'updated-feature'));
        assert(!registry.get('新增测试甲').some(action => action.feature?.code === 'refresh-test'));
        assert.strictEqual(manager.pluginWindows.get('新增测试甲').id, pluginWindowId, '刷新不应重启已运行插件');
        assert.strictEqual(mainWindow.id, mainWindowId, '刷新不应重启主程序窗口');
        await until(mainWindow, "document.getElementById('plugin-management-list').textContent.includes('直接复制测试乙')");
        console.log('PASS 设置中手动刷新识别直接复制与清单更新，保留运行时动作并防止重复点击');

        manager.dynamicFeatures.set('直接复制测试乙', []);
        fs.rmSync(beta, { recursive: true, force: true });
        await mainWindow.webContents.executeJavaScript("document.getElementById('refresh-plugins-btn').click(); true");
        await until(mainWindow, "document.getElementById('plugin-refresh-status').textContent.includes('共 1 个插件') && !document.getElementById('refresh-plugins-btn').disabled");
        await until(searchWindow, 'plugins.length === 1');
        assert(!registry.has('直接复制测试乙'));
        assert(!manager.dynamicFeatures.has('直接复制测试乙'));
        console.log('PASS 文件夹移除后刷新清理所有入口中的旧插件');

        const storePlugin = writePlugin(path.join(temporary, 'store-source'), 'store', '小店安装测试');
        const archive = zipSync(Object.fromEntries(['plugin.json', 'index.html', 'marker.txt'].map(file =>
            [`package/${file}`, new Uint8Array(fs.readFileSync(path.join(storePlugin, file)))])));
        const item = new EventEmitter();
        item.getURL = () => 'https://example.test/plugin.zip';
        item.getFilename = () => 'plugin.zip';
        item.setSavePath = destination => fs.writeFileSync(destination, archive);
        vm.runInContext('bindBuiltinSessionEvents()', context);
        builtinSession.emit('will-download', {}, item);
        item.emit('done', {}, 'completed');
        await until(mainWindow, "cachedPlugins.some(plugin => plugin.name === '小店安装测试')");
        await until(searchWindow, "plugins.some(plugin => plugin.name === '小店安装测试')");
        assert(registry.has('小店安装测试'));
        assert(fs.existsSync(path.join(manager.pluginDir, '小店安装测试', 'index.html')));
        console.log('PASS 小店 ZIP 解压安装复用同一刷新流程');

        // 刷新发生于搜索构建中，最终请求必须返回新版本目录。
        let releaseContent;
        contentGate = new Promise(resolve => { releaseContent = resolve; });
        const pendingSearch = handlers.get('search-catalog-get')(null, { force: true });
        await new Promise(resolve => setTimeout(resolve, 30));
        writePlugin(manager.pluginDir, 'during-search', '并发刷新测试丙');
        const refreshed = await handlers.get('refresh-plugins')();
        contentGate = null;
        releaseContent();
        const catalog = await pendingSearch;
        assert(refreshed.success);
        assert(catalog.plugins.some(plugin => plugin.name === '并发刷新测试丙'));
        console.log('PASS 搜索构建期间刷新不会重新缓存过期目录');

        const oldScan = manager.getPluginList.bind(manager);
        let releaseScan;
        manager.getPluginList = async () => {
            const snapshot = await oldScan();
            manager.getPluginList = oldScan;
            await new Promise(resolve => { releaseScan = resolve; });
            return snapshot;
        };
        const firstRefresh = handlers.get('refresh-plugins')();
        while (!releaseScan) await new Promise(resolve => setTimeout(resolve, 10));
        writePlugin(manager.pluginDir, 'during-refresh', '排队刷新测试丁');
        const secondRefresh = handlers.get('refresh-plugins')();
        releaseScan();
        await firstRefresh;
        assert((await secondRefresh).plugins.some(plugin => plugin.name === '排队刷新测试丁'));
        console.log('PASS 连续刷新按顺序重新扫描，后续请求不会复用旧扫描结果');

        const installedDirectory = manager.pluginDir;
        manager.pluginDir = path.join(temporary, 'missing-directory');
        await mainWindow.webContents.executeJavaScript("document.getElementById('refresh-plugins-btn').click(); true");
        await until(mainWindow, "document.getElementById('plugin-refresh-status').textContent.includes('刷新失败') && !document.getElementById('refresh-plugins-btn').disabled");
        manager.pluginDir = installedDirectory;
        assert.strictEqual(unhandled.length, 0, unhandled.map(error => String(error)).join('\n'));
        assert(windows.every(window => !window.isVisible()));
        assert.strictEqual(pluginWindow.isVisible(), false);
        console.log('PASS 刷新失败显示原因并恢复按钮；所有 Electron 测试窗口保持隐藏');
    } finally {
        for (const window of windows) if (!window.isDestroyed()) window.destroy();
        manager.stopAllPlugins();
    }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });

app.once('quit', () => {
    // 仅清理本次生成的隔离测试目录。
    if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('tools-plugin-refresh-')) return;
    try { fs.rmSync(temporary, { recursive: true, force: true }); }
    catch (error) { if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error; }
});
