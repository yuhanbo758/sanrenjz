const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, session, dialog } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');
const environmentModule = require('../app/python-environment');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-统一日志 空格-'));
const profile = path.join(root, 'profile');
const toolsDir = path.join(root, '效率插件');
const pythonDir = path.join(root, 'Python 插件');
for (const directory of [profile, toolsDir, pythonDir]) fs.mkdirSync(directory);
const output = path.resolve(__dirname, '../dist/unified-logs-validation'); fs.mkdirSync(output, { recursive: true });
const settingsPath = path.join(profile, 'settings.json');
const sharedName = '同名 中文日志插件';
const toolId = 'tools:same';
const jsId = 'tools:javascript';
const removedId = 'tools:retained';
const pyId = 'python:python/run.py';
const signal = path.join(root, 'continue-python.txt');
fs.writeFileSync(settingsPath, JSON.stringify({ pythonMode: 'none', autoStart: false, enableRightClickPanel: false, migrationPrompted: true,
    pluginPreferences: { [pyId]: { showInMainUI: false, autoStartWithMain: false } }, customMarker: '日志操作不得修改' }), 'utf8');
function tool(folder, name, script, main = 'index.html') {
    const directory = path.join(toolsDir, folder); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: name, main, description: '隔离日志验收，不含业务' }), 'utf8');
    fs.writeFileSync(path.join(directory, main), script, 'utf8'); return directory;
}
tool('same', sharedName, '<!doctype html><title>隔离工具日志</title><p>安全日志示例</p><script>console.log("工具首行中文🌟");console.error("工具错误日志");console.log("token=isolated-tool-secret");window.emitTestLog=text=>console.log(text);</script>');
tool('javascript', '隔离 JavaScript 日志', 'console.log("JS stdout中文🌟");console.error("JS stderr日志");if(process.send)process.send({type:"output",data:"JS IPC日志"});\n', 'main.js');
tool('retained', '保留历史日志工具', '<!doctype html><p>临时工具</p><script>console.log("已移除工具历史日志");</script>');
const pyFolder = path.join(pythonDir, 'python'); fs.mkdirSync(pyFolder);
fs.writeFileSync(path.join(pyFolder, 'settings.json'), JSON.stringify({ name: sharedName, main_file: 'run.py', config_file: 'config.json' }), 'utf8');
fs.writeFileSync(path.join(pyFolder, 'config.json'), '{}\n');
fs.writeFileSync(path.join(pyFolder, 'run.py'), `import pathlib,time\nprint("Python首行中文🌟",flush=True)\nfor _ in range(600):\n    if pathlib.Path(${JSON.stringify(signal)}).exists():\n        print("Python实时统一日志🌟",flush=True)\n        break\n    time.sleep(0.1)\n`);
const configPath = path.join(profile, 'python-plugin-configs', 'python', 'config.json'); fs.mkdirSync(path.dirname(configPath), { recursive: true });
const preservedConfig = '{"keep":"用户配置原字节"}\n'; fs.writeFileSync(configPath, preservedConfig, 'utf8');
const candidates = [process.env.SANRENJZ_ACCEPTANCE_PYTHON, 'python'].filter(Boolean);
let executable = '';
for (const candidate of candidates) {
    if (candidate !== 'python' && !fs.existsSync(candidate)) continue;
    const detected = spawnSync(candidate, ['-B', '-c', 'import sys; print(sys.executable if sys.version_info >= (3,9) else "")'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
    if (detected.status === 0 && detected.stdout.trim()) { executable = detected.stdout.trim(); break; }
}
let manager, python;
const environmentCalls = { inspect: 0, discover: 0, install: 0 };
class FixtureManager extends RealManager { constructor(win, options) { super(win, options); this.pluginDir = toolsDir; this.catalog = new PluginCatalog(toolsDir); manager = this; } }
class FixturePython extends pythonModule.PythonManager { constructor(options) { super({ ...options, pluginDir: pythonDir }); python = this; } }
class FixtureEnvironment extends environmentModule.PythonEnvironment {
    async inspect(...args) { environmentCalls.inspect++; return super.inspect(...args); }
    async discover() { environmentCalls.discover++; throw new Error('日志不得扫描解释器'); }
    async install() { environmentCalls.install++; throw new Error('日志不得安装解释器'); }
}
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
require.cache[require.resolve('../app/python-environment')].exports = { ...environmentModule, PythonEnvironment: FixtureEnvironment };
process.env.SANRENJZ_USER_DATA = profile; process.env.SANRENJZ_ACCEPTANCE = '1';
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.setLoginItemSettings = () => {};
const destinations = [];
dialog.showSaveDialog = async () => destinations.length ? { canceled: false, filePath: destinations.shift() } : { canceled: true };
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true })));
const report = { assertions: [], errors: [], viewports: [], hidden: true, isolatedProfile: true, realPythonRun: false, pythonExecutable: executable || null };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
process.on('unhandledRejection', error => report.errors.push(String(error)));
const ready = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => resolve(win))));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const expires = Date.now() + 15000; while (Date.now() < expires) { if (await fn()) return; await delay(30); } throw new Error(label); }
require('../main');
(async () => {
    const win = await ready; win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (_event, level, message) => { if (level>=3 && !/ERR_FILE_NOT_FOUND|ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|favicon/.test(message)) report.errors.push(`main-console: ${message}`); });
    const evaluate = script => win.webContents.executeJavaScript(script);
    const invoke = (channel, ...args) => evaluate(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)},...${JSON.stringify(args)})`);
    const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click();true;`);
    const choose = async (id, value) => { await evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change',{bubbles:true}));true;`); await delay(60); };
    const state = () => invoke('runtime:logs');
    const hasLog = async text => (await state()).records.some(record => record.message.includes(text));
    const screenshot = async name => {
        await evaluate("document.querySelectorAll('.notification').forEach(notification=>notification.remove());true;");
        await win.webContents.capturePage(); await delay(120);
        fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
    };
    try {
        await until(() => evaluate("typeof cachedPlugins!=='undefined' && cachedPlugins?.length===3 && typeof window.showPythonLogs==='function'"), '主页面未初始化');
        await evaluate("const style=document.createElement('style');style.textContent='*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}';document.head.appendChild(style);true;");
        const initialSettings = fs.readFileSync(settingsPath, 'utf8');
        check(await evaluate("!document.getElementById('python-quick-logs').hidden && document.getElementById('python-quick-settings').hidden"), '效率工具页面直接显示统一日志入口');
        await click('python-quick-logs');
        await until(() => evaluate("document.getElementById('python-logs-dialog').open && Boolean(document.getElementById('runtime-log-engine'))"), '统一日志弹窗未打开');
        check(await evaluate("document.getElementById('runtime-log-engine').value==='all' && document.getElementById('runtime-log-plugin').value==='' && document.getElementById('python-log-output').textContent.includes('暂无')"), '默认全部类型且无Python也能查看空日志');
        check(environmentCalls.inspect === 0 && environmentCalls.discover === 0 && environmentCalls.install === 0, '查看日志不检查或安装Python');
        check(fs.readFileSync(settingsPath, 'utf8') === initialSettings, '初次查看日志不更改现有设置');
        await evaluate("document.getElementById('python-logs-dialog').close();document.querySelector('[data-engine=python]').click();true;");
        check(await evaluate("!document.getElementById('python-quick-logs').hidden && !document.getElementById('python-quick-settings').hidden && document.getElementById('python-quick-logs').getBoundingClientRect().right<=document.getElementById('python-quick-settings').getBoundingClientRect().left+1"), 'py程序页面保留日志且位于环境入口左侧');

        check((await invoke('unified:run', toolId)).success, '安全HTML工具通过真实宿主管理器启动');
        await until(() => hasLog('工具首行中文🌟'), 'HTML console.log未进入统一日志');
        await until(() => hasLog('工具错误日志'), 'HTML console.error未进入统一日志');
        const htmlRecords = (await state()).records.filter(record => record.id === toolId);
        check(htmlRecords.some(record=>record.stream==='stdout') && htmlRecords.some(record=>record.stream==='stderr'), 'HTML正常和错误输出关联正确插件及通道');
        check(!htmlRecords.some(record=>record.message.includes('isolated-tool-secret')), '采集敏感键值在统一日志中脱敏');
        check((await invoke('unified:run', jsId)).success, '安全JS工具通过真实管理器启动');
        await until(() => hasLog('JS IPC日志'), 'JS IPC输出未进入统一日志');
        await until(() => hasLog('JS stdout中文🌟'), 'JS标准输出未进入统一日志');
        await until(() => hasLog('JS stderr日志'), 'JS错误输出未进入统一日志');
        check((await state()).records.some(record=>record.id===jsId && record.message.includes('JS stdout中文🌟')), 'JS进程输出关联独立稳定ID');

        if (executable) {
            const selected = await invoke('python:select-path', executable); check(selected.success !== false, '在隔离配置中选择已有Python');
            const launched = await invoke('unified:run', pyId); check(launched.success, '隐藏Python程序经真实统一IPC运行安全脚本');
            await until(() => hasLog('Python首行中文🌟'), '真实Python输出未进入统一日志'); report.realPythonRun = true;
        } else { python._log(pyId, 'stdout', 'Python首行中文🌟'); report.pythonRuntimeUnavailable = true; }
        const settingsAfterSelection = fs.readFileSync(settingsPath, 'utf8');
        await click('python-quick-logs');
        await until(() => evaluate("document.getElementById('python-log-output').textContent.includes('工具首行中文') && document.getElementById('python-log-output').textContent.includes('Python首行中文')"), '全部类型没有同时显示两类日志');
        check(await evaluate(`Array.from(document.getElementById('runtime-log-plugin').options).some(option=>option.value===${JSON.stringify(toolId)}) && Array.from(document.getElementById('runtime-log-plugin').options).some(option=>option.value===${JSON.stringify(pyId)})`), '同名工具和隐藏Python分别出现在稳定ID筛选项');
        await choose('runtime-log-engine', 'tools');
        check(await evaluate("document.getElementById('python-log-output').textContent.includes('工具首行中文') && !document.getElementById('python-log-output').textContent.includes('Python首行中文')"), '类型筛选只显示效率插件日志');
        await choose('runtime-log-plugin', toolId);
        check(await evaluate("document.getElementById('python-log-output').textContent.includes('工具首行中文') && !document.getElementById('python-log-output').textContent.includes('JS stdout')"), '插件筛选区分同类型不同插件');
        await choose('runtime-log-engine', 'python');
        check(await evaluate("document.getElementById('runtime-log-plugin').value==='' && document.getElementById('python-log-output').textContent.includes('Python首行中文') && !document.getElementById('python-log-output').textContent.includes('工具首行中文')"), '切换类型重置无效插件筛选且不串同名数据');
        await choose('runtime-log-plugin', pyId);
        await manager.pluginWindows.get(sharedName).webContents.executeJavaScript('window.emitTestLog("工具实时过滤不可见")');
        await until(() => hasLog('工具实时过滤不可见'), '工具实时事件未采集');
        if (executable) fs.writeFileSync(signal, 'continue'); else python._log(pyId, 'stdout', 'Python实时统一日志🌟');
        await until(() => evaluate("document.getElementById('python-log-output').textContent.includes('Python实时统一日志🌟')"), '当前筛选的实时日志没有更新');
        check(await evaluate("!document.getElementById('python-log-output').textContent.includes('工具实时过滤不可见')"), '实时追加继续遵守当前类型和插件筛选');
        if (executable) await until(() => !python.running.has(pyId), '真实Python脚本未正常退出清理');
        const exported = path.join(root, '筛选日志.txt'); destinations.push(exported); await click('python-export-logs');
        await until(() => fs.existsSync(exported), '筛选日志没有导出');
        const text = fs.readFileSync(exported, 'utf8');
        check(text.includes('Python首行中文🌟') && text.includes('Python实时统一日志🌟') && !text.includes('工具首行中文') && !text.includes('JS stdout'), '导出内容与当前类型及插件筛选一致');

        await evaluate("document.getElementById('python-logs-dialog').close();true;");
        check((await invoke('unified:run', removedId)).success, '历史保留工具可安全启动');
        await until(() => hasLog('已移除工具历史日志'), '历史保留工具没有输出');
        await invoke('unified:stop', removedId);
        check((await invoke('unified:remove', removedId)).success, '临时工具可移除');
        await click('python-quick-logs'); await click('runtime-log-refresh');
        await until(async () => (await state()).plugins.some(plugin=>plugin.id===removedId && plugin.installed===false), '已移除来源没有保留历史筛选项');
        await choose('runtime-log-engine', 'tools'); await choose('runtime-log-plugin', removedId);
        check(await evaluate("document.getElementById('python-log-output').textContent.includes('已移除工具历史日志')"), '移除插件后仍可筛选本次会话已记录日志');
        await choose('runtime-log-engine', 'all'); await choose('runtime-log-plugin', '');
        await click('runtime-log-refresh');
        await until(() => evaluate("document.getElementById('python-log-output').textContent.includes('工具实时过滤不可见')"), '刷新没有更新全部日志');
        check(await evaluate("Boolean(document.getElementById('runtime-log-status').textContent.trim())"), '筛选结果和记录范围有状态说明');
        check(fs.readFileSync(settingsPath, 'utf8') === settingsAfterSelection, '筛选刷新导出与历史查看不写入设置');
        check(fs.readFileSync(configPath, 'utf8') === preservedConfig, 'Python运行与统一日志保留原配置字节');
        check(environmentCalls.discover===0 && environmentCalls.install===0, '全流程没有扫描安装环境或依赖');
        await evaluate("window.showRuntimeLogs({engine:'tools',id:'tools:missing-filter-fixture'})");
        check(await evaluate("document.getElementById('runtime-log-plugin').value==='tools:missing-filter-fixture' && document.getElementById('python-log-output').textContent.includes('当前筛选暂无日志') && document.getElementById('python-export-logs').disabled && !document.getElementById('python-log-output').textContent.includes('工具首行中文')"), '指定插件暂无来源时保留筛选并禁用导出，不扩大到其他日志');
        await evaluate("window.showRuntimeLogs({engine:'all'})");
        check(!(await state()).records.some(record=>record.message.includes('Electron Security Warning')), '效率日志排除开发态框架安全提示，保留插件正常和错误输出');
        win.setSize(1180,760); await delay(80); await screenshot('unified-all-logs.png');
        await choose('runtime-log-engine', 'python'); await choose('runtime-log-plugin', pyId); await screenshot('unified-python-filter.png');
        await evaluate("document.getElementById('python-logs-dialog').close();true;");
        for (const [width,height] of [[900,650],[1000,680],[1180,760],[1500,900]]) {
            win.setSize(width,height); await delay(70);
            const layout = await evaluate("(()=>{const nav=document.querySelector('.engine-nav'),r=nav.getBoundingClientRect(),log=document.getElementById('python-quick-logs').getBoundingClientRect();return {navHeight:r.height,overflow:nav.scrollWidth-nav.clientWidth,left:log.left,right:log.right,viewportWidth:innerWidth};})()");
            report.viewports.push({windowWidth:width,windowHeight:height,...layout});
            check(layout.navHeight<=44 && layout.overflow<=1 && layout.left>=0 && layout.right<=layout.viewportWidth+1, `${width}x${height} 统一日志入口保持紧凑可达`);
        }
        check(report.errors.length===0, '统一日志采集和界面没有未处理异常');
        report.success = true;
    } catch (error) { report.success=false; report.errors.push(error.stack || String(error)); }
    finally {
        try { await python.shutdown(); } catch {}
        report.remainingPythonProcesses = python.running.size;
        fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
        app.isQuiting=true; app.quit();
    }
    setTimeout(()=>app.exit(report.success?0:1),700).unref();
})().catch(error=>{console.error(error);app.exit(1);});
setTimeout(async ()=>{console.error('统一日志验收超时');try{await python?.shutdown();manager?.stopAllPlugins();}finally{app.exit(2);}},90000).unref();
app.once('quit',()=>{try{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:80});}catch{}});
