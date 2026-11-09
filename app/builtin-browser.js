'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const TOOLBAR_HEIGHT = 28;
const ipcContexts = new WeakMap();
function webUrl(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url : null; }
    catch (_) { return null; }
}

function bindNavigationIPC(ipcMain) {
    if (ipcContexts.has(ipcMain)) return ipcContexts.get(ipcMain);
    const windows = new Map();
    const controller = event => {
        const entry = windows.get(event.sender.id);
        // 导航桥只属于本地工具栏主frame，商店网页与其它插件无权调用。
        if (!entry || entry.window.isDestroyed() || event.sender !== entry.window.webContents ||
            event.senderFrame !== event.sender.mainFrame || event.sender.getURL() !== entry.toolbarUrl) throw new Error('请使用本窗口的导航栏');
        return entry;
    };
    ipcMain.handle('builtin-browser:get-state', event => controller(event).state());
    ipcMain.handle('builtin-browser:action', (event, action) => {
        const entry = controller(event);
        if (!['back', 'forward', 'reload', 'home'].includes(action)) throw new Error('不支持的导航操作');
        return entry.act(action);
    });
    ipcContexts.set(ipcMain, windows);
    return windows;
}

function createBuiltinBrowserWindow({ url, title = '程序小店', icon, toolbarFile, session, isDownloadUrl = () => false,
    isSameSite, onNewWindow, show = true, electron = require('electron') }) {
    const initial = webUrl(url);
    if (!initial) throw new Error('此链接无法在内置浏览器中打开');
    const { BrowserWindow, BrowserView, ipcMain } = electron;
    const windows = bindNavigationIPC(ipcMain);
    const window = new BrowserWindow({ width: 1100, height: 750, minWidth: 640, minHeight: 480, show: false,
        title, icon, autoHideMenuBar: true, backgroundColor: '#ffffff',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
            partition: 'sanrenjz-browser-ui', preload: path.join(__dirname, 'builtin-browser-preload.js') }
    });
    const view = new BrowserView({ webPreferences: { nodeIntegration: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, session } });
    const contents = view.webContents, toolbar = window.webContents, toolbarId = toolbar.id;
    const toolbarUrl = pathToFileURL(toolbarFile).href;
    let error = '', requestedUrl = initial.href;
    const layout = () => {
        if (window.isDestroyed() || contents.isDestroyed()) return;
        const [width, height] = window.getContentSize();
        view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: Math.max(1, width), height: Math.max(1, height - TOOLBAR_HEIGHT) });
    };
    window.setBrowserView(view); view.setBackgroundColor('#ffffff'); layout();
    const state = () => {
        const active = !contents.isDestroyed();
        const location = webUrl(active ? contents.getURL() : '') || webUrl(requestedUrl);
        return { canGoBack: active && contents.canGoBack(), canGoForward: active && contents.canGoForward(),
            loading: active && contents.isLoading(), title: active ? String(contents.getTitle() || title).slice(0, 160) : title,
            host: location?.host || '', error };
    };
    const publish = () => {
        if (!window.isDestroyed() && !toolbar.isDestroyed()) toolbar.send('builtin-browser:state', state());
    };
    const failed = () => { error = '页面未能加载，可返回上一页或刷新重试'; publish(); };
    const load = destination => {
        const target = webUrl(destination);
        if (!target || contents.isDestroyed()) { error = '此链接无法在内置浏览器中打开'; publish(); return; }
        requestedUrl = target.href; error = '';
        contents.loadURL(target.href).catch(failure => { if (!contents.isDestroyed() && failure.code !== 'ERR_ABORTED') failed(); });
    };
    const act = action => {
        if (contents.isDestroyed()) return state();
        try {
            if (action === 'back' && contents.canGoBack()) { error = ''; contents.goBack(); }
            else if (action === 'forward' && contents.canGoForward()) { error = ''; contents.goForward(); }
            else if (action === 'reload') { error = ''; contents.reload(); }
            else if (action === 'home') load(initial.href);
        } catch (_) { failed(); }
        publish(); return state();
    };
    const entry = { window, toolbarUrl, state, act };
    windows.set(toolbarId, entry);

    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) contents.on(name, publish);
    contents.on('did-start-navigation', (_event, destination, _inPlace, mainFrame) => {
        if (mainFrame) { requestedUrl = webUrl(destination)?.href || requestedUrl; error = ''; publish(); }
    });
    contents.on('did-fail-load', (_event, code, _description, _destination, mainFrame) => {
        if (mainFrame !== false && code !== -3) failed();
    });
    contents.on('render-process-gone', () => { error = '页面已停止响应，请刷新重试'; publish(); });
    contents.on('page-title-updated', (_event, value) => { if (!window.isDestroyed()) window.setTitle(value || title); publish(); });
    const navigate = (event, destination) => {
        if (!webUrl(destination)) { event.preventDefault(); error = '此链接无法在内置浏览器中打开'; publish(); }
        else if (isDownloadUrl(destination)) { event.preventDefault(); contents.downloadURL(destination); }
    };
    contents.on('will-navigate', navigate); contents.on('will-redirect', navigate);
    contents.setWindowOpenHandler(({ url: destination }) => {
        const target = webUrl(destination);
        if (!target) { error = '此链接无法在内置浏览器中打开'; publish(); return { action: 'deny' }; }
        if (isDownloadUrl(destination)) contents.downloadURL(destination);
        else {
            // 商品的新窗口链接也纳入当前历史；外部登录/支付窗口沿用独立受控窗口。
            const sameSite = isSameSite ? isSameSite(destination) : target.origin === initial.origin;
            if (sameSite || !onNewWindow) load(destination);
            else { try { Promise.resolve(onNewWindow(destination)).catch(failed); } catch (_) { failed(); } }
        }
        return { action: 'deny' };
    });
    const keyboard = (event, input) => {
        if (input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat) return;
        let action;
        if (input.alt && !input.control && !input.meta && !input.shift) {
            if (['ArrowLeft', 'Left'].includes(input.key)) action = 'back';
            if (['ArrowRight', 'Right'].includes(input.key)) action = 'forward';
            if (input.key === 'Home') action = 'home';
        } else if (!input.alt && !input.shift && ((input.control || input.meta) && input.key.toLowerCase() === 'r' || !input.control && !input.meta && input.key === 'F5')) action = 'reload';
        else if (input.meta && !input.alt && !input.control && !input.shift && ['[', ']'].includes(input.key)) action = input.key === '[' ? 'back' : 'forward';
        if (action) { event.preventDefault(); act(action); }
    };
    contents.on('before-input-event', keyboard); toolbar.on('before-input-event', keyboard);
    const mouseCommand = (event, command) => {
        const action = { 'browser-backward': 'back', 'browser-forward': 'forward' }[command];
        if (action) { event.preventDefault(); act(action); }
    };
    window.on('app-command', mouseCommand); window.on('resize', layout);
    toolbar.on('will-navigate', event => event.preventDefault());
    toolbar.on('will-redirect', event => event.preventDefault());
    toolbar.setWindowOpenHandler(() => ({ action: 'deny' }));
    toolbar.on('did-finish-load', publish);
    contents.on('destroyed', () => { if (!window.isDestroyed()) window.close(); });
    window.on('closed', () => {
        windows.delete(toolbarId);
        window.removeListener('resize', layout); window.removeListener('app-command', mouseCommand);
        if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    });
    if (show) window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    window.loadFile(toolbarFile).catch(() => { if (!window.isDestroyed()) window.close(); });
    load(initial.href);
    return window;
}

module.exports = { createBuiltinBrowserWindow, TOOLBAR_HEIGHT };
