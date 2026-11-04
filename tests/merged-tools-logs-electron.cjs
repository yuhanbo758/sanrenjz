const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session, ipcMain } = require('electron');
const Manager = require('../app/software_manager');
const { PluginCatalog } = require('../app/plugin-catalog');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-tools-logs-'));
const profile = path.join(temporary, 'profile'), plugins = path.join(temporary, '插件 空格');
fs.mkdirSync(profile); fs.mkdirSync(plugins);
app.setPath('userData', profile); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
ipcMain.handle('get-plugin-pin-status-window', () => false);
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.showInactive = () => {}; win.focus = () => {}; });
const report = { assertions: [], errors: [], hidden: true, isolatedProfile: true, temporaryRoot: temporary };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
process.on('unhandledRejection', error => report.errors.push(String(error)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(checker) { const deadline = Date.now() + 8000; while (!checker()) { if (Date.now() > deadline) throw new Error('等待日志或进程超时'); await delay(20); } }
function fixture(folder, name, main, body) {
    const directory = path.join(plugins, folder); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: name, main }));
    if (body !== undefined) fs.writeFileSync(path.join(directory, main), body);
    return directory;
}
const html = fixture('html-one', '同名 中文', 'index.html', '<!doctype html><meta charset="utf-8"><script>console.log("HTML中文🌟");console.error("HTML错误示例");</script>');
const broken = fixture('broken', '加载失败示例', 'missing.html');
const js = fixture('js-one', 'JS日志示例', 'main.js', `
process.send({type:'output', data:'IPC标准输出'});
process.send({type:'error', data:'IPC错误输出'});
const bytes=Buffer.from('逐字节中文🌟\\n');let i=0;
function write(){if(i<bytes.length){process.stdout.write(bytes.subarray(i,i+1));i++;setTimeout(write,4);}else{process.stderr.write('无换行错误🌟');setTimeout(()=>process.exit(0),20);}}
write();`);
const jsFailure = fixture('js-failure', 'JS失败示例', 'main.js', 'setTimeout(()=>process.exit(7),30);');
const jsStop = fixture('js-stop', 'JS停止示例', 'main.js', 'setInterval(()=>{},1000);');
let manager;
app.whenReady().then(async () => {
    const events = [], terminal = [];
    try {
        session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
        const host = { isDestroyed: () => false, webContents: { send: (channel, text) => terminal.push({ channel, text }) } };
        manager = new Manager(host, { loadSettings: () => ({ enableRightClickPanel: false }), onLog: event => events.push(event) });
        manager.pluginDir = plugins; manager.catalog = new PluginCatalog(plugins);
        check((await manager.runPlugin(html)).success, 'HTML插件可正常打开');
        await until(() => events.some(event => event.message === 'HTML中文🌟'));
        check(events.some(event => event.id === 'tools:html-one' && event.name === '同名 中文' && event.engine === 'tools' && event.stream === 'stdout'), '控制台日志包含稳定ID、名称与效率类型');
        check(events.some(event => event.message === 'HTML错误示例' && event.stream === 'stderr'), 'HTML console.error进入错误日志');
        check(events.some(event => event.stream === 'system' && event.message.includes('创建')), '窗口生命周期进入系统日志');
        const win = manager.pluginWindows.get('同名 中文');
        const originalCount = events.filter(event => event.message === 'HTML中文🌟').length;
        check((await manager.runPlugin(html)).success && manager.pluginWindows.get('同名 中文') === win, '复用现有窗口不创建新实例');
        await win.webContents.executeJavaScript('console.log("复用后单次输出");console.log("插件存储获取结果: value-must-not-appear");console.log("序列化测试通过: config-must-not-appear");true;');
        await delay(80);
        check(events.filter(event => event.message === '复用后单次输出').length === 1 && events.filter(event => event.message === 'HTML中文🌟').length === originalCount, '窗口复用不重复注册日志监听');
        check(!events.some(event => /value-must-not-appear|config-must-not-appear/.test(event.message)), '宿主存储调试值不进入统一日志');
        await win.webContents.executeJavaScript('console.warn("业务警告必须保留");console.warn("Electron Security Warning isolated-framework-only");console.warn("%cElectron Security Warning (Insecure Content-Security-Policy) isolated-native-format", "font-weight:bold");console.log("自定义标题栏创建完成");console.log("插件初始钉住状态: isolated-host-debug");console.log("注册插件进入事件");true;');
        await delay(60);
        check(events.some(event => event.stream === 'stderr' && event.message === '业务警告必须保留') && !events.some(event => /^(?:%c)?Electron Security Warning|^自定义标题栏创建完成$|^插件初始钉住状态:|^注册插件进入事件$/.test(event.message)), '仅过滤已知框架与宿主调试，业务警告仍进入错误日志');
        check(manager.createOrShowPluginIndicatorWindow('同名 中文'), '插件指示器辅助窗口可创建');
        await until(() => events.filter(event => event.id === 'tools:html-one' && event.message === 'HTML中文🌟').length === 2);
        check(events.some(event => event.id === 'tools:html-one' && event.message === '插件指示器窗口已创建'), '辅助窗口控制台归属同一个插件');
        manager.closePluginIndicatorWindow('同名 中文');
        await until(() => events.some(event => event.id === 'tools:html-one' && event.message === '插件指示器窗口已关闭'));
        const beforeUnknown = events.length; manager.sendOutput('旧终端无上下文输出');
        check(events.length === beforeUnknown && terminal.some(item => item.text === '旧终端无上下文输出'), '旧终端保持兼容且无上下文不误归属插件');
        const failed = await manager.runPlugin(broken);
        check(!failed.success && events.some(event => event.id === 'tools:broken' && event.stream === 'stderr'), '启动失败关联正确插件并明确记录');
        await win.webContents.loadURL('file:///' + path.join(temporary, 'does-not-exist.html').replace(/\\/g, '/')).catch(() => {});
        await until(() => events.some(event => event.id === 'tools:html-one' && event.message.includes('页面加载失败')));
        check(true, '真实页面加载失败进入错误日志');
        manager.stopPlugin('同名 中文');
        await until(() => events.some(event => event.id === 'tools:html-one' && event.message.includes('窗口已关闭')));
        check(events.some(event => event.id === 'tools:html-one' && event.message.includes('窗口已关闭')) && events.some(event => event.id === 'tools:html-one' && event.message.includes('已停止')), '关闭和停止保留原插件身份');
        check((await manager.runPlugin(js)).success, '真实JS子进程可启动');
        await until(() => !manager.pluginProcesses.has('JS日志示例'));
        const jsEvents = events.filter(event => event.id === 'tools:js-one');
        check(jsEvents.some(event => event.message === 'IPC标准输出') && jsEvents.some(event => event.message === 'IPC错误输出'), 'JS IPC output/error正确关联且继续转发');
        check(jsEvents.some(event => event.message === '逐字节中文🌟') && !jsEvents.some(event => event.message.includes('�')), 'JS stdout连续解码跨字节中文emoji');
        check(jsEvents.some(event => event.stream === 'stderr' && event.message === '无换行错误🌟'), 'JS无换行stderr在结束时刷新');
        check(jsEvents.some(event => event.stream === 'system' && event.message.includes('已退出（0）')), 'JS正常退出记录在输出之后');
        check(terminal.some(item => item.channel === 'terminal-output' && item.text === 'IPC标准输出') && terminal.some(item => item.channel === 'terminal-error' && item.text === 'IPC错误输出'), '旧terminal输出和错误通道继续工作');
        await manager.runPlugin(jsFailure); await until(() => !manager.pluginProcesses.has('JS失败示例'));
        check(events.some(event => event.id === 'tools:js-failure' && event.stream === 'stderr' && event.message.includes('7')), 'JS异常退出记录退出码');
        await manager.runPlugin(jsStop); const stopped = manager.pluginProcesses.get('JS停止示例');
        manager.stopPlugin('JS停止示例');
        await until(() => events.some(event => event.id === 'tools:js-stop' && event.message === '插件进程已停止'));
        check(stopped.killed && !events.some(event => event.id === 'tools:js-stop' && event.message.includes('异常退出')), '主动停止不误报异常退出');
        manager.onLog = async () => { throw new Error('模拟异步日志通知失败'); };
        manager.sendOutput('通知失败不会中断', { id: 'tools:js-one', name: 'JS日志示例' });
        manager.onLog = () => { throw new Error('模拟同步日志通知失败'); };
        manager.sendError('同步通知失败也不中断', { id: 'tools:js-one', name: 'JS日志示例' });
        await delay(60);
        check(report.errors.length === 0, '日志回调失败不形成未处理拒绝或打断管理器');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        const remaining = [...(manager?.pluginProcesses.values() || [])]; manager?.stopAllPlugins();
        for (const child of remaining) if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(2000)]);
        for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
        const output = path.resolve(__dirname, '../dist/merged-tools-logs-report.json');
        fs.writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
        app.exit(report.success ? 0 : 1);
    }
});
setTimeout(() => { console.error('效率日志采集验收超时'); manager?.stopAllPlugins(); app.exit(2); }, 35000).unref();
