const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, globalShortcut, session } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');

const root = process.env.SANRENJZ_MIGRATION_SETTINGS_ROOT;
if (!root || path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('sanrenjz-migration-settings-') || fs.lstatSync(root).isSymbolicLink()) throw new Error('需要父进程分配的隔离测试根目录');
const profile = path.join(root, 'profile'), tools = path.join(root, 'tools'), python = path.join(root, 'python');
for (const directory of [profile, tools, python, path.join(root, 'isolated-appdata')]) fs.mkdirSync(directory, { recursive: true });
process.env.APPDATA = path.join(root, 'isolated-appdata');
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_ACCEPTANCE = '1';
const initialSettings = JSON.stringify({ autoStart: false, globalHotkey: 'Ctrl+Alt+F11', pinHotkey: 'Ctrl+Alt+F10', superPanelHotkey: '', pythonMode: 'none', migrationPrompted: true, enableRightClickPanel: false, unrelatedPreference: '旧配置保持原字节' });
const settingsFile = path.join(profile, 'settings.json'); fs.writeFileSync(settingsFile, initialSettings);
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.setLoginItemSettings = () => {};
globalShortcut.register = () => true; globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {}; globalShortcut.isRegistered = () => false;
class FixtureManager extends RealManager { constructor(window, options) { super(window, options); this.pluginDir = tools; this.catalog = new PluginCatalog(tools); } }
class FixturePython extends pythonModule.PythonManager { constructor(options) { super({ ...options, pluginDir: python }); } async run() { throw new Error('隔离验收禁止运行业务'); } }
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
const report = { isolatedProfile: true, mockedMigration: true, assertions: [], errors: [], electronVersion: process.versions.electron };
const check = (condition, label) => { assert(condition, label); report.assertions.push(label); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, label) { for (let i = 0; i < 300; i++) { if (await callback()) return; await delay(20); } throw new Error(label || '数据导入界面等待超时'); }
const output = path.resolve(__dirname, '../dist/migration-settings-validation');
app.whenReady().then(() => {
    for (const target of [session.defaultSession, session.fromPartition('persist:sanrenjz-shop')]) target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
});
process.on('unhandledRejection', error => report.errors.push(String(error)));
const ready = new Promise(resolve => app.once('browser-window-created', (_event, window) => window.webContents.once('did-finish-load', () => resolve(window))));
require('../main');

