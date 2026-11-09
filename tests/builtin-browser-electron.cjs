'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('node:assert/strict');
const { app, BrowserWindow, session } = require('electron');
const root = process.env.SANRENJZ_BROWSER_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('sanrenjz-browser-navigation-') || fs.lstatSync(root).isSymbolicLink()) throw new Error('需由父进程分配隔离导航测试目录');
const profile = path.join(root, 'profile');
fs.mkdirSync(profile);
process.env.APPDATA = path.join(root, 'isolated-appdata');
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_ACCEPTANCE = '1';
app.setName('sanrenjz-browser-navigation-test');
app.setPath('userData', profile);
app.disableHardwareAcceleration();
// 关闭最后一个窗口后还要确认BrowserView销毁并写报告，不允许Electron提前以0退出。
app.on('window-all-closed', () => {});
const report = { runId: process.env.SANRENJZ_BROWSER_TEST_RUN_ID, completed: false, realElectron: true, localFixtureOnly: true, isolatedProfile: true, assertions: [], errors: [], requests: [], screenshots: [] };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await condition()) return; await delay(25); }
    throw new Error(label);
}
const output = path.resolve(__dirname, '../dist/builtin-browser-validation');
let downloads = 0, refreshes = 0;
const server = http.createServer((req, res) => {
    report.requests.push({ path: req.url.split('?')[0], hasFixtureCookie: String(req.headers.cookie || '').includes('nav_fixture=1') });
    if (req.url === '/failure') { req.socket.destroy(); return; }
    if (req.url === '/plugin.zip') {
        res.setHeader('Content-Disposition', 'attachment; filename="fixture-plugin.zip"');
        res.end(Buffer.from([80, 75, 3, 4])); return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/start') {
        res.setHeader('Set-Cookie', 'nav_fixture=1; HttpOnly; SameSite=Lax; Path=/');
        res.end('<!doctype html><meta charset="utf-8"><title>隔离商店首页</title><h1>隔离插件商店</h1><a id="product" href="/product">查看产品</a><a id="product-blank" target="_blank" href="/product?new=1">新页产品</a>'); return;
    }
    if (req.url.startsWith('/product')) {
        refreshes++;
        res.end('<!doctype html><meta charset="utf-8"><title>隔离产品详情</title><h1>隔离产品</h1><a id="download" href="/plugin.zip">下载合成插件</a><button id="spa" onclick="history.pushState({},\'\',\'/product/spa\');document.title=\'SPA产品\'">进入SPA页面</button>'); return;
    }
    res.statusCode = 404; res.end('<!doctype html><title>未找到</title>');
});
const windows = [], contents = [];
process.on('unhandledRejection', error => report.errors.push(error.stack || String(error)));
const safe = promise => promise.catch(() => false);
async function ready(win) {
    win.webContents.setBackgroundThrottling(false);
    win.getBrowserView().webContents.setBackgroundThrottling(false);
    await until(() => safe(win.webContents.executeJavaScript("typeof window.builtinBrowser?.getState==='function'")), '本地导航桥未就绪');
    await until(() => safe(win.getBrowserView().webContents.executeJavaScript("Boolean(document.getElementById('product'))")), '隔离远程首页未就绪');
}
const state = win => win.webContents.executeJavaScript('window.builtinBrowser.getState()');
const act = (win, action) => win.webContents.executeJavaScript(`window.builtinBrowser.act(${JSON.stringify(action)})`);
const page = win => win.getBrowserView().webContents;
const click = (win, id) => win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click();true`);
async function clickPage(win, id) {
    // 隐藏窗口使用Electron的用户手势标记，避免Chromium将脚本导航从后退历史中跳过。
    await page(win).executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click();true`, true);
}
async function pagePath(win, expected) {
    await until(async () => {
        try { return new URL(page(win).getURL()).pathname === expected && !(await state(win)).loading && await page(win).executeJavaScript(`location.pathname===${JSON.stringify(expected)}&&document.readyState==='complete'`); }
        catch (_) { return false; }
    }, `页面未导航到${expected}`);
}
async function closeWindow(win) {
    if (!win || win.isDestroyed()) return;
    await new Promise(resolve => { win.once('closed', resolve); win.destroy(); });
}
app.whenReady().then(async () => {
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const shopSession = session.fromPartition('persist:sanrenjz-shop');
        shopSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }));
        shopSession.on('will-download', (event, item) => { event.preventDefault(); downloads++; });
        const { createBuiltinBrowserWindow, TOOLBAR_HEIGHT } = require('../app/builtin-browser');
        const open = () => {
            const win = createBuiltinBrowserWindow({ url: `${origin}/start`, title: '隔离程序小店', toolbarFile: path.resolve(__dirname, '../assets/builtin-browser.html'), session: shopSession, show: false, isDownloadUrl: url => new URL(url).pathname.endsWith('.zip') });
            windows.push(win); contents.push(page(win)); return win;
        };
        const win = open(); await ready(win); await pagePath(win, '/start');
        check(!win.isVisible(), '测试窗口始终隐藏，不抢前台焦点');
        check(win.webContents !== page(win), '本地导航栏与远程网页由不同WebContents承载');
        check(page(win).session === shopSession, '远程网页沿用原商店持久会话');
        check(await page(win).executeJavaScript("typeof require==='undefined' && typeof window.builtinBrowser==='undefined'"), '远程页面没有Node或本地导航桥权限');
        check(!(await state(win)).canGoBack && !(await state(win)).canGoForward, '首个页面前进后退均不可用');
        await until(() => win.webContents.executeJavaScript("document.getElementById('browser-back').disabled && document.getElementById('browser-forward').disabled"), '初始按钮未禁用');
        check(await win.webContents.executeJavaScript("[...document.querySelectorAll('#browser-back,#browser-forward,#browser-reload,#browser-home')].every(button=>button.getBoundingClientRect().height>0)"), '四个导航按钮实际渲染并可见');
        await clickPage(win, 'product'); await pagePath(win, '/product');
        await until(async () => (await state(win)).canGoBack, '进入产品后没有形成后退历史');
        check((await state(win)).canGoBack && !(await state(win)).canGoForward, '进入产品后可退回来源列表');
        await until(() => win.webContents.executeJavaScript("!document.getElementById('browser-back').disabled"), '产品页面后退按钮未启用');
        await click(win, 'browser-back'); await pagePath(win, '/start');
        check((await state(win)).canGoForward, '真实后退按钮恢复首页并启用前进');
        await click(win, 'browser-forward'); await pagePath(win, '/product');
        check((await state(win)).canGoBack, '真实前进按钮恢复产品页面');
        await clickPage(win, 'spa'); await pagePath(win, '/product/spa');
        await act(win, 'back'); await pagePath(win, '/product');
        await act(win, 'forward'); await pagePath(win, '/product/spa');
        check((await state(win)).canGoBack, 'SPA pushState历史可通过导航栏后退及前进');
        const beforeReload = refreshes;
        await click(win, 'browser-reload');
        await until(() => refreshes > beforeReload, '刷新未重新请求当前页面'); await pagePath(win, '/product/spa');
        check(refreshes > beforeReload, '真实刷新按钮重新加载当前页面');
        page(win).sendInputEvent({ type: 'keyDown', keyCode: 'Left', modifiers: ['alt'] });
        page(win).sendInputEvent({ type: 'keyUp', keyCode: 'Left', modifiers: ['alt'] });
        await pagePath(win, '/product');
        page(win).sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['alt'] });
        page(win).sendInputEvent({ type: 'keyUp', keyCode: 'Right', modifiers: ['alt'] });
        await pagePath(win, '/product/spa');
        check(true, '远程内容区Alt+左右箭头真实键盘输入可前进后退');
        await click(win, 'browser-home'); await pagePath(win, '/start');
        check(!(await state(win)).loading, '起始页按钮返回窗口初始商店页面');
        const windowCount = BrowserWindow.getAllWindows().length;
        await clickPage(win, 'product-blank'); await pagePath(win, '/product');
        check(BrowserWindow.getAllWindows().length === windowCount && (await state(win)).canGoBack, '同站target_blank产品链接留在当前窗口并形成历史');
        const beforeDownload = page(win).getURL();
        await clickPage(win, 'download');
        await until(() => downloads === 1, '商店下载没有触发原Session下载事件');
        check(page(win).getURL() === beforeDownload, '下载使用原会话且不覆盖当前产品页面');
        check(report.requests.some(request => request.path.startsWith('/product') && request.hasFixtureCookie), '跨页及刷新仍发送隔离HttpOnly会话Cookie');
        check(await page(win).executeJavaScript("!document.cookie.includes('nav_fixture')"), 'HttpOnly会话Cookie仍对网页脚本不可见');
        const win2 = open(); await ready(win2); await pagePath(win2, '/start');
        check(!(await state(win2)).canGoBack && (await state(win)).canGoBack, '多个商店窗口分别维护独立浏览历史');
        await act(win2, 'back'); await pagePath(win, '/product');
        check(!(await state(win2)).canGoBack, '另一窗口的无效后退不会改动当前窗口历史');
        win.setSize(760, 610); await delay(80);
        const [width, height] = win.getContentSize(), bounds = win.getBrowserView().getBounds();
        check(bounds.x === 0 && bounds.y === TOOLBAR_HEIGHT && bounds.width === width && bounds.height === height - TOOLBAR_HEIGHT, '改变窗口尺寸后网页正确避让固定导航栏');
        const beforeUnsupported = page(win).getURL();
        const unsupportedDenied = await win.webContents.executeJavaScript("window.builtinBrowser.act('__proto__').then(()=>false,()=>true)");
        check(unsupportedDenied && page(win).getURL() === beforeUnsupported, '导航桥只接受固定操作，不接受任意方法或地址');
        const rogue = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } }); windows.push(rogue);
        const rogueFile = path.join(root, 'untrusted-fixture.html'); fs.writeFileSync(rogueFile, '<!doctype html><title>隔离非导航来源</title>'); await rogue.loadFile(rogueFile);
        const denied = await rogue.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('builtin-browser:action','back').then(()=>false,()=>true)");
        check(denied && page(win).getURL() === beforeUnsupported, '未注册的渲染进程不能控制商店导航');
        await safe(page(win).loadURL(`${origin}/failure`));
        await until(async () => Boolean((await state(win)).error), '加载失败没有反馈到独立导航栏');
        check(await win.webContents.executeJavaScript("Boolean(window.builtinBrowser && document.getElementById('browser-home'))"), '远程加载失败不会销毁导航栏');
        await click(win, 'browser-home'); await pagePath(win, '/start');
        check(!(await state(win)).error, '加载失败后仍能回到起始页并恢复正常状态');
        await until(() => win.webContents.executeJavaScript("document.getElementById('browser-title').textContent==='隔离商店首页'"), '回到起始页后导航标题没有刷新');
        check((await state(win)).title === '隔离商店首页', '跨页及加载恢复后导航标题同步当前页面');
        await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        fs.mkdirSync(output, { recursive: true });
        const screenshot = path.join(output, 'toolbar.png'); fs.writeFileSync(screenshot, (await win.webContents.capturePage({ x: 0, y: 0, width: win.getContentSize()[0], height: TOOLBAR_HEIGHT })).toPNG()); report.screenshots.push('toolbar.png');
        const toClose = page(win2); await closeWindow(win2);
        await until(() => toClose.isDestroyed(), '关闭窗口后远程内容进程仍未销毁');
        check(toClose.isDestroyed(), '关闭窗口显式销毁BrowserView网页内容');
        check(report.errors.length === 0, '导航验收无未处理异步错误');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        for (const win of windows) await closeWindow(win);
        try { await until(() => contents.every(content => content.isDestroyed()), '远程内容未完全销毁', 3000); }
        catch (error) { report.success = false; report.errors.push(error.message); }
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        report.remainingGuestContents = contents.filter(content => !content.isDestroyed()).length;
        if (report.remainingGuestContents) { report.success = false; report.errors.push('远程内容未完全销毁'); }
        report.completed = true;
        fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'electron-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report)); app.exit(report.success ? 0 : 1);
    }
});
setTimeout(() => { console.error('隔离商店导航验收超时'); app.exit(2); }, 100000).unref();
