const { app, BrowserWindow, globalShortcut, session } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-management-ui-'));
const output = path.resolve(__dirname, '../dist/plugin-management-validation');
fs.mkdirSync(output, { recursive: true });
process.env.SANRENJZ_USER_DATA = temp;
process.env.SANRENJZ_TEST_HIDDEN = '1';
app.setPath('userData', temp);
app.on('browser-window-created', (_event, window) => {
    window.show = () => {};
    window.showInactive = () => {};
});
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
globalShortcut.isRegistered = () => true;
app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://gdsx.sanrenjz.com/*'] }, (_details, callback) => callback({ cancel: true }));
});
fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({
    enableRightClickPanel: false, autoStart: false, migrationPrompted: true, pythonMode: 'none',
    pluginPreferences: { '隐藏自启': { showInMainUI: false, autoStartWithMain: true } },
    pluginSearchSettings: { '默认插件': { enabled: false, keywords: ['原有关键词'] } }
}));
const pluginDir = path.join(temp, 'plugins');
const dataDir = path.join(temp, 'plugin-data');
fs.mkdirSync(pluginDir);
fs.mkdirSync(dataDir);
for (const [folder, name, settings, valid] of [
    ['a-default', '默认插件', {}, true],
    ['b-failure', '失败自启', { autoStartWithMain: true }, false],
    ['c-hidden', '隐藏自启', { autoStartWithMain: false, unrelated: 'preserved' }, true],
    ['d-special', '引号\'与&字符', {}, true]
]) {
    const directory = path.join(pluginDir, folder);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({
        pluginName: name, main: 'index.html', description: '用于临时目录的主程序验收',
        features: [{ code: folder, explain: '测试入口', cmds: ['测试'] }]
    }));
    if (valid) fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><body>临时测试插件<script>
        window.executions = 0;
        window.exports = { ${JSON.stringify(folder)}: { mode: 'none', args: { enter() { window.executions++; } } } };
    </script>`);
    fs.writeFileSync(path.join(dataDir, `${name}-storage.json`), JSON.stringify(settings));
}

let manager;
class FixtureManager extends RealManager {
    constructor(win, options) {
        super(win, options);
        this.pluginDir = pluginDir;
        this.catalog = new PluginCatalog(pluginDir);
        manager = this;
    }
}
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));
const timeout = setTimeout(() => { console.error('Plugin management UI timed out'); app.exit(1); }, 45000);
const mainReady = new Promise(resolve => {
    app.once('browser-window-created', (_event, win) => {
        win.webContents.once('did-finish-load', () => resolve(win));
    });
});

async function until(check, message) {
    const expires = Date.now() + 10000;
    while (Date.now() < expires) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(message);
}

require('../main');
(async () => {
    const win = await mainReady;
    const evaluate = script => win.webContents.executeJavaScript(script);
    try {
        await until(() => manager.startupPluginsPromise, '未调用主程序自启动流程');
        const startup = await manager.startupPluginsPromise;
        assert.strictEqual(startup.length, 2);
        assert.strictEqual(startup.filter(item => !item.success).length, 1);
        const hidden = manager.pluginWindows.get('隐藏自启');
        assert(hidden, '单个失败后仍须启动后续隐藏插件');
        assert.strictEqual(await hidden.webContents.executeJavaScript('window.executions'), 0);
        hidden.hide();
        await until(() => evaluate('document.querySelectorAll(".plugin-card[data-engine=tools]").length === 3'), '主界面没有过滤隐藏插件');
        const unified = await evaluate("require('electron').ipcRenderer.invoke('get-main-plugin-list')");
        assert.strictEqual(unified.filter(plugin => plugin.engine === 'tools').length, 3);
        assert(unified.some(plugin => plugin.engine === 'python'), '统一目录必须继续包含 Python 程序');
        assert((await manager.getPluginList()).some(plugin => plugin.name === '隐藏自启'), '搜索目录必须保留隐藏插件');
        await evaluate(`document.getElementById('settings-btn').click(); document.querySelector('[data-target="plugins"]').click(); true;`);
        await until(() => evaluate('document.querySelectorAll(".plugin-management-item[data-engine=tools]").length === 4'), '管理列表必须包含隐藏插件');
        assert(await evaluate('document.querySelectorAll(".plugin-management-item[data-engine=python]").length > 0'), '插件管理必须整合 Python 程序');
        const initial = await evaluate(`(() => {
            const rows = [...document.querySelectorAll('.plugin-management-item')];
            const row = rows.find(row => row.querySelector('.pm-name').textContent === '默认插件');
            return { show: row.querySelector('[data-setting="showInMainUI"]').checked,
                auto: row.querySelector('[data-setting="autoStartWithMain"]').checked,
                markupInjected: !!document.querySelector('.pm-name 标签'),
                expanded: row.querySelector('.pm-details').classList.contains('expanded') };
        })()`);
        assert.deepStrictEqual(initial, { show: true, auto: false, markupInjected: false, expanded: false });

        await evaluate(`document.querySelector('[data-plugin-name="隐藏自启"][data-setting="showInMainUI"]').click(); true;`);
        await until(() => evaluate('document.querySelectorAll(".plugin-card[data-engine=tools]").length === 4'), '恢复显示未即时更新主界面');
        let saved = JSON.parse(fs.readFileSync(path.join(dataDir, '隐藏自启-storage.json')));
        assert.strictEqual(saved.autoStartWithMain, false, '宿主设置不得改写插件原有配置');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'))).pluginPreferences['隐藏自启'].showInMainUI, true);
        assert.strictEqual(saved.unrelated, 'preserved');

        await evaluate(`document.querySelector('[data-plugin-name="默认插件"][data-setting="autoStartWithMain"]').click(); true;`);
        await until(() => evaluate(`!document.querySelector('[data-plugin-name="默认插件"][data-setting="autoStartWithMain"]').disabled`), '自启动选项未保存');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'))).pluginPreferences['默认插件'].autoStartWithMain, true);
        assert(!manager.pluginWindows.has('默认插件'), '勾选自启动只应在下次启动生效');
        assert.strictEqual(await evaluate(`document.querySelector('[data-plugin-name="默认插件"][data-setting="autoStartWithMain"]').closest('.plugin-management-item').querySelector('.pm-details').classList.contains('expanded')`), false);

        const originalWrite = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => {
            if ([path.join(temp, 'settings.json'), path.join(temp, 'settings.json.tmp')].includes(file)) throw new Error('模拟设置写入失败');
            return originalWrite(file, ...args);
        };
        await evaluate(`document.querySelector('[data-plugin-name="默认插件"][data-setting="showInMainUI"]').click(); true;`);
        await until(() => evaluate(`!document.querySelector('[data-plugin-name="默认插件"][data-setting="showInMainUI"]').disabled`), '失败后没有解除忙碌状态');
        assert.strictEqual(await evaluate(`document.querySelector('[data-plugin-name="默认插件"][data-setting="showInMainUI"]').checked`), true);
        fs.writeFileSync = originalWrite;
        await evaluate("document.querySelectorAll('.notification').forEach(element => element.remove()); true;");
        await new Promise(resolve => setTimeout(resolve, 350));

        for (const [width, height] of [[1000, 680], [800, 600]]) {
            win.setSize(width, height);
            await new Promise(resolve => setTimeout(resolve, 80));
            const layout = await evaluate(`(() => {
                const panel = document.querySelector('.settings-main').getBoundingClientRect();
                return [...document.querySelectorAll('.pm-lifecycle input')].every(input => {
                    const rect = input.getBoundingClientRect(); return rect.left >= panel.left && rect.right <= panel.right;
                });
            })()`);
            assert(layout, `管理选项超出面板宽度 ${width}x${height}`);
            fs.writeFileSync(path.join(output, `settings-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
        }

        // 真实 PluginManager 的新窗口和复用窗口均可直接派发，无固定等待。
        const item = (await manager.getPluginList()).find(plugin => plugin.name === '默认插件');
        const started = Date.now();
        assert((await manager.runPluginAction(item.path, item.features[0], '')).success);
        const reused = Date.now();
        assert((await manager.runPluginAction(item.path, item.features[0], '')).success);
        assert.strictEqual(await manager.pluginWindows.get('默认插件').webContents.executeJavaScript('window.executions'), 2);
        const timings = { firstMs: reused - started, reusedMs: Date.now() - reused };
        assert(timings.reusedMs < 450, `复用窗口仍存在固定等待 ${JSON.stringify(timings)}`);
        const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        win.webContents.reload();
        await loaded;
        await evaluate("window.alert = () => {}; document.getElementById('settings-btn').click(); true;");
        await until(() => evaluate("document.getElementById('global-hotkey-input').value === 'Alt+Space'"), '常规设置未加载');
        assert.strictEqual(await evaluate("document.querySelectorAll('.plugin-management-item').length"), 0, '常规设置不应提前加载管理列表');
        await evaluate("document.getElementById('save-settings-btn').click(); true;");
        await until(() => evaluate("!document.getElementById('settings-modal').classList.contains('show')"), '常规设置未保存');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'))).pluginSearchSettings['默认插件'], { enabled: false, keywords: ['原有关键词'] });
        const hostDispatch = await evaluate(`require('electron').ipcRenderer.invoke('execute-super-panel-action', ${JSON.stringify({ action: { type: 'plugin', pluginPath: item.path, feature: item.features[0] }, clipboardText: '验收文本' })})`);
        assert(hostDispatch.success, '主进程功能派发未成功');
        manager.pluginDir = path.resolve(__dirname, '../app/software');
        manager.catalog = new PluginCatalog(manager.pluginDir);
        const realCount = (await manager.getPluginList()).length;
        const managementStarted = Date.now();
        await evaluate("document.getElementById('settings-btn').click(); document.querySelector('[data-target=\"plugins\"]').click(); true;");
        await until(() => evaluate(`document.querySelectorAll('.plugin-management-item[data-engine=tools]').length === ${realCount}`), '真实插件目录管理列表未完整加载');
        const realManagementMs = Date.now() - managementStarted;
        assert.strictEqual(await evaluate("[...document.querySelectorAll('[data-setting=\"showInMainUI\"]')].every(input => input.checked)"), true);
        assert.strictEqual(await evaluate("[...document.querySelectorAll('[data-setting=\"autoStartWithMain\"]')].every(input => !input.checked)"), true);
        win.setSize(1000, 680);
        await new Promise(resolve => setTimeout(resolve, 350));
        fs.writeFileSync(path.join(output, 'real-plugin-management.png'), (await win.webContents.capturePage()).toPNG());
        assert.deepStrictEqual(unhandled.map(error => error.message), []);
        console.log('Full host UI passed: startup, failure isolation, hidden recovery, independent controls, persisted disk, write failure rollback, safe names, two sizes, new/reused action');
        console.log(JSON.stringify({ timings, realCount, realManagementMs, screenshots: output }));
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ success: true, timings, realCount, realManagementMs, screenshots: output, isolatedProfile: true, hidden: true }, null, 2));
    } finally {
        clearTimeout(timeout);
    }
    app.isQuiting = true;
    app.quit();
})().catch(error => {
    console.error(error);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ success: false, error: error.stack || String(error), isolatedProfile: true, hidden: true }, null, 2));
    app.exit(1);
});

app.once('quit', () => {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { }
});
