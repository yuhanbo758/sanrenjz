const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog, session } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');
const environmentModule = require('../app/python-environment');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-插件设置 空格-'));
const profile = path.join(root, 'profile');
const toolsDir = path.join(root, '效率插件');
const pythonDir = path.join(root, 'Python 插件');
for (const directory of [profile, toolsDir, pythonDir]) fs.mkdirSync(directory);
const output = path.resolve(__dirname, '../dist/merged-plugin-management-validation');
fs.mkdirSync(output, { recursive: true });
const report = { assertions: [], errors: [], hidden: true, isolatedProfile: true };
const check = (condition, label) => { assert(condition, label); report.assertions.push(label); };
const settingsPath = path.join(profile, 'settings.json');
const sharedName = '同名\'与&中文插件';
const pyId = 'python:中文 插件/run.py';
const hiddenId = 'python:隐藏插件/run.py';
fs.writeFileSync(settingsPath, JSON.stringify({
    pythonMode: 'none', enableRightClickPanel: false, autoStart: false, migrationPrompted: true,
    pluginPreferences: { [hiddenId]: { showInMainUI: false, autoStartWithMain: false } },
    pluginSearchSettings: { [sharedName]: { enabled: false, keywords: ['保留关键词'] } }
}), 'utf8');
function createTool(folder, name) {
    const directory = path.join(toolsDir, folder); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: name, main: 'index.html', description: '效率描述' }), 'utf8');
    fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><p>仅用于隔离验收</p>', 'utf8');
}
function createPython(directory, name) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({ name, description: 'Python 管理搜索描述', main_file: 'run.py', config_file: 'config.json' }), 'utf8');
    fs.writeFileSync(path.join(directory, 'run.py'), 'raise RuntimeError("验收不得启动 Python 业务")\n', 'utf8');
    fs.writeFileSync(path.join(directory, 'config.json'), '{"template":true}\n', 'utf8');
    fs.writeFileSync(path.join(directory, 'README.md'), '# 隔离插件说明\n', 'utf8');
}
createTool('same-name', sharedName);
createPython(path.join(pythonDir, '中文 插件'), sharedName);
createPython(path.join(pythonDir, '隐藏插件'), '隐藏 Python 程序');