(async () => {
    try {
        const window = await ready; window.webContents.setBackgroundThrottling(false);
        const evaluate = source => window.webContents.executeJavaScript(source);
        const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click();true;`);
        await until(() => evaluate("Boolean(document.getElementById('migration-settings-tab') && window.activateSettingsTab)"));
        const fixtures = [
            { id: 'tools-source', product: 'tools', label: '原效率工具', root: 'D:\\隔离旧安装\\效率 工具', profileRoot: 'D:\\隔离旧用户\\sanrenjz-tools', toolsCount: 3, pythonCount: 0, hasConfigs: true, hasInterpreter: false, importable: { toolsPlugins: 3, pythonPlugins: 0, configs: true, preferences: true, interpreter: false }, origin: 'installation', configLocations: [{ kind: 'tools-data', path: 'D:\\隔离自定义\\效率 数据', custom: true }], descriptions: ['保留插件目录名和存储命名空间。'] },
            { id: 'python-source', product: 'python', label: '原 Python 程序管理', root: 'D:\\隔离旧安装\\Python 管理', profileRoot: 'D:\\隔离旧用户\\yuhanbopy-app', toolsCount: 0, pythonCount: 2, hasConfigs: true, hasInterpreter: true, importable: { toolsPlugins: 0, pythonPlugins: 2, configs: true, preferences: true, interpreter: true }, origin: 'installation', configLocations: [{ kind: 'python-configs', path: 'D:\\隔离自定义\\Python 配置', custom: true }] }
        ];
        await evaluate(`window.__migrationFixtures=${JSON.stringify(fixtures)};window.__migrationCalls=[];window.__migrationInspectMode='sources';window.__migrationChooseCanceled=false;window.__migrationRunFailure=false;window.__migrationHoldRun=false;window.__migrationReleaseRun=null;window.__realInvoke=require('electron').ipcRenderer.invoke.bind(require('electron').ipcRenderer);require('electron').ipcRenderer.invoke=async(channel,...args)=>{window.__migrationCalls.push({channel,args});if(channel==='migration:inspect'){if(window.__migrationInspectMode==='error')throw new Error('隔离检测失败，请手动选择目录');return {sources:window.__migrationInspectMode==='empty'?[]:window.__migrationFixtures,errors:[]};}if(channel==='migration:choose'){if(window.__migrationChooseCanceled)return {canceled:true};return {sources:[{...window.__migrationFixtures[1],id:'manual-python',root:'E:/隔离手选/便携 Python',origin:'selection'}],errors:[]};}if(channel==='migration:run'){if(window.__migrationHoldRun)await new Promise(resolve=>window.__migrationReleaseRun=resolve);return {success:!window.__migrationRunFailure,copied:2,skipped:1,preferenceFields:3,backupPath:'D:/隔离新配置/migration-backups/fixture-backup',conflicts:[{type:'config',id:'fixture-config.json',source:'D:/隔离旧配置/fixture-config.json',target:'D:/隔离新配置/fixture-config.json',reason:'目标已有配置，保留当前文件'}],errors:window.__migrationRunFailure?[{id:'fixture-plugin',error:'隔离复制失败，原数据保留'}]:[],error:window.__migrationRunFailure?'隔离导入未完成':'',restartRequired:true};}return window.__realInvoke(channel,...args);};true;`);
        await click('settings-btn');
        await until(() => evaluate('settingsReady && !settingsLoading'));
        check(await evaluate("!window.__migrationCalls.some(item=>item.channel.startsWith('migration:'))"), '打开设置不会自动检查或执行迁移');
        await evaluate("document.getElementById('global-hotkey-input').value='Ctrl+Alt+F12';document.getElementById('global-hotkey-input').dispatchEvent(new Event('input',{bubbles:true}));true;");
        const loadCalls = await evaluate("window.__migrationCalls.filter(item=>item.channel==='get-settings').length");
        await click('migration-settings-tab');
        await until(() => evaluate("document.querySelectorAll('#migration-settings-sources .migration-source-card').length===2"));
        check(await evaluate("document.getElementById('merge-migration').classList.contains('active') && document.querySelector('#migration-settings-tab').getAttribute('aria-selected')==='true'"), '设置侧栏提供独立数据导入页面');
        check(await evaluate("document.querySelectorAll('#migration-settings-sources [data-product]').length===2 && document.getElementById('migration-settings-sources').textContent.includes('原效率工具') && document.getElementById('migration-settings-sources').textContent.includes('原 Python 程序管理')"), '两个旧产品分别展示说明和来源');
        check(await evaluate("window.__migrationCalls.filter(item=>item.channel==='migration:inspect').length===1 && !window.__migrationCalls.some(item=>item.channel==='migration:run')"), '首次进入数据页仅检查来源，需手动确认才导入');
        check(await evaluate(`window.__migrationCalls.filter(item=>item.channel==='get-settings').length===${loadCalls} && document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F12' && hasUnsavedSettings()`), '切换数据导入页保留其它页未保存输入且不重读设置');
        check(await evaluate("document.getElementById('settings-save-hint').textContent.includes('尚未保存')"), '数据页不会把已有待保存偏好误标为即时保存');

        await evaluate("document.querySelector('[data-migration-preview=tools-source]').click();true;");
        await until(() => evaluate("document.getElementById('migration-dialog').open && Boolean(document.getElementById('migration-run'))"));
        check(await evaluate("document.getElementById('migration-sources').textContent.includes('自定义') && document.getElementById('migration-sources').textContent.includes('效率 数据')"), '预览展示实际来源和自定义配置位置');
        check(await evaluate("document.querySelector('#migration-sources [data-option=toolsPlugins]').checked && document.querySelector('#migration-sources [data-option=configs]').checked && document.querySelector('#migration-sources [data-option=preferences]').checked && !document.querySelector('#migration-sources [data-option=interpreter]').checked"), '按检测结果选择插件配置偏好，解释器默认不选');
        check(await evaluate("document.querySelector('#migration-sources [data-option=pythonPlugins]').disabled && document.querySelector('#migration-sources [data-option=interpreter]').disabled"), '当前来源没有的类型不能选择');
        await evaluate("document.querySelectorAll('#migration-sources [data-option]').forEach(input=>{input.checked=false;input.dispatchEvent(new Event('change'));});true;");
        check(await evaluate("document.getElementById('migration-run').disabled"), '未选内容时不能执行空迁移');
        await evaluate("const configOption=document.querySelector('#migration-sources [data-option=configs]');configOption.checked=true;configOption.dispatchEvent(new Event('change'));window.__migrationHoldRun=true;true;");
        await click('migration-run');
        await until(() => evaluate("typeof window.__migrationReleaseRun==='function'"));
        check(await evaluate("document.getElementById('migration-run').disabled && document.getElementById('migration-source-picker').disabled && document.getElementById('migration-choose').disabled && document.getElementById('migration-skip').disabled"), '导入中锁定来源和操作，防止重复迁移');
        await click('migration-run');
        check(await evaluate("window.__migrationCalls.filter(item=>item.channel==='migration:run').length===1"), '重复点击不会并发执行迁移');
        await evaluate("window.__migrationHoldRun=false;window.__migrationReleaseRun();true;");
        await until(() => evaluate("!document.getElementById('migration-run').disabled && !document.getElementById('migration-result').hidden"));
        const options = await evaluate("window.__migrationCalls.find(item=>item.channel==='migration:run').args[0]");
        check(options.sourceId === 'tools-source' && options.configs && !options.toolsPlugins && !options.pythonPlugins && !options.preferences && !options.interpreter, '只提交用户本次明确选择的内容');
        check(await evaluate("document.getElementById('migration-result').textContent.includes('新增 2 项') && document.getElementById('migration-result').textContent.includes('同名冲突 1 项') && document.getElementById('migration-result').textContent.includes('fixture-backup') && !document.getElementById('migration-result').textContent.includes('sourceId')"), '结果展示新增保留项、冲突及备份路径，不输出原始JSON');
        check(await evaluate("document.getElementById('migration-settings-result').textContent.includes('fixture-backup')"), '导入结果同步保留在设置页，便于关闭弹窗后查看');
        await click('migration-skip');
        await evaluate("window.activateSettingsTab('shortcuts');true;");
        check(await evaluate("document.getElementById('global-hotkey-input').value==='Ctrl+Alt+F12' && hasUnsavedSettings()"), '迁移及目录刷新不丢失未保存设置');

        await click('migration-settings-tab');
        await evaluate("window.__migrationChooseCanceled=true;true;");
        await click('migration-settings-choose');
        await until(() => evaluate("!document.getElementById('migration-settings-choose').disabled"));
        check(await evaluate("document.querySelectorAll('#migration-settings-sources .migration-source-card').length===2 && document.getElementById('migration-settings-status').textContent.includes('已取消')"), '取消手动选择保留已发现来源');
        await evaluate("window.__migrationChooseCanceled=false;true;");
        await click('migration-settings-choose');
        await until(() => evaluate("document.querySelectorAll('#migration-settings-sources .migration-source-card').length===3"));
        check(await evaluate("document.getElementById('migration-settings-sources').textContent.includes('便携 Python')"), '手动选择便携目录可补充来源，不丢另一旧应用');
        await evaluate("document.querySelector('[data-migration-preview=manual-python]').click();true;");
        check(await evaluate("document.getElementById('migration-source-picker').value==='manual-python' && document.querySelector('#migration-sources [data-option=pythonPlugins]').checked && !document.querySelector('#migration-sources [data-option=interpreter]').checked && !document.querySelector('#migration-sources [data-option=interpreter]').disabled"), '可以预览手选Python来源并独立决定是否复用解释器');
        check(await evaluate("document.getElementById('migration-result').hidden"), '切换来源不会把上一来源的导入结果误显示为本次结果');
        await evaluate("window.__migrationRunFailure=true;true;");
        await click('migration-run');
        await until(() => evaluate("!document.getElementById('migration-run').disabled && document.getElementById('migration-result').textContent.includes('导入未完成')"));
        check(await evaluate("document.getElementById('migration-result').textContent.includes('隔离复制失败') && document.getElementById('migration-result').textContent.includes('fixture-backup')"), '失败结果保留原因及备份位置并允许重试');
        await click('migration-skip');
        await click('python-settings-tab');
        await click('migration-open');
        await until(() => evaluate("document.getElementById('merge-migration').classList.contains('active')"));
        check(await evaluate("document.querySelectorAll('#migration-dialog').length===1 && document.querySelectorAll('#merge-migration').length===1"), 'Python维护入口跳转统一数据页且无重复弹窗或ID');

        await evaluate("window.__migrationInspectMode='empty';true;");
        await click('migration-detect');
        await until(() => evaluate("!document.getElementById('migration-detect').disabled && document.querySelectorAll('#migration-settings-sources .migration-source-card').length===0"));
        check(await evaluate("document.querySelectorAll('#migration-settings-sources [data-migration-select]').length===2 && document.getElementById('migration-settings-status').textContent.includes('手动选择')"), '未检测来源时两个产品均保留明确手动入口');
        await evaluate("window.__migrationInspectMode='error';true;");
        await click('migration-detect');
        await until(() => evaluate("!document.getElementById('migration-detect').disabled"));
        check(await evaluate("document.getElementById('migration-settings-status').textContent.includes('隔离检测失败') && !document.getElementById('migration-settings-choose').disabled"), '检测失败说明原因并保留手动选择及重试');

        await evaluate("window.__migrationInspectMode='sources';true;");
        await click('migration-detect');
        await until(() => evaluate("document.querySelectorAll('#migration-settings-sources .migration-source-card').length===2"));
        check(fs.readFileSync(settingsFile, 'utf8') === initialSettings, '整个界面验收保留现有配置原字节');
        check(await evaluate("!window.__migrationCalls.some(item=>item.channel==='save-settings')"), '预览、切页及模拟导入不会代替用户保存待保存偏好');
        for (const [width, height] of [[1000, 680], [760, 650]]) {
            window.setSize(width, height); await delay(100);
            const fits = await evaluate("(()=>{const pane=document.getElementById('merge-migration'),main=document.querySelector('.settings-main');return pane.scrollWidth<=main.clientWidth+1 && [...pane.querySelectorAll('button')].every(button=>button.getBoundingClientRect().width>0);})()");
            check(fits, `${width}×${height} 数据页按钮可达且无横向溢出`);
        }
        const profileOnly = { id: 'profile-only', product: 'tools', label: '原效率工具用户数据', root: '', profileRoot: 'D:/隔离旧用户/sanrenjz-tools', origin: 'profile', toolsCount: 0, pythonCount: 0, hasConfigs: true, importable: { toolsPlugins: 0, pythonPlugins: 0, configs: true, preferences: false, interpreter: false }, configLocations: [{ kind: 'tools-data', path: 'D:/隔离旧用户/sanrenjz-tools/plugin-data', custom: false }], pluginLocations: [], plugins: [] };
        const privatePrograms = { id: 'private-programs', product: 'tools', label: '手动选择的插件程序', root: 'E:/隔离自行安装插件', profileRoot: '', origin: 'selection', toolsCount: 1, pythonCount: 0, hasConfigs: false, importable: { toolsPlugins: 1, pythonPlugins: 0, configs: false, preferences: false, interpreter: false }, pluginLocations: [{ engine: 'tools', path: 'E:/隔离自行安装插件/个人工具', count: 1 }], plugins: [{ engine: 'tools', id: 'self-installed-private', name: '个人工具 <测试>' }], configLocations: [] };
        await evaluate(`window.__migrationOriginalFixtures=window.__migrationFixtures;window.__migrationFixtures=[${JSON.stringify(profileOnly)},${JSON.stringify(privatePrograms)}];window.__migrationChosenPrograms=${JSON.stringify(privatePrograms)};window.__migrationPreviousInvoke=require('electron').ipcRenderer.invoke;require('electron').ipcRenderer.invoke=(channel,...args)=>{if(channel==='migration:choose'&&window.__migrationChoosePrograms){window.__migrationCalls.push({channel,args});return Promise.resolve({sources:[window.__migrationChosenPrograms],errors:[]});}return window.__migrationPreviousInvoke(channel,...args);};true;`);
        window.setSize(1000, 680);
        await click('migration-detect');
        await until(() => evaluate("document.querySelectorAll('#migration-settings-sources .migration-source-card').length===2"));
        check(await evaluate("document.getElementById('migration-source-picker').value==='private-programs'"), '配置来源排在首位时默认优先预览实际有插件程序的来源');
        await evaluate("document.querySelector('[data-migration-preview=profile-only]').click();true;");
        check(await evaluate("document.getElementById('migration-source-picker').value==='profile-only'"), '用户明确选中配置来源后不被有程序的来源强制替换');
        await click('migration-skip');
        await evaluate(`window.__migrationFixtures=[${JSON.stringify(profileOnly)}];true;`);
        await click('migration-detect');
        await until(() => evaluate("document.querySelectorAll('#migration-settings-sources .migration-source-card').length===1"));
        check(await evaluate("document.getElementById('migration-settings-status').textContent.includes('当前只找到') && document.getElementById('migration-settings-sources').textContent.includes('不代表原插件已丢失') && Boolean(document.querySelector('[data-migration-plugin-select=profile-only]'))"), '仅配置来源的零程序计数解释原因并提供直接选择程序目录');
        await evaluate("document.querySelector('[data-migration-preview=profile-only]').click();true;");
        check(await evaluate("document.getElementById('migration-sources').textContent.includes('当前来源是用户数据目录') && document.querySelector('[data-option=toolsPlugins]').disabled && document.querySelector('[data-option=configs]').checked && !document.getElementById('migration-plugin-choose').disabled"), '配置预览明确程序缺失且仍可独立导入配置');
        await until(() => evaluate("!document.querySelector('.notification')"), '前一阶段模拟错误提示未自然关闭');
        fs.mkdirSync(output, { recursive: true });
        await window.webContents.capturePage(); await delay(120);
        fs.writeFileSync(path.join(output, 'profile-only-preview.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate('window.__migrationChoosePrograms=true;true;');
        await click('migration-plugin-choose');
        await until(() => evaluate("document.getElementById('migration-source-picker').value==='private-programs' && !document.getElementById('migration-plugin-choose').disabled"));
        check(await evaluate("document.getElementById('migration-dialog').open && document.getElementById('migration-sources').textContent.includes('效率插件目录 · 1 个') && document.getElementById('migration-sources').textContent.includes('E:/隔离自行安装插件/个人工具')"), '选择插件目录后自动切换至有程序的来源并展示目录及计数');
        check(await evaluate("document.getElementById('migration-sources').textContent.includes('已识别插件程序清单（1 个）') && document.getElementById('migration-sources').textContent.includes('个人工具 <测试>') && document.querySelector('.migration-program-list li').textContent.includes('self-installed-private')"), '预览清单显示自行安装的非公开插件名称和稳定目录ID');
        check(await evaluate("document.querySelector('[data-option=toolsPlugins]').checked && document.querySelector('[data-option=configs]').disabled && document.getElementById('migration-sources').textContent.includes('同名不覆盖') && document.getElementById('migration-sources').textContent.includes('非开源插件')"), '插件程序与配置分开勾选，明确非开源程序也可导入且不覆盖不运行');
        await evaluate("document.querySelector('.migration-program-list').open=true;true;");
        await window.webContents.capturePage();
        fs.writeFileSync(path.join(output, 'program-preview.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate('window.__migrationRunFailure=false;true;');
        await click('migration-run');
        await until(() => evaluate("!document.getElementById('migration-run').disabled && document.getElementById('migration-result').textContent.includes('导入完成')"));
        const programOptions = await evaluate("window.__migrationCalls.filter(item=>item.channel==='migration:run').at(-1).args[0]");
        check(programOptions.sourceId === 'private-programs' && programOptions.toolsPlugins && !programOptions.configs && !programOptions.pythonPlugins, '只选程序时提交程序导入选项，不误当成仅配置导入');
        await click('migration-skip');
        await evaluate('window.__migrationChoosePrograms=false;window.__migrationFixtures=window.__migrationOriginalFixtures;true;');
        await click('migration-detect');
        await until(() => evaluate("document.querySelectorAll('#migration-settings-sources .migration-source-card').length===2"));
        window.setSize(1000, 680); await delay(100);
        await evaluate("(async()=>{await loadSettings();window.activateSettingsTab('merge-migration');document.querySelectorAll('.notification').forEach(item=>item.remove());window.syncSettingsFooter();document.querySelector('.settings-main').scrollTop=0;return true;})()");
        fs.mkdirSync(output, { recursive: true });
        await window.webContents.capturePage(); await delay(150);
        fs.writeFileSync(path.join(output, 'settings.png'), (await window.webContents.capturePage()).toPNG());
        check(report.errors.length === 0, '数据导入界面无未处理异常');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'electron-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report)); app.isQuiting = true; app.exit(report.success ? 0 : 1);
    }
})();
setTimeout(() => { console.error('数据导入界面验收超时'); app.exit(2); }, 60000).unref();
