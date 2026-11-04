const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, globalShortcut, session, dialog } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');
const root = process.argv[2], phase = process.argv[3];
if (!root || !['write', 'restart'].includes(phase)) throw new Error('需要测试根目录和阶段');
const profile = path.join(root, 'profile'), toolsDir = path.join(root, 'tools'), pythonDir = path.join(root, 'python');
const configDir = path.join(root, '原配置'), nextConfig = path.join(root, '新配置');
const settingsPath = path.join(profile, 'settings.json');
const output = path.resolve(__dirname, '../dist/merged-settings-persistence-validation');
const names = ['关键词A', '关键词B'];
const pyId = 'python:fixture/run.py';
if (phase === 'write') {
    for (const dir of [profile, toolsDir, pythonDir, configDir, nextConfig]) fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < names.length; index++) {
        const dir = path.join(toolsDir, `tool-${index}`); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ pluginName: names[index], main: 'index.html', description: '设置保存隔离测试' }));
        fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>安全测试</p>');
    }
    const dir = path.join(pythonDir, 'fixture'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ name: 'Python隔离插件', main_file: 'run.py' }));
    fs.writeFileSync(path.join(dir, 'run.py'), 'raise RuntimeError("禁止运行业务")');
    fs.writeFileSync(path.join(configDir, '用户配置.json'), '{"preserve":"配置原字节"}\n');
    fs.writeFileSync(settingsPath, JSON.stringify({ globalHotkey: 'Alt+Space', pinHotkey: 'Ctrl+D', superPanelHotkey: '', autoStart: false, enableRightClickPanel: false, rightClickDelay: 350, pythonMode: 'none', migrationPrompted: true, customPluginConfigDir: configDir, pythonPluginConfigDir: configDir, unrelatedSettings: { nested: '保持原值' }, pluginSearchSettings: { [names[0]]: { enabled: false, keywords: ['旧A'], extra: '保留A字段' }, [names[1]]: { enabled: true, keywords: ['旧B'], extra: '保留B字段' } } }), 'utf8');
}
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_ACCEPTANCE = '1';
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.setLoginItemSettings = () => {};
const registered = new Map();
globalShortcut.register = (key, callback) => { if (registered.has(key)) return false; registered.set(key, callback); return true; };
globalShortcut.unregister = key => registered.delete(key);
globalShortcut.unregisterAll = () => registered.clear();
globalShortcut.isRegistered = key => registered.has(key);
class FixtureManager extends RealManager { constructor(win, options) { super(win, options); this.pluginDir = toolsDir; this.catalog = new PluginCatalog(toolsDir); } }
class FixturePython extends pythonModule.PythonManager { constructor(options) { super({ ...options, pluginDir: pythonDir }); } async run() { throw new Error('禁止测试运行业务'); } }
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
const selectedPaths = [];
dialog.showOpenDialog = async () => ({ canceled: !selectedPaths.length, filePaths: selectedPaths.shift() || [] });
const report = { phase, assertions: [], errors: [], isolatedProfile: true, processId: process.pid };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
process.on('unhandledRejection', error => report.errors.push(String(error)));
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })));
const ready = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => resolve(win))));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 250; i++) { if (await fn()) return; await delay(20); } throw new Error(label || '界面等待超时'); }
const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
require('../main');
(async () => {
    const win = await ready; win.isFocused = () => true; win.webContents.setBackgroundThrottling(false);
    const evaluate = code => win.webContents.executeJavaScript(code);
    const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click(); true;`);
    const idle = () => until(() => evaluate("settingsReady && !settingsLoading && !settingsSaving && !document.getElementById('save-settings-btn').disabled"), '设置未进入可保存状态');
    try {
        await until(() => evaluate("typeof cachedPlugins!=='undefined' && cachedPlugins?.length>0"), '插件主页面未初始化');
        await evaluate("window.confirm=()=>true;window.__saveCalls=0;window.__loadGates=[];window.__saveRelease=null;const ipc=require('electron').ipcRenderer;window.__invoke=ipc.invoke.bind(ipc);ipc.invoke=(channel,...args)=>{if(channel==='save-settings')window.__saveCalls++;const value=window.__invoke(channel,...args);if(channel==='get-settings'&&window.__delayLoad){window.__delayLoad=false;return value.then(result=>new Promise(resolve=>window.__loadGates.push(()=>resolve(result))));}if(channel==='save-settings'&&window.__delaySave){window.__delaySave=false;return value.then(result=>new Promise(resolve=>window.__saveRelease=()=>resolve(result)));}return value;};true;");
        if (phase === 'restart') {
            const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json'), 'utf8'));
            assert.deepEqual(read(), expected, '新进程启动不改写已保存设置');
            await click('settings-btn'); await idle();
            check(await evaluate("document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F11' && document.getElementById('super-panel-hotkey-input').value==='Ctrl+Alt+F10' && document.getElementById('right-click-delay-slider').value==='600'"), '独立新进程重新读取快捷键和常规偏好');
            check(await evaluate(`document.getElementById('python-config-path').value===${JSON.stringify(nextConfig)}`), '独立新进程重新读取配置目录');
            const list = await evaluate("require('electron').ipcRenderer.invoke('get-plugin-management-list')");
            const py = list.find(item => item.id === pyId);
            check(py.pluginSettings.autoStartWithMain && !py.pluginSettings.showInMainUI, '独立新进程保留Python即时管理开关');
            check(read().pluginSearchSettings[names[0]].keywords[0] === '失败后重试A' && read().pluginSearchSettings[names[1]].keywords[0] === '外部更新B', '独立新进程保留两个插件各自关键词');
            check(JSON.stringify(read().unrelatedSettings) === '{"nested":"保持原值"}', '独立新进程保留无关原配置');
        } else {
            await evaluate("window.__delayLoad=true;document.getElementById('settings-btn').click();true;");
            await until(() => evaluate('window.__loadGates.length===1'), '首次设置读取未进入延迟门');
            check(await evaluate("document.getElementById('save-settings-btn').disabled && document.getElementById('global-hotkey-input').disabled"), '首次读取完成前禁止空值或旧值保存');
            await click('save-settings-btn'); check(await evaluate('window.__saveCalls===0'), '读取中点击保存不会提交空快捷键');
            await evaluate('window.__loadGates.shift()();true;'); await idle();
            check(await evaluate("document.getElementById('global-hotkey-input').value==='Alt+Space'"), '首次读取完成后正常显示并解锁原设置');
            await click('settings-close-btn');
            await evaluate("window.__delayLoad=true;window.openPluginManagement('tools');true;");
            await until(() => evaluate('window.__loadGates.length===1'), '旧设置读取未进入延迟门');
            await click('settings-close-btn');
            await evaluate("window.__invoke('save-settings',{rightClickDelay:600})");
            await click('python-quick-settings'); await idle();
            await until(() => evaluate("document.getElementById('merge-python').classList.contains('active')"));
            await evaluate('window.__loadGates.shift()();true;'); await delay(80);
            check(await evaluate("document.getElementById('right-click-delay-slider').value==='600' && document.getElementById('merge-python').classList.contains('active')"), '关闭后的旧读取响应不覆盖新会话值或抢回旧页面');
            await evaluate("window.activateSettingsTab('shortcuts');document.getElementById('global-hotkey-input').value='Ctrl+Alt+F12';document.getElementById('global-hotkey-input').dispatchEvent(new Event('input',{bubbles:true}));window.__delaySave=true;true;");
            await click('save-settings-btn');
            await until(() => evaluate("typeof window.__saveRelease==='function'"), '保存未进入延迟门');
            check(read().globalHotkey === 'Ctrl+Alt+F12', '延迟响应前磁盘保存的是本次提交快照');
            check(await evaluate("document.getElementById('global-hotkey-input').disabled && document.getElementById('save-settings-btn').disabled"), '保存中锁定通用输入并防重复提交');
            await evaluate("document.getElementById('global-hotkey-input').value='Ctrl+Alt+F11';document.getElementById('global-hotkey-input').dispatchEvent(new Event('input',{bubbles:true}));window.__saveRelease();window.__saveRelease=null;true;");
            await idle();
            check(await evaluate("document.getElementById('settings-modal').classList.contains('show') && document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F11' && hasUnsavedSettings()"), '较晚到达的新输入不会被响应快照误标为已保存或丢弃');
            check(read().globalHotkey === 'Ctrl+Alt+F12', '保留的新输入未被悄悄写入磁盘');
            await click('save-settings-btn'); await until(() => read().globalHotkey === 'Ctrl+Alt+F11');
            await click('settings-btn'); await idle();
            await evaluate("window.activateSettingsTab('shortcuts');document.getElementById('super-panel-hotkey-input').value='Ctrl+Alt+F10';true;");
            const originalWrite = fs.writeFileSync;
            fs.writeFileSync = (file, ...args) => { if ([settingsPath, `${settingsPath}.tmp`].includes(String(file))) throw new Error('隔离设置写入失败'); return originalWrite(file, ...args); };
            try {
                await click('save-settings-btn'); await idle();
                check(await evaluate("document.getElementById('settings-modal').classList.contains('show') && document.getElementById('super-panel-hotkey-input').value==='Ctrl+Alt+F10'"), '真实落盘失败保留设置窗口与输入供重试');
                check(read().superPanelHotkey === '', '真实落盘失败不改写旧设置');
            } finally { fs.writeFileSync = originalWrite; }
            await click('save-settings-btn'); await until(() => read().superPanelHotkey === 'Ctrl+Alt+F10');
            await evaluate("window.openPluginManagement('tools')"); await idle();
            const keyword = name => `([...document.querySelectorAll('.pm-keyword-input')].find(input=>input.dataset.pluginName===${JSON.stringify(name)}))`;
            const current = read(); current.pluginSearchSettings[names[1]].keywords = ['外部更新B'];
            await evaluate(`window.__invoke('save-settings',{pluginSearchSettings:${JSON.stringify(current.pluginSearchSettings)}})`);
            await evaluate(`${keyword(names[0])}.value='更新A';${keyword(names[0])}.dispatchEvent(new Event('change',{bubbles:true}));true;`);
            await until(() => read().pluginSearchSettings[names[0]].keywords[0] === '更新A');
            check(read().pluginSearchSettings[names[1]].keywords[0] === '外部更新B', '陈旧管理列表修改一个关键词不覆盖其他插件新配置');
            check(read().pluginSearchSettings[names[0]].enabled === false && read().pluginSearchSettings[names[0]].extra === '保留A字段', '修改关键词保留原搜索禁用和附加字段');
            await evaluate(`${keyword(names[0])}.focus();${keyword(names[0])}.value='Esc尚未提交A';${keyword(names[0])}.dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>false;document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true;`);
            check(await evaluate(`${keyword(names[0])}.value==='Esc尚未提交A' && document.getElementById('settings-modal').classList.contains('show') && hasUnsavedSettings()`), '关键词尚未失焦时Esc关闭也会保护输入');
            await evaluate("window.confirm=()=>true;document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true;");
            await delay(80);
            check(read().pluginSearchSettings[names[0]].keywords[0] === '更新A', '确认放弃尚未提交关键词后不在隐藏页面自动保存');
            await evaluate("window.openPluginManagement('tools')"); await idle();
            fs.writeFileSync = (file, ...args) => { if ([settingsPath, `${settingsPath}.tmp`].includes(String(file))) throw new Error('隔离关键词写入失败'); return originalWrite(file, ...args); };
            try {
                await evaluate(`${keyword(names[0])}.value='失败后重试A';${keyword(names[0])}.dispatchEvent(new Event('change',{bubbles:true}));true;`);
                await until(() => evaluate(`${keyword(names[0])}.getAttribute('aria-invalid')==='true' && !${keyword(names[0])}.disabled`));
                check(read().pluginSearchSettings[names[0]].keywords[0] === '更新A', '关键词保存失败保留磁盘旧值');
            } finally { fs.writeFileSync = originalWrite; }
            win.webContents.send('plugins:changed', { reason: 'isolated-refresh' }); await delay(100);
            check(await evaluate(`${keyword(names[0])}.value==='失败后重试A' && hasUnsavedSettings()`), '关键词失败草稿在目录刷新后仍保留');
            await click('save-settings-btn'); await until(() => read().pluginSearchSettings[names[0]].keywords[0] === '失败后重试A');
            check(read().globalHotkey === 'Ctrl+Alt+F11', '重试即时关键词不覆盖通用偏好');
            await evaluate("window.openPluginManagement('python')"); await idle();
            await evaluate(`document.querySelector('[data-plugin-id="${pyId}"] [data-setting=autoStartWithMain]').click();true;`);
            await until(() => read().pluginPreferences?.[pyId]?.autoStartWithMain === true);
            await evaluate(`document.querySelector('[data-plugin-id="${pyId}"] [data-setting=showInMainUI]').click();true;`);
            await until(() => read().pluginPreferences?.[pyId]?.showInMainUI === false);
            check(read().rightClickDelay === 600 && read().superPanelHotkey === 'Ctrl+Alt+F10' && read().unrelatedSettings.nested === '保持原值', '即时插件开关保留常规偏好与无关配置');
            await evaluate("window.activateSettingsTab('general');true;"); selectedPaths.push([nextConfig]); await click('python-config-choose');
            await until(() => read().customPluginConfigDir === nextConfig && read().pythonPluginConfigDir === nextConfig);
            check(fs.readFileSync(path.join(nextConfig, '用户配置.json'), 'utf8') === '{"preserve":"配置原字节"}\n', '目录切换只复制配置且保留原字节');
            await evaluate("window.activateSettingsTab('shortcuts');document.getElementById('change-hotkey-btn').click();true;");
            await until(() => evaluate("isCapturingHotkey && document.getElementById('change-hotkey-btn').textContent==='取消录入'"));
            await click('save-settings-btn'); await until(() => evaluate("!document.getElementById('settings-modal').classList.contains('show')"));
            check(read().globalHotkey === 'Ctrl+Alt+F11' && !registered.has('Alt+Space'), '未完成快捷键录入时保存会取消录入并保留原绑定');
            fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify(read()), 'utf8');
        }
        check(report.errors.length === 0, '设置回归没有未处理异常'); report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify(report, null, 2), 'utf8'); console.log(JSON.stringify(report)); app.isQuiting = true; app.exit(report.success ? 0 : 1); }
})().catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('设置持久化验收超时'); app.exit(2); }, 60000).unref();