process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_ACCEPTANCE = '1';
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://gdsx.sanrenjz.com/*'] }, (_details, callback) => callback({ cancel: true })));
let manager, python, inspections = 0, launches = 0;
class FixtureManager extends RealManager {
    constructor(win, options) { super(win, options); this.pluginDir = toolsDir; this.catalog = new PluginCatalog(toolsDir); manager = this; }
}
class FixturePython extends pythonModule.PythonManager {
    constructor(options) { super({ ...options, pluginDir: pythonDir }); python = this; }
    async run() { launches++; throw new Error('验收禁止启动 Python'); }
}
class FixtureEnvironment extends environmentModule.PythonEnvironment {
    async resolve() { inspections++; throw new Error('管理设置不得检查解释器'); }
    async discover() { inspections++; throw new Error('管理设置不得扫描解释器'); }
    async install() { inspections++; throw new Error('管理设置不得安装环境'); }
}
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
require.cache[require.resolve('../app/python-environment')].exports = { ...environmentModule, PythonEnvironment: FixtureEnvironment };
const selectedPaths = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selectedPaths.shift() || [] });
dialog.showMessageBox = async () => ({ response: 0 });
process.on('unhandledRejection', error => report.errors.push(String(error)));
const ready = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => resolve(win))));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(checker, message) {
    const expires = Date.now() + 10000;
    while (Date.now() < expires) { if (await checker()) return; await delay(25); }
    throw new Error(message);
}
require('../main');
(async () => {
    const win = await ready;
    const evaluate = script => win.webContents.executeJavaScript(script);
    const invoke = (channel, ...args) => evaluate(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`);
    const row = id => `[...document.querySelectorAll('.plugin-management-item')].find(row=>row.dataset.pluginId===${JSON.stringify(id)})`;
    const toggle = (id, setting) => evaluate(`${row(id)}.querySelector('[data-setting="${setting}"]').click(); true;`);
    const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    try {
        await until(() => evaluate("typeof cachedPlugins!=='undefined' && cachedPlugins?.length===2"), '主页面目录未初始化');
        await evaluate("window.confirm=()=>true; document.getElementById('settings-btn').click(); document.querySelector('[data-target=plugins]').click(); true;");
        await until(() => evaluate("document.querySelectorAll('.plugin-management-item').length===3"), '管理列表没有同时显示两类和隐藏插件');
        const initial = await evaluate(`(() => { const p=${row(pyId)}; return { engine:document.getElementById('plugin-manager-engine').value, same:[...document.querySelectorAll('.pm-name')].filter(n=>n.textContent===${JSON.stringify(sharedName)}).length, show:p.querySelector('[data-setting=showInMainUI]').checked, auto:p.querySelector('[data-setting=autoStartWithMain]').checked, keywords:!!p.querySelector('.pm-keyword-input'), switches:p.querySelectorAll('.switch').length, panel:!!p.querySelector('[data-action=super-panel]') }; })()`);
        assert.deepEqual(initial, { engine: 'all', same: 2, show: true, auto: false, keywords: false, switches: 0, panel: false });
        check(true, '默认全部类型；同名与特殊字符安全；Python 默认显示不自启并仅提供有效选项');
        check((await invoke('get-plugin-management-list')).length === 3, '实际主进程管理目录包括隐藏 Python 插件');
        check(!fs.existsSync(path.join(profile, 'python-plugin-configs')), '只浏览管理列表不创建用户配置');

        await toggle(pyId, 'autoStartWithMain');
        await until(() => readSettings().pluginPreferences[pyId]?.autoStartWithMain === true, 'Python 自启动没有写入磁盘');
        check(launches === 0 && inspections === 0, '勾选自启动仅保存，不启动业务或检查 Python');
        check(!readSettings().pluginPreferences[sharedName], '同名 Python 管理选项不串写效率插件');
        await toggle(pyId, 'showInMainUI');
        await until(async () => (await invoke('get-main-plugin-list')).every(p => p.id !== pyId), '隐藏未更新主页面目录');
        check((await invoke('get-plugin-management-list')).some(p => p.id === pyId), '隐藏后管理列表继续保留');
        const catalog = await invoke('search-catalog-get');
        check(catalog.plugins.some(p => p.id === pyId), '隐藏的 Python 插件仍可快捷搜索');
        await until(() => evaluate(`Boolean(${row(pyId)})`), '管理列表刷新丢失 Python 行');
        await toggle(pyId, 'showInMainUI');
        await until(() => readSettings().pluginPreferences[pyId].showInMainUI === true, '恢复显示未保存');
        check(readSettings().pluginPreferences[pyId].autoStartWithMain === true, '显示和自启动独立保存');

        const originalWrite = fs.writeFileSync;
        fs.writeFileSync = (file, ...args) => {
            if ([settingsPath, `${settingsPath}.tmp`].includes(String(file))) throw new Error('模拟配置落盘失败');
            return originalWrite(file, ...args);
        };
        try {
            await toggle(pyId, 'showInMainUI');
            await until(() => evaluate(`!${row(pyId)}.querySelector('[data-setting=showInMainUI]').disabled`), '失败没有解除控件禁用');
            check(await evaluate(`${row(pyId)}.querySelector('[data-setting=showInMainUI]').checked`), '设置写入失败时开关回退');
            check(readSettings().pluginPreferences[pyId].showInMainUI, '保存失败保留旧磁盘值');
        } finally { fs.writeFileSync = originalWrite; }

        await evaluate("document.getElementById('plugin-manager-engine').value='python'; document.getElementById('plugin-manager-engine').dispatchEvent(new Event('change')); document.getElementById('plugin-manager-search').value='Python 管理搜索'; document.getElementById('plugin-manager-search').dispatchEvent(new Event('input')); true;");
        check(await evaluate("[...document.querySelectorAll('.plugin-management-item')].filter(row=>row.style.display!=='none').length===2"), '类型和描述搜索组合过滤 Python 插件');
        await evaluate("document.getElementById('plugin-manager-search').value='无匹配'; document.getElementById('plugin-manager-search').dispatchEvent(new Event('input')); true;");
        check(await evaluate("[...document.querySelectorAll('.plugin-management-item')].every(row=>row.style.display==='none')"), '无匹配搜索隐藏全部行');
        await evaluate("document.getElementById('plugin-manager-search').value=''; document.getElementById('plugin-manager-search').dispatchEvent(new Event('input')); true;");
        await evaluate(`${row(pyId)}.querySelector('.pm-header').click(); true;`);
        check(await evaluate(`${row(pyId)}.querySelector('.pm-details').classList.contains('expanded')`), 'Python 条目可展开管理操作');
        await evaluate(`${row(pyId)}.querySelector('[data-action=python-logs]').click(); true;`);
        await until(() => evaluate("document.getElementById('python-logs-dialog').open"), '管理页日志按钮未打开');
        await evaluate("document.getElementById('python-logs-dialog').close(); true;");
        await evaluate(`${row(pyId)}.querySelector('[data-action=python-details]').click(); true;`);
        await until(() => evaluate("document.getElementById('python-details-dialog').open"), '管理页详情按钮未打开');
        check(await evaluate("document.getElementById('python-details-content').textContent.includes('隔离插件说明')"), '管理页详情沿用 Python 说明协议');
        await evaluate("document.getElementById('python-details-dialog').close(); true;");

        const imported = path.join(root, '待导入 插件'); createPython(imported, '新导入 Python');
        selectedPaths.push([imported]);
        const importResult = await invoke('unified:import', 'python-folder');
        check(importResult.success, '真实导入 IPC 复制登记 Python 插件');
        await until(() => evaluate("document.querySelectorAll('.plugin-management-item[data-engine=python]').length===3"), '导入没有刷新设置管理列表');
        const importedItem = (await invoke('get-plugin-management-list')).find(item => item.name === '新导入 Python');
        fs.mkdirSync(path.dirname(importedItem.configPath), { recursive: true });
        const preserved = '{"用户配置":"不得删除"}\n'; fs.writeFileSync(importedItem.configPath, preserved, 'utf8');
        const removeControl = `${row(importedItem.id)}.querySelector('[data-action=uninstall]')`;
        await evaluate(`${removeControl}.click(); true;`);
        await until(() => !fs.existsSync(importedItem.folderPath), '删除未移除导入的程序资源');
        await until(() => evaluate("document.querySelectorAll('.plugin-management-item[data-engine=python]').length===2"), '删除没有刷新设置管理列表');
        check(fs.readFileSync(importedItem.configPath, 'utf8') === preserved, '删除程序资源后保留用户配置原字节');
        check((await invoke('unified:list', { includeHidden: true })).every(item => item.id !== importedItem.id), '删除后统一目录同步刷新');
        check((await invoke('search-catalog-get')).plugins.every(item => item.id !== importedItem.id), '删除后快捷搜索目录同步刷新');

        for (const [width, height] of [[800, 600], [1000, 680]]) {
            win.setSize(width, height); await delay(80);
            check(await evaluate("(() => { const p=document.querySelector('.settings-main').getBoundingClientRect(); return [...document.querySelectorAll('.plugin-management-item')].filter(row=>row.style.display!=='none').every(row=>[...row.querySelectorAll('.pm-lifecycle input')].every(input=>{const r=input.getBoundingClientRect(); return r.left>=p.left && r.right<=p.right;})); })()"), `${width}x${height} Python 开关未溢出设置页`);
            fs.writeFileSync(path.join(output, `python-settings-${width}x${height}.png`), (await win.webContents.capturePage()).toPNG());
        }
        const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.webContents.reload(); await loaded;
        await evaluate("window.testAlerts=[]; window.alert=message=>window.testAlerts.push(message); document.getElementById('python-quick-settings').click(); true;");
        await until(() => evaluate("document.getElementById('merge-python').classList.contains('active') && Boolean(document.getElementById('global-hotkey-input').value)"), 'Python 快捷设置入口没有加载宿主设置');
        check(await evaluate("document.getElementById('global-hotkey-input').value==='Alt+Space' && document.getElementById('pin-hotkey-input').value==='Ctrl+D'"), '主页面 Python 快捷入口同步加载通用快捷键设置');
        await evaluate("document.getElementById('python-manage-plugins').click(); true;");
        await until(() => evaluate("document.querySelectorAll('.plugin-management-item').length===3"), '重新加载后管理列表未初始化');
        check(await evaluate(`document.getElementById('plugins').classList.contains('active') && document.getElementById('plugin-manager-engine').value==='python' && ${row(pyId)}.querySelector('[data-setting=autoStartWithMain]').checked && ${row(pyId)}.querySelector('[data-setting=showInMainUI]').checked`), '页面重载从磁盘读取 Python 选项，环境入口跳转统一管理');
        const beforeCompletion = { globalHotkey: readSettings().globalHotkey, pinHotkey: readSettings().pinHotkey };
        check(await evaluate("document.getElementById('save-settings-btn').textContent.trim()==='完成'"), '已即时保存的管理页提供完成操作');
        await evaluate("document.getElementById('save-settings-btn').click(); true;");
        await until(() => evaluate("!document.getElementById('settings-modal').classList.contains('show')"), 'Python 快捷入口进入管理后，完成未关闭设置');
        check(await evaluate("window.testAlerts.length===0"), '管理页完成不弹出阻塞式保存提示');
        assert.deepEqual({ globalHotkey: readSettings().globalHotkey, pinHotkey: readSettings().pinHotkey }, beforeCompletion);
        check(true, '管理页完成不隐式改写通用快捷键设置');
        await evaluate("document.getElementById('settings-btn').click(); true;");
        await until(() => evaluate("document.getElementById('global-hotkey-input').value==='Alt+Space'"), '通用设置未加载');
        await evaluate("document.getElementById('global-hotkey-input').value='Ctrl+Alt+F12'; document.querySelector('[data-target=merge-python]').click(); true;");
        await until(() => evaluate("document.getElementById('merge-python').classList.contains('active')"), '内部切换环境页失败');
        check(await evaluate("document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F12'"), '设置模态框内切换 Python 环境不覆盖未保存快捷键');
        await evaluate("document.getElementById('python-manage-plugins').click(); true;");
        await until(() => evaluate("document.getElementById('plugins').classList.contains('active')"), '内部跳转插件管理失败');
        check(await evaluate("document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F12'"), '内部跳转插件管理继续保留未保存快捷键');
        assert.deepEqual(readSettings().pluginSearchSettings[sharedName], { enabled: false, keywords: ['保留关键词'] });
        check(true, '整合保持效率插件已有搜索设置');
        check(launches === 0 && inspections === 0, '完整管理流程没有扫描安装 Python 或启动程序');
        check(report.errors.length === 0, '没有未处理的界面异常');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
        console.log(JSON.stringify(report));
        app.isQuiting = true; app.exit(report.success ? 0 : 1);
    }
})().catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('统一插件管理验收超时'); app.exit(2); }, 50000).unref();
app.once('quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
