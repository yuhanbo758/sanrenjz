const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, dialog, session } = require('electron');
const RealManager = require('../app/software_manager');
const { PluginCatalog } = require('../app/plugin-catalog');
const pythonModule = require('../app/python-manager');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-搜索运行 中文-'));
const profile = path.join(root, 'profile');
const toolsDir = path.join(root, '效率插件');
const pythonDir = path.join(root, 'Python 插件');
const snippetsDir = path.join(root, '片段目录');
for (const directory of [profile, toolsDir, pythonDir, snippetsDir]) fs.mkdirSync(directory);
const output = path.resolve(__dirname, '../dist/merged-search-actions-validation');
fs.mkdirSync(output, { recursive: true });
const report = { assertions: [], errors: [], isolatedProfile: true, hidden: true, clipboardAndHideIntercepted: true };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
const toolName = '隔离功能工具';
const hiddenName = '隐藏效率工具';
const pyId = 'python:隐藏 Python/run.py';
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
    migrationPrompted: true, pythonMode: 'none', autoStart: false, enableRightClickPanel: false,
    pluginPreferences: { [hiddenName]: { showInMainUI: false }, [pyId]: { showInMainUI: false } }
}), 'utf8');
function tool(folder, name, features = [], valid = true) {
    const directory = path.join(toolsDir, folder); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: name, main: valid ? 'index.html' : 'missing.html', description: '隔离回归', features }), 'utf8');
    if (valid) fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><p>安全的隔离窗口</p><script>
        window.actions=[];window.exports={
          'static-fixture':{mode:'none',args:{enter(code){window.actions.push(code);}}},
          'dynamic-fixture':{mode:'none',args:{enter(code){window.actions.push(code);}}},
          'fail-fixture':{mode:'none',args:{enter(){throw new Error('隔离功能处理失败');}}}
        };
    </script>`, 'utf8');
    return directory;
}
const goodPath = tool('good', toolName, [
    { code: 'static-fixture', explain: '静态验证', cmds: ['静态验收入口'] },
    { code: 'fail-fixture', explain: '失败验证', cmds: ['故障功能验收'] }
]);
const badPath = tool('bad', '失败插件', [], false);
tool('hidden', hiddenName);
tool('snippet', '余汉波文本片段助手');
const pythonFolder = path.join(pythonDir, '隐藏 Python'); fs.mkdirSync(pythonFolder);
fs.writeFileSync(path.join(pythonFolder, 'settings.json'), JSON.stringify({ name: '隐藏 Python 程序', main_file: 'run.py', description: 'Python 搜索验收' }), 'utf8');
fs.writeFileSync(path.join(pythonFolder, 'run.py'), 'raise RuntimeError("禁止运行真实业务")\n', 'utf8');
const snippetText = '# 标题\n仅在隔离 IPC 中验证，不写系统剪贴板。';
fs.writeFileSync(path.join(snippetsDir, '隔离片段 验证.md'), snippetText, 'utf8');
fs.mkdirSync(path.join(profile, 'plugin-data'));
fs.writeFileSync(path.join(profile, 'plugin-data', '余汉波文本片段助手-storage.json'), JSON.stringify({ 'snippets-settings': { snippetsPaths: [snippetsDir] } }), 'utf8');

let manager, pythonMode = 'normal';
const pythonCalls = [];
class FixtureManager extends RealManager {
    constructor(win, options) { super(win, options); this.pluginDir = toolsDir; this.catalog = new PluginCatalog(toolsDir); manager = this; }
}
class FixturePython extends pythonModule.PythonManager {
    constructor(options) { super({ ...options, pluginDir: pythonDir }); }
    async run(id, options = {}) {
        pythonCalls.push({ id, options });
        if (pythonMode === 'failure') return { success: false, error: '隔离 Python 启动失败' };
        if (pythonMode === 'dependencies' && !options.installDependencies) return { requiresDependencies: true, packages: ['isolated-required-package'] };
        return { success: true };
    }
}
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_ACCEPTANCE = '1';
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
const dialogResponses = [], messages = [], inserted = [];
let hideRequests = 0, failInsertion = false;
dialog.showMessageBox = async (_window, options) => { messages.push(options); return { response: dialogResponses.shift() ?? 0 }; };
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://gdsx.sanrenjz.com/*'] }, (_details, callback) => callback({ cancel: true })));
process.on('unhandledRejection', error => report.errors.push(String(error)));
const mainReady = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => resolve(win))));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) { if (await fn()) return; await delay(25); }
    throw new Error(message);
}
require('../main');
(async () => {
    await mainReady;
    // 仅截断桌面副作用；目录生成、插件命令和 Python 分发仍走真实宿主 IPC。
    ipcMain.removeHandler('insert-content');
    ipcMain.handle('insert-content', (_event, value) => { inserted.push(value); return failInsertion ? { success: false, error: '隔离片段写入失败 <标签>' } : { success: true }; });
    ipcMain.removeHandler('hide-search-window');
    ipcMain.handle('hide-search-window', () => { hideRequests++; return { success: true }; });
    const win = new BrowserWindow({ show: false, width: 820, height: 600, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    const evaluate = value => win.webContents.executeJavaScript(value);
    const invoke = (channel, ...args) => evaluate(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},...${JSON.stringify(args)})`);
    const input = async text => {
        await evaluate(`searchInput.value=${JSON.stringify(text)};searchInput.dispatchEvent(new Event('input',{bubbles:true}));true;`);
        await delay(90); await until(() => evaluate('searchFrame===0'), '搜索帧未完成');
    };
    const key = (name, extra = {}) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(name)},bubbles:true,...${JSON.stringify(extra)}}));true;`);
    const select = async text => { await input(text); await key('Enter'); await until(() => evaluate('!isExecuting'), '动作未结束'); };
    const refresh = async () => {
        const catalog = await invoke('search-catalog-get', { force: true });
        win.webContents.send('search-catalog-invalidated', { version: catalog.version });
        await until(() => evaluate(`catalogVersion===${catalog.version}`), '搜索目录未刷新');
        return catalog;
    };
    try {
        await win.loadFile(path.resolve(__dirname, '../search-window.html'));
        await until(() => evaluate('plugins.length===5'), '完整搜索目录未加载');
        check((await invoke('get-main-plugin-list')).length === 3, '隐藏的效率和 Python 程序不出现在主页面');
        check(await evaluate('plugins.some(item=>item.name==="隐藏效率工具") && plugins.some(item=>item.id===\'python:隐藏 Python/run.py\')'), '快捷搜索保留两类隐藏插件');
        check(await evaluate('pluginContents.some(item=>item.contentType==="text-snippet" && item.title==="隔离片段 验证")'), '真实宿主读取隔离 Markdown 片段目录');

        await select('静态验收入口');
        await until(() => manager.pluginWindows.has(toolName), '命令没有创建插件窗口');
        const toolWindow = manager.pluginWindows.get(toolName);
        check((await toolWindow.webContents.executeJavaScript('window.actions')).includes('static-fixture'), '静态命令通过真实 PluginManager 派发到功能处理器');
        await invoke('register-plugin-features', toolName, [{ code: 'dynamic-fixture', explain: '动态验证', cmds: ['动态验收入口'] }]);
        await refresh(); await select('动态验收入口');
        check((await toolWindow.webContents.executeJavaScript('window.actions')).includes('dynamic-fixture'), '动态功能注册、目录刷新与实际功能调用完整');
        let beforeHide = hideRequests; await select('故障功能验收');
        check(hideRequests === beforeHide && await evaluate('document.querySelector(".notification-message").textContent.includes("隔离功能处理失败")'), '功能处理器失败沿 PluginManager 和主进程返回，不假报成功');
        const featureFailure = await invoke('run-plugin-action', { pluginPath: goodPath, feature: { code: 'fail-fixture' }, clipboardText: '' });
        check(featureFailure?.success === false, '直接功能 IPC 同样保留功能处理器失败');

        const beforePython = pythonCalls.length; await select('隐藏 Python');
        check(pythonCalls.length === beforePython + 1 && pythonCalls.at(-1).id === pyId, '隐藏 Python 条目按稳定 ID 通过 unified:run 分发');
        pythonMode = 'dependencies'; dialogResponses.push(0);
        let before = pythonCalls.length; beforeHide = hideRequests; await select('隐藏 Python');
        check(pythonCalls.length === before + 1 && hideRequests === beforeHide && messages.at(-1).detail.includes('isolated-required-package'), '缺少依赖先展示计划，取消不安装也不关闭搜索');
        dialogResponses.push(1); before = pythonCalls.length; await select('隐藏 Python');
        check(pythonCalls.length === before + 2 && pythonCalls.at(-1).options.installDependencies === true, '确认依赖后第二次分发明确携带安装授权');
        pythonMode = 'failure'; beforeHide = hideRequests; await select('隐藏 Python');
        check(hideRequests === beforeHide && messages.at(-1).message.includes('启动失败'), 'Python 启动失败保留搜索并显示失败原因');
        pythonMode = 'normal';

        await select('隔离片段 验证');
        check(inserted.at(-1).content === snippetText && inserted.at(-1).directInsert === true, '片段 Enter 传递完整内容与直接插入意图，不触碰真实剪贴板');
        failInsertion = true; beforeHide = hideRequests; await select('隔离片段 验证');
        check(await evaluate('document.querySelector(".notification-message").textContent.includes("写入失败 <标签>") && !document.querySelector(".notification-message 标签")'), '片段失败可见且错误文本不会被当成 HTML');
        check(hideRequests === beforeHide, '片段操作失败不隐藏搜索');
        failInsertion = false;

        const failure = await invoke('run-plugin', badPath, []);
        check(failure?.success === false, '旧运行 IPC 返回真实插件失败');
        const unifiedFailure = await invoke('unified:run', 'tools:bad');
        check(unifiedFailure?.success === false, '统一运行 IPC 不把失败插件报告成功');
        beforeHide = hideRequests; await select('失败插件');
        check(hideRequests === beforeHide && await evaluate('document.querySelector(".notification-message").textContent.includes("主文件不存在")'), '效率插件失败保留搜索并展示原因');

        await input('隐藏 Python'); before = pythonCalls.length;
        await evaluate("searchInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));searchInput.value='中文候选';searchInput.dispatchEvent(new Event('input',{bubbles:true}));true;");
        await key('Enter', { isComposing: true }); await key('ArrowDown', { isComposing: true }); await delay(150);
        check(pythonCalls.length === before && await evaluate('selectedIndex===0'), '中文输入法确认和方向键不启动旧结果或移动搜索选择');
        await evaluate("searchInput.value='隐藏效率';searchInput.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));true;");
        await until(() => evaluate('searchFrame===0 && filteredResults[0]?.name==="隐藏效率工具"'), '输入法提交后未更新最终查询');
        check(true, '输入法提交后正常按最终中文查询刷新结果');
        await input('隐藏 Python'); before = pythonCalls.length;
        await evaluate("searchInput.value='根本不存在的新查询';searchInput.dispatchEvent(new Event('input',{bubbles:true}));document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));true;");
        await delay(160);
        check(pythonCalls.length === before && await evaluate('filteredResults.length===0'), '快速输入后立即回车使用最新查询，不执行旧结果');
        await input('隐藏 Python'); before = pythonCalls.length;
        await evaluate("searchInput.value='不存在的点击查询';searchInput.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.result-item').click();true;");
        await delay(140);
        check(pythonCalls.length === before && await evaluate('filteredResults.length===0'), '待重绘期间点击旧结果先刷新，不误运行旧条目');
        await input('隐藏 Python'); before = pythonCalls.length;
        await key('Enter', { keyCode: 229 }); await delay(120);
        check(pythonCalls.length === before, '兼容输入法 keyCode229 确认事件，不误启动程序');
        await input('隐藏 Python'); before = pythonCalls.length;
        await key('Enter', { repeat: true }); await delay(120);
        check(pythonCalls.length === before, '按住回车的重复事件不会重复启动插件');

        await invoke('unified:preference', pyId, 'showInMainUI', true);
        let catalog = await refresh();
        check(catalog.plugins.some(item => item.id === pyId), '显示偏好变化后搜索仍保持 Python 目录');
        fs.rmSync(path.join(toolsDir, 'hidden'), { recursive: true, force: true });
        await invoke('refresh-plugins'); catalog = await refresh();
        check(!catalog.plugins.some(item => item.name === hiddenName) && await evaluate('!plugins.some(item=>item.name==="隐藏效率工具")'), '移除插件并刷新后主进程与搜索页面都清除旧条目');

        await key('d', { ctrlKey: true });
        // 钉住状态先由 IPC 返回，显示文本需等后续状态查询；同时等待业务值和界面。
        await until(() => evaluate('isPinned===true && pinStatus.textContent.includes("已钉住")'), '钉住状态未同步');
        check(await evaluate('pinStatus.textContent.includes("已钉住")'), 'Ctrl+D 与真实宿主钉住状态同步');
        beforeHide = hideRequests; await key('Escape'); await delay(80);
        check(hideRequests === beforeHide + 1, '已钉住时显式 Escape 仍可关闭搜索');
        beforeHide = hideRequests; await evaluate("window.dispatchEvent(new Event('blur'));true;"); await delay(260);
        check(hideRequests === beforeHide, '钉住时失去焦点继续保留搜索');
        await key('D', { ctrlKey: true }); await until(() => evaluate('isPinned===false && !pinStatus.textContent.includes("已钉住")'), '取消钉住未同步');
        check(await evaluate('!pinStatus.textContent.includes("已钉住")'), '再次 Ctrl+D 正常解除钉住');
        check(report.errors.length === 0, '真实搜索动作没有未处理页面异常');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        report.pythonDispatches = pythonCalls.length;
        report.hideRequests = hideRequests;
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
        console.log(JSON.stringify(report)); app.isQuiting = true; app.exit(report.success ? 0 : 1);
    }
})().catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('搜索宿主回归超时'); app.exit(2); }, 80000).unref();
app.once('quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
