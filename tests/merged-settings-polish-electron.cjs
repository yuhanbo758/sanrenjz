const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { app, dialog, session, shell } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');
const environmentModule = require('../app/python-environment');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-设置优化 空格-'));
process.env.APPDATA = path.join(root, 'isolated-legacy-profiles');
require('../app/migration-manager').MigrationManager.prototype.detectInstallations = () => [];
const profile = path.join(root, 'profile');
const toolsDir = path.join(root, '效率插件');
const pythonDir = path.join(root, 'Python 插件');
const externalConfig = path.join(root, '自定义 配置');
for (const directory of [profile, toolsDir, pythonDir, externalConfig]) fs.mkdirSync(directory);
const output = path.resolve(__dirname, '../dist/merged-settings-polish-validation');
fs.mkdirSync(output, { recursive: true });
const report = { assertions: [], errors: [], viewports: [], hidden: true, isolatedProfile: true, realPythonRun: false };
const check = (condition, label) => { assert(condition, label); report.assertions.push(label); };
const settingsPath = path.join(profile, 'settings.json');
fs.writeFileSync(settingsPath, JSON.stringify({
    pythonMode: 'none', enableRightClickPanel: false, autoStart: false, migrationPrompted: true,
    globalHotkey: 'Alt+Space', pinHotkey: 'Ctrl+D', superPanelHotkey: ''
}), 'utf8');
const toolFolder = path.join(toolsDir, 'fixture'); fs.mkdirSync(toolFolder);
fs.writeFileSync(path.join(toolFolder, 'plugin.json'), JSON.stringify({ pluginName: '隔离工具', main: 'index.html', description: '设置优化验收' }));
fs.writeFileSync(path.join(toolFolder, 'index.html'), '<!doctype html><p>隔离工具</p>');
const pythonFolder = path.join(pythonDir, 'fixture'); fs.mkdirSync(pythonFolder);
fs.writeFileSync(path.join(pythonFolder, 'settings.json'), JSON.stringify({ name: '隔离 Python', main_file: 'run.py', config_file: 'config.json' }));
fs.writeFileSync(path.join(pythonFolder, 'run.py'), 'raise RuntimeError("禁止执行真实业务")\n');
fs.writeFileSync(path.join(pythonFolder, 'config.json'), '{}\n');
const executable1 = path.join(root, 'Python 当前 环境', 'python.exe');
const executable2 = path.join(root, 'Python 备用 环境', 'python.exe');
for (const file of [executable1, executable2]) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'isolated fixture, never executable'); }
const candidates = [
    { executable: executable1, prefix: path.dirname(executable1), version: '3.12.9', architecture: 'AMD64', bitness: 64, pip: true, tk: true, major: 3 },
    { executable: executable2, prefix: path.dirname(executable2), version: '3.11.9', architecture: 'AMD64', bitness: 64, pip: false, tk: false, major: 3 }
];
let environment, python;
const counts = { inspections: 0, discoveries: 0, installs: 0, cancels: 0, launches: 0 };
let discoverMode = 'success', discoverResolve, failInspection = false;
let installReject;
class FixtureManager extends RealManager {
    constructor(win, options) { super(win, options); this.pluginDir = toolsDir; this.catalog = new PluginCatalog(toolsDir); }
}
class FixturePython extends pythonModule.PythonManager {
    constructor(options) { super({ ...options, pluginDir: pythonDir }); python = this; }
    async run() { counts.launches++; throw new Error('设置验收禁止运行业务'); }
}
class FixtureEnvironment extends environmentModule.PythonEnvironment {
    constructor(options) { super(options); environment = this; }
    async inspect(executable) {
        counts.inspections++;
        if (failInspection) throw Object.assign(new Error('隔离测试：解释器暂时不可用'), { code: 'PYTHON_INVALID' });
        const runtime = candidates.find(candidate => candidate.executable === executable);
        if (!runtime) throw Object.assign(new Error('隔离测试：解释器失效'), { code: 'PYTHON_INVALID' });
        return { ...runtime };
    }
    async discover() {
        counts.discoveries++;
        if (discoverMode === 'failure') throw new Error('隔离测试：无法读取环境，请重试');
        if (discoverMode === 'empty') return [];
        if (discoverMode === 'pending') await new Promise(resolve => { discoverResolve = resolve; });
        return candidates.map(candidate => ({ ...candidate }));
    }
    async install() {
        counts.installs++;
        this._installPromise = new Promise((_resolve, reject) => { installReject = reject; });
        this._emit('downloading', '隔离安装进度', { percent: 25 });
        try { return await this._installPromise; }
        finally { this._installPromise = null; installReject = undefined; }
    }
    cancel() {
        counts.cancels++;
        if (installReject) {
            this._emit('cancelled', '已取消 Python 环境安装');
            installReject(Object.assign(new Error('已取消 Python 环境安装'), { code: 'PYTHON_INSTALL_CANCELLED' }));
        }
        return { cancelled: true };
    }
}
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
require.cache[require.resolve('../app/python-environment')].exports = { ...environmentModule, PythonEnvironment: FixtureEnvironment };
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_ACCEPTANCE = '1';
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
const selectedPaths = [], openedPaths = [];
dialog.showOpenDialog = async () => ({ canceled: !selectedPaths.length, filePaths: selectedPaths.shift() || [] });
dialog.showMessageBox = async () => ({ response: 0 });
shell.openPath = async directory => { openedPaths.push(directory); return ''; };
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ['https://gdsx.sanrenjz.com/*'] }, (_details, callback) => callback({ cancel: true })));
process.on('unhandledRejection', error => report.errors.push(String(error)));
const ready = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => resolve(win))));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(checker, message) {
    const expires = Date.now() + 12000;
    while (Date.now() < expires) { if (await checker()) return; await delay(25); }
    throw new Error(message);
}
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
require('../main');
(async () => {
    const win = await ready;
    win.webContents.setBackgroundThrottling(false);
    const evaluate = script => win.webContents.executeJavaScript(script);
    const click = async id => {
        await until(() => evaluate(`Boolean(document.getElementById(${JSON.stringify(id)}) && !document.getElementById(${JSON.stringify(id)}).disabled)`), `操作未恢复可用：${id}`);
        return evaluate(`document.getElementById(${JSON.stringify(id)}).click(); true;`);
    };
    const screenshot = async name => {
        await evaluate("document.querySelectorAll('.notification').forEach(notification=>notification.remove()); true;");
        await delay(120);
        await win.webContents.capturePage();
        await delay(120);
        fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
    };
    try {
        await until(() => evaluate("typeof cachedPlugins!=='undefined' && cachedPlugins?.length===2"), '主页面未初始化');
        await evaluate("window.testAlerts=[]; window.alert=message=>window.testAlerts.push(message); window.testConfirmAnswers=[]; window.confirm=()=>window.testConfirmAnswers.shift()??true; const style=document.createElement('style'); style.textContent='*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important}'; document.head.appendChild(style); true;");
        check(counts.inspections === 0 && counts.discoveries === 0 && counts.installs === 0, '主页面启动不检查或安装 Python');
        await click('python-quick-settings');
        await until(() => evaluate("document.getElementById('merge-python').classList.contains('active') && document.getElementById('python-environment-status').textContent.includes('未配置')"), 'Python 直接入口未显示未配置状态');
        check(await evaluate("document.getElementById('merge-python').querySelectorAll('.settings-card').length>=3"), 'Python 环境按当前选择、环境获取与维护分区');
        check(await evaluate("document.getElementById('python-diagnose').disabled && document.getElementById('python-clear').disabled"), '未配置时禁用无效诊断与清除操作');
        check(counts.inspections === 0 && counts.discoveries === 0, '浏览 Python 设置不隐式检测环境');
        check(await evaluate("document.getElementById('save-settings-btn').textContent.trim()==='完成'"), '立即保存的环境页使用完成按钮');
        const navigation = await evaluate("(() => {const states=[]; for(const [target,key] of [['merge-python','ArrowUp'],['plugins','Home'],['general','ArrowDown'],['shortcuts','End'],['merge-migration','ArrowUp']]){const tab=document.querySelector(`.sidebar-item[data-target=\"${target}\"]`);tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));states.push(document.querySelector('.settings-tab-content.active').id);}return states;})()");
        check(navigation.join(',') === 'plugins,general,shortcuts,merge-migration,merge-python', '设置侧边栏方向键与 Home/End 包含新增数据导入页');

        discoverMode = 'pending';
        await click('python-discover');
        await until(() => Boolean(discoverResolve), '检查环境请求没有发出');
        check(await evaluate("document.getElementById('python-discover').disabled && /正在|检查中/.test(document.getElementById('merge-python').textContent)"), '检测中状态明确且阻止重复检测');
        discoverResolve(); discoverResolve = undefined;
        await until(() => evaluate("document.querySelectorAll('#python-candidates button').length===2 && !document.getElementById('python-discover').disabled"), '候选结果没有渲染');
        check(await evaluate("document.getElementById('python-candidates').textContent.includes('3.12.9') && document.getElementById('python-candidates').textContent.includes('pip') && document.getElementById('python-candidates').textContent.includes('Tk')"), '环境候选显示版本、架构与依赖能力');
        check(await evaluate("document.getElementById('python-candidates').textContent.includes('缺少')"), '候选缺少 pip 或 Tk 时明确显示能力缺口');
        await evaluate("document.querySelector('#python-candidates button').click(); true;");
        await until(() => readSettings().customPythonPath === executable1, '候选环境选择未保存');
        await until(() => evaluate("[...document.querySelectorAll('#python-candidates button')].some(button=>button.disabled && /当前|使用中/.test(button.textContent))"), '当前候选没有禁用并标记');
        check(await evaluate(`document.getElementById('python-environment-status').textContent.includes(${JSON.stringify(executable1)})`), '当前解释器卡片同步显示真实保存路径');
        const inspectedBefore = counts.inspections;
        await evaluate("[...document.querySelectorAll('#python-candidates button')].find(button=>button.disabled).click(); true;");
        check(counts.inspections === inspectedBefore, '点击当前已选解释器不会重复选择验证');

        discoverMode = 'failure';
        await click('python-discover');
        await until(() => evaluate("!document.getElementById('python-discover').disabled && document.getElementById('merge-python').textContent.includes('无法读取环境')"), '检测失败没有在页面提供可重试反馈');
        check(await evaluate("document.querySelectorAll('#python-candidates button:not(:disabled)').length===0"), '检测失败不保留可误选的旧候选');
        discoverMode = 'empty'; await click('python-discover');
        await until(() => evaluate("!document.getElementById('python-discover').disabled && /未找到|未发现/.test(document.getElementById('python-discovery-status').textContent)"), '空结果没有显示引导');
        check(await evaluate("document.querySelectorAll('#python-candidates button').length===0"), '未找到环境时提供空状态而非旧候选');
        discoverMode = 'success'; await click('python-discover');
        await until(() => evaluate("document.querySelectorAll('#python-candidates button').length===2 && !document.getElementById('python-discover').disabled"), '检测失败后重试未恢复候选');
        check(true, '检测失败后可以重试恢复');

        await click('python-install');
        await until(() => Boolean(installReject), '隔离安装请求未开始');
        check(await evaluate("['python-select','python-discover','python-clear','python-install'].every(id=>document.getElementById(id).disabled) && [...document.querySelectorAll('#python-candidates button')].every(button=>button.disabled)"), '安装中禁止切换、清除、重复安装及候选选择');
        check(await evaluate("!document.getElementById('python-cancel').hidden && document.getElementById('python-progress').textContent.includes('25')"), '安装显示真实进度与取消入口');
        await click('python-cancel');
        await until(() => !environment.status().installing && !installReject, '取消安装后未恢复空闲状态');
        await until(() => evaluate("!document.getElementById('python-discover').disabled"), '取消后环境操作未恢复');
        check(readSettings().customPythonPath === executable1 && counts.cancels >= 1, '取消安装保留原解释器选择');
        check(await evaluate("getComputedStyle(document.getElementById('python-install-progress')).display==='none'"), '取消安装后停止并隐藏进度条');
        await click('python-diagnose');
        await until(() => evaluate("!document.getElementById('python-diagnostic').hidden && document.getElementById('python-diagnostic').textContent.includes('3.12.9')"), '环境诊断未展示结果');
        check(true, '主动诊断显示所选环境的结果');
        failInspection = true; await click('python-diagnose');
        await until(() => evaluate("!document.getElementById('python-diagnose').disabled && document.getElementById('python-diagnostic').textContent.includes('暂时不可用')"), '诊断失败没有在输出中说明');
        check(readSettings().customPythonPath === executable1, '诊断失败保留原解释器，不静默切换');
        failInspection = false; await click('python-diagnose');
        await until(() => evaluate("document.getElementById('python-diagnostic').textContent.includes('3.12.9') && !document.getElementById('python-diagnose').disabled"), '诊断失败后不能重试');

        for (const [width, height] of [[800,600],[1000,680],[1280,800]]) {
            win.setSize(width, height); await delay(80);
            const layout = await evaluate("(() => {const viewport={width:innerWidth,height:innerHeight}; const modal=document.querySelector('#settings-modal .settings-modal-content').getBoundingClientRect(); const main=document.querySelector('#settings-modal .settings-main'); const footer=document.querySelector('#settings-modal .settings-footer').getBoundingClientRect(); const button=document.getElementById('save-settings-btn').getBoundingClientRect(); return {viewport,modal:{left:modal.left,right:modal.right,top:modal.top,bottom:modal.bottom}, mainOverflow:main.scrollWidth-main.clientWidth,footer:{top:footer.top,bottom:footer.bottom},button:{left:button.left,right:button.right,top:button.top,bottom:button.bottom}}})()");
            report.viewports.push({ width, height, ...layout });
            check(layout.mainOverflow <= 1 && layout.modal.left >= -1 && layout.modal.right <= layout.viewport.width+1, `${width}x${height} 设置内容无横向溢出`);
            check(layout.button.bottom <= layout.viewport.height+1 && layout.button.top >= 0 && layout.footer.bottom <= layout.viewport.height+1, `${width}x${height} 页脚按钮始终可达`);
            await evaluate("(() => {const main=document.querySelector('#settings-modal .settings-main'); main.scrollTop=main.scrollHeight; return true;})()");
            check(await evaluate("(() => {const main=document.querySelector('#settings-modal .settings-main'); return main.scrollHeight<=main.clientHeight || main.scrollTop>0;})()"), `${width}x${height} 内容区可以独立滚动到底部`);
            await evaluate("document.querySelector('#settings-modal .settings-main').scrollTop=0; true;");
            await screenshot(`python-${width}x${height}.png`);
        }
        await evaluate("document.getElementById('python-candidates-heading').scrollIntoView({block:'start'}); true;");
        await screenshot('python-candidates-1280x800.png');

        for (let index = 0; index < 180; index++) python._log('python:fixture/run.py', 'stdout', `隔离测试日志 ${index+1}`);
        await click('python-all-logs');
        await until(() => evaluate("document.getElementById('python-logs-dialog').open && document.getElementById('python-log-output').textContent.includes('隔离测试日志 180')"), '运行日志没有完整呈现');
        check(await evaluate("(() => {const output=document.getElementById('python-log-output'); return output.scrollHeight>output.clientHeight && getComputedStyle(output).overflowY==='auto';})()"), '长日志使用独立滚动区域');
        await evaluate("document.getElementById('python-logs-dialog').close(); true;");

        await evaluate("document.querySelector('[data-target=general]').click(); true;");
        await until(() => evaluate("Boolean(document.getElementById('python-config-path')?.value)"), '常规设置未显示配置目录');
        check(await evaluate("document.getElementById('save-settings-btn').textContent.includes('保存')"), '常规设置仍明确要求保存');
        const operationsBeforeConfig = { ...counts };
        selectedPaths.push([externalConfig]); await click('python-config-choose');
        await until(() => evaluate(`document.getElementById('python-config-path').value===${JSON.stringify(externalConfig)}`), '选择的配置目录未在卡片中显示');
        check(readSettings().customPluginConfigDir === externalConfig || readSettings().pythonPluginConfigDir === externalConfig, '配置目录单独立即落盘');
        await click('python-config-open'); await until(() => openedPaths.includes(externalConfig), '打开配置目录没有调用当前有效路径');
        check(true, '打开目录操作使用已保存的有效配置目录');
        await click('python-config-reset');
        await until(() => evaluate(`document.getElementById('python-config-path').value!==${JSON.stringify(externalConfig)}`), '恢复默认目录没有刷新卡片');
        check(counts.inspections === operationsBeforeConfig.inspections && counts.discoveries === operationsBeforeConfig.discoveries && counts.installs === operationsBeforeConfig.installs, '配置目录操作不检查安装或切换解释器');
        await until(() => evaluate("!document.getElementById('python-config-reset').disabled"), '恢复目录操作未结束');
        await evaluate("(() => {const main=document.querySelector('#settings-modal .settings-main'); main.scrollTop=main.scrollHeight; return true;})()");
        await delay(350);
        report.generalLayout = await evaluate("(() => {const main=document.querySelector('#settings-modal .settings-main');const m=main.getBoundingClientRect();const b=document.getElementById('python-config-reset').getBoundingClientRect();return {scrollTop:main.scrollTop,scrollHeight:main.scrollHeight,clientHeight:main.clientHeight,mainBottom:m.bottom,buttonTop:b.top,buttonBottom:b.bottom};})()");
        check(report.generalLayout.buttonBottom <= report.generalLayout.mainBottom+1 && report.generalLayout.buttonTop>=0, '常规设置滚动后配置目录操作按钮可达');
        await screenshot('general-config-1280x800.png');

        await evaluate("document.getElementById('global-hotkey-input').value='Ctrl+Alt+F12'; document.getElementById('global-hotkey-input').dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('[data-target=merge-python]').click(); true;");
        await until(() => evaluate("document.getElementById('merge-python').classList.contains('active')"), '环境页内部切换失败');
        check(await evaluate("document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F12'"), '设置页内部切换保留未保存输入');
        check(await evaluate("document.getElementById('save-settings-btn').textContent.includes('保存') && /未保存/.test(document.getElementById('settings-save-hint').textContent)"), '其他页面有未保存修改时环境页仍提供保存入口');
        await click('save-settings-btn');
        await until(() => evaluate("!document.getElementById('settings-modal').classList.contains('show')"), '保存按钮未完成保存关闭设置');
        check(readSettings().globalHotkey === 'Ctrl+Alt+F12', '环境页能够明确保存其他页面的未提交输入');
        await click('python-quick-settings');
        await until(() => evaluate("document.getElementById('save-settings-btn').textContent.trim()==='完成'"), '没有未保存修改时没有恢复完成语义');
        await click('save-settings-btn');
        await until(() => evaluate("!document.getElementById('settings-modal').classList.contains('show')"), '完成按钮未关闭设置');
        check(readSettings().globalHotkey === 'Ctrl+Alt+F12', '未修改的立即保存页面完成后不改写通用设置');
        await click('settings-btn');
        await until(() => evaluate("document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F12'"), '关闭后重新打开未读取已保存值');
        await evaluate("document.getElementById('global-hotkey-input').value='Ctrl+Alt+F11'; document.getElementById('global-hotkey-input').dispatchEvent(new Event('input',{bubbles:true})); window.testConfirmAnswers.push(false); true;");
        await click('settings-close-btn');
        check(await evaluate("document.getElementById('settings-modal').classList.contains('show') && document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F11'"), '取消放弃修改后设置与未保存输入继续保留');
        await evaluate("window.testConfirmAnswers.push(true); true;"); await click('settings-close-btn');
        await until(() => evaluate("!document.getElementById('settings-modal').classList.contains('show')"), '确认放弃修改没有关闭设置');
        check(readSettings().globalHotkey === 'Ctrl+Alt+F12', '确认放弃修改不改写磁盘设置');
        check(counts.launches === 0, '完整设置流程没有启动 Python 业务');
        check(report.errors.length === 0, '设置交互没有未处理异常');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        report.environmentOperations = counts;
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
        console.log(JSON.stringify(report));
        app.isQuiting = true; app.exit(report.success ? 0 : 1);
    }
})().catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('设置体验验收超时'); app.exit(2); }, 80000).unref();
app.once('quit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
