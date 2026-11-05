const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert/strict');
const { app, BrowserWindow, session, globalShortcut, safeStorage } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-account-'));
const profile = path.join(root, 'profile'), tools = path.join(root, 'tools'), python = path.join(root, 'python');
for (const dir of [profile, tools, python]) fs.mkdirSync(dir);
const fixture = path.join(tools, 'safe-fixture'); fs.mkdirSync(fixture);
fs.writeFileSync(path.join(fixture, 'plugin.json'), JSON.stringify({ pluginName: '隔离登录测试', main: 'index.html' }));
fs.writeFileSync(path.join(fixture, 'index.html'), '<p>safe fixture</p>');
const settings = JSON.stringify({ autoStart: false, globalHotkey: '', pinHotkey: '', superPanelHotkey: '', pythonMode: 'none', migrationPrompted: true, enableRightClickPanel: false });
fs.writeFileSync(path.join(profile, 'settings.json'), settings);
process.env.SANRENJZ_USER_DATA = profile; process.env.SANRENJZ_ACCEPTANCE = '1';
app.setPath('userData', profile); app.disableHardwareAcceleration(); app.setLoginItemSettings = () => {};
globalShortcut.register = () => true; globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {}; globalShortcut.isRegistered = () => false;
class FixtureManager extends RealManager { constructor(win, options) { super(win, options); this.pluginDir = tools; this.catalog = new PluginCatalog(tools); } }
class FixturePython extends pythonModule.PythonManager { constructor(options) { super({ ...options, pluginDir: python }); } async run() { throw new Error('隔离测试不运行业务'); } }
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };
const report = { assertions: [], errors: [], isolatedProfile: true, electronVersion: process.versions.electron };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(25); } throw new Error(label); }
let serviceUnavailable = false, pythonUnavailable = false, bearerSent = false;
let legacyAllowed = false, holdBearer = false, bearerMeCount = 0;
let explicitSignedOut = '';
const heldBearerResponses = [];
const server = http.createServer((req, res) => {
    if (req.headers.authorization) bearerSent = true;
    if (req.url === '/member-center') { res.end('<!doctype html><title>隔离登录页</title><button id="fixture-login" onclick="fetch(\'/fixture/login\',{method:\'POST\'})">登录</button>'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/fixture/login') { res.setHeader('Set-Cookie', 'srj_shop_test=fixture-browser-session; HttpOnly; SameSite=Lax; Path=/'); res.end('{}'); return; }
    if (serviceUnavailable) { res.statusCode = 503; res.end('{}'); return; }
    if (!String(req.headers.cookie || '').includes('srj_shop_test=fixture-browser-session') && !(legacyAllowed && req.headers.authorization)) { res.statusCode = 401; res.end('{}'); return; }
    if (req.url.startsWith('/api/users/electron/me?')) {
        if (explicitSignedOut) { res.end(JSON.stringify(explicitSignedOut === 'data' ? { data: { authenticated: false } } : { authenticated: false })); return; }
        if (req.headers.authorization) {
            bearerMeCount++;
            if (holdBearer) { heldBearerResponses.push(res); return; }
        }
        res.end(JSON.stringify({ user: { id: 'isolated-user', username: '隔离用户' } })); return;
    }
    if (req.url.startsWith('/api/users/electron/access?')) {
        if (pythonUnavailable && req.url.includes('python')) { res.statusCode = 503; res.end('{}'); return; }
        res.end(JSON.stringify({ canDownloadUpdates: req.url.includes('tools') })); return;
    }
    res.statusCode = 404; res.end('{}');
});
process.on('unhandledRejection', error => report.errors.push(error.message));
const ready = new Promise(resolve => app.once('browser-window-created', (_event, win) => win.webContents.once('did-finish-load', () => resolve(win))));
(async () => {
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        process.env.SANRENJZ_TOOLS_SHOP_BASE_URL = origin;
        app.whenReady().then(() => {
            session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
            session.fromPartition('persist:sanrenjz-shop').webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }));
        });
        require('../main');
        const win = await ready; win.webContents.setBackgroundThrottling(false);
        const evaluate = script => win.webContents.executeJavaScript(script);
        const invoke = channel => evaluate(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)})`);
        const first = await invoke('account:me'); check(!first.authenticated && !first.verificationFailed, '无会话明确显示未登录');
        await invoke('account:login');
        let browser;
        await until(() => { browser = BrowserWindow.getAllWindows().find(candidate => candidate !== win && candidate.webContents.getURL().startsWith(origin)); return browser; }, '未创建隔离商店窗口');
        await until(() => browser.webContents.executeJavaScript("Boolean(document.getElementById('fixture-login'))").catch(() => false), '隔离页面未就绪');
        await browser.webContents.executeJavaScript("document.getElementById('fixture-login').click();true");
        await until(() => evaluate("accountState.authenticated && document.getElementById('account-name').textContent==='隔离用户'"), 'Cookie登录后宿主未自动同步');
        check(await browser.webContents.executeJavaScript("!localStorage.getItem('token') && !document.cookie.includes('fixture-browser-session')"), '无localStorage令牌且HttpOnly Cookie对页面脚本不可见');
        const loggedIn = await invoke('account:me');
        check(loggedIn.authenticated && loggedIn.access.tools.member && !loggedIn.access.python.member, '真实Electron网络请求使用商店分区Cookie，分别显示两类会员');
        check(!bearerSent && !fs.existsSync(path.join(profile, 'account-token.bin')), '新登录不复制Cookie或创建Bearer文件');
        pythonUnavailable = true;
        const partial = await invoke('account:me');
        check(partial.authenticated && partial.access.tools.member && !partial.access.python.available, '单类会员查询失败保留账号及另一类权限');
        serviceUnavailable = true;
        const failed = await invoke('account:me');
        check(failed.authenticated && failed.verificationFailed, '网络或服务故障保留已确认账号并标记待确认');
        await until(() => evaluate("document.getElementById('account-status').textContent.includes('暂时无法确认')"), '服务错误提示未显示');
        check(await evaluate("document.getElementById('account-name').textContent==='隔离用户' && document.getElementById('account-refresh-btn').style.display!=='none'"), '服务故障可重试且不误报未登录');
        serviceUnavailable = false; pythonUnavailable = false;
        for (const location of ['root', 'data']) {
            explicitSignedOut = location;
            const invalidated = await invoke('account:me');
            check(!invalidated.authenticated && !invalidated.verificationFailed, `HTTP200 ${location}明确未登录清除已确认账号`);
            explicitSignedOut = '';
            check((await invoke('account:me')).authenticated, `有效Cookie可在${location}未登录响应后重新确认`);
        }
        const builtinSession = session.fromPartition('persist:sanrenjz-shop');
        const originalRemove = builtinSession.cookies.remove.bind(builtinSession.cookies);
        const legacy = ['fixture', 'legacy', 'jwt'].join('.');
        fs.writeFileSync(path.join(profile, 'account-token.bin'), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(legacy) : Buffer.from(legacy));
        legacyAllowed = true; holdBearer = true;
        await originalRemove(origin, 'srj_shop_test');
        const pendingLegacy = invoke('account:me');
        await until(() => heldBearerResponses.length > 0, '旧Bearer请求没有进入延迟响应');
        await builtinSession.cookies.set({ url: origin, name: 'srj_shop_test', value: 'fixture-browser-session', httpOnly: true, path: '/' });
        let removeStarted = false;
        builtinSession.cookies.remove = async (...args) => {
            await originalRemove(...args);
            if (args[1] === 'srj_shop_test') { removeStarted = true; await delay(400); }
        };
        const loggingOut = invoke('account:logout');
        await until(() => removeStarted, 'Cookie清理没有进入延迟区间');
        const beforeConcurrentRefresh = bearerMeCount;
        await delay(180);
        check(!(await invoke('account:me')).authenticated, '异步清理Cookie期间并发刷新保持退出且不尝试旧Bearer');
        browser.emit('focus');
        check(await invoke('account:login').then(() => false, error => error.message.includes('正在退出')), '退出处理中拒绝新的登录窗口同步');
        check(bearerMeCount === beforeConcurrentRefresh, '延迟Cookie清理超过自动刷新间隔仍不产生旧Bearer刷新');
        const loggedOut = await loggingOut;
        builtinSession.cookies.remove = originalRemove;
        holdBearer = false;
        for (const response of heldBearerResponses.splice(0)) response.end(JSON.stringify({ user: { id: 'isolated-user', username: '隔离用户' } }));
        check(!(await pendingLegacy).authenticated, '退出前在途旧Bearer成功响应不得复活账号');
        await delay(200);
        check(!fs.existsSync(path.join(profile, 'account-token.bin')) && !(await invoke('account:me')).authenticated, '旧窗口与延迟响应均不得重写令牌或恢复登录');
        check(!loggedOut.authenticated, '宿主退出清理当前应用商店会话');
        await until(() => evaluate("!accountState.authenticated && document.getElementById('account-name').textContent==='未登录'"), '退出UI未同步');
        check(!(await invoke('account:me')).authenticated, '退出后复查不恢复旧登录');
        await invoke('account:login');
        await builtinSession.cookies.set({ url: origin, name: 'srj_shop_test', value: 'fixture-browser-session', httpOnly: true, path: '/' });
        await until(() => evaluate('accountState.authenticated'), '显式重新登录未解除会话抑制');
        builtinSession.cookies.remove = async () => { throw new Error('isolated removal failure'); };
        const incomplete = await invoke('account:logout');
        check(!incomplete.authenticated && incomplete.cleanupFailed && incomplete.error.includes('未完全清理'), 'Cookie删除失败明确报告，账号本地仍退出');
        await delay(200);
        check(!(await invoke('account:me')).authenticated, '残留有效Cookie不能在退出失败后自动恢复账号');
        check(await evaluate("document.getElementById('account-status').textContent.includes('清理未完成') && document.getElementById('account-logout-btn').style.display==='block'"), '清理失败界面明确提示并提供退出重试');
        builtinSession.cookies.remove = originalRemove;
        const retried = await invoke('account:logout');
        check(!retried.cleanupFailed && !retried.authenticated, '重试成功清理残留会话且保持退出');
        check(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8') === settings, '登录和退出不修改现有设置');
        check(report.errors.length === 0, '无未处理认证错误'); report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || error.message); }
    finally {
        const output = path.resolve(__dirname, '../dist/shop-account-validation'); fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'electron-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report)); server.close(); app.isQuiting = true; app.exit(report.success ? 0 : 1);
    }
})();
setTimeout(() => app.exit(2), 30000).unref();
