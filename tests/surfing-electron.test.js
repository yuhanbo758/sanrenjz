const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const plugin = path.join(__dirname, '..', 'app', 'software', 'obsidian-surfing');
const data = new Map();
ipcMain.handle('plugin-storage-get-async', (_event, _name, key) => data.get(key) || null);
ipcMain.handle('plugin-storage-set-async', (_event, _name, key, value) => { data.set(key, value); return true; });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, label) {
    for (let i = 0; i < 80; i++) {
        const value = await fn();
        if (value) return value;
        await delay(100);
    }
    throw new Error(`等待超时：${label}`);
}

async function inspect(width, port) {
    console.log(`检查 ${width}px`);
    const errors = [];
    const window = new BrowserWindow({
        show: false, x: -32000, y: -32000, width, height: 650,
        webPreferences: { preload: path.join(plugin, 'preload.js'), nodeIntegration: true, contextIsolation: false, webSecurity: false, webviewTag: true }
    });
    let attachedSource = '';
    window.webContents.on('will-attach-webview', (_event, preferences, params) => {
        attachedSource = params.src;
        delete preferences.preload;
        preferences.nodeIntegration = false;
        preferences.contextIsolation = true;
        preferences.webSecurity = true;
        preferences.sandbox = true;
    });
    window.webContents.on('did-attach-webview', (_event, guest) => {
        guest.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//i.test(url)) guest.loadURL(url).catch(() => {});
            return { action: 'deny' };
        });
    });
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    data.set('browser-settings', { homePage: `http://127.0.0.1:${port}/`, searchEngine: 'https://www.baidu.com/s?wd=' });
    await window.loadFile(path.join(plugin, 'index.html'));
    await window.webContents.insertCSS('body { padding-top: 32px !important; }');
    window.showInactive();
    await waitUntil(() => window.webContents.executeJavaScript(`document.querySelector('#addressBar').value.includes('127.0.0.1') && document.querySelector('#pageView').getTitle() === '测试首页'`), '主页加载');
    assert.strictEqual(attachedSource, `http://127.0.0.1:${port}/`);
    const first = await window.webContents.executeJavaScript(`(async()=>({
        title:document.querySelector('#pageTitle').textContent,
        address:document.querySelector('#addressBar').value,
        content:await document.querySelector('#pageView').executeJavaScript('({text:document.body.textContent,node:typeof require})'),
        scrollX:document.documentElement.scrollWidth-document.documentElement.clientWidth,
        scrollY:document.documentElement.scrollHeight-document.documentElement.clientHeight
    }))()`);
    assert.ok(first.address.includes(`127.0.0.1:${port}`));
    assert.strictEqual(first.title, '测试首页');
    assert.ok(first.content.text.includes('iframe 禁止嵌入'));
    assert.strictEqual(first.content.node, 'undefined');
    assert.ok(first.scrollX <= 1 && first.scrollY <= 1, JSON.stringify(first));
    await window.webContents.executeJavaScript(`document.querySelector('#bookmarkBtn').click()`);
    await window.webContents.executeJavaScript(`document.querySelector('#pageView').executeJavaScript("document.querySelector('#next').click()")`);
    await waitUntil(() => window.webContents.executeJavaScript(`document.querySelector('#addressBar').value.endsWith('/next') && !document.querySelector('#backBtn').disabled`), '站内导航');
    const second = await window.webContents.executeJavaScript(`({back:!document.querySelector('#backBtn').disabled,bookmarks:document.querySelectorAll('.bookmark-chip').length})`);
    assert.strictEqual(second.back, true);
    assert.strictEqual(second.bookmarks, 1);
    await window.webContents.executeJavaScript(`document.querySelector('#backBtn').click()`);
    await waitUntil(() => window.webContents.executeJavaScript(`document.querySelector('#addressBar').value.endsWith('/')`), '后退');
    await window.webContents.executeJavaScript(`document.querySelector('#forwardBtn').click()`);
    await waitUntil(() => window.webContents.executeJavaScript(`document.querySelector('#addressBar').value.endsWith('/next')`), '前进');
    await window.webContents.executeJavaScript(`document.querySelector('#backBtn').click()`);
    await waitUntil(() => window.webContents.executeJavaScript(`document.querySelector('#addressBar').value.endsWith('/')`), '再次后退');
    await window.webContents.executeJavaScript(`document.querySelector('#pageView').executeJavaScript("document.querySelector('#popup').click()")`);
    await waitUntil(() => window.webContents.executeJavaScript(`document.querySelector('#addressBar').value.endsWith('/popup')`), '新窗口链接');
    assert.strictEqual(BrowserWindow.getAllWindows().length, 1, '新窗口链接只能复用现有浏览器窗口');
    window.setSize(600, 650);
    await delay(100);
    const narrow = await window.webContents.executeJavaScript(`({scrollX:document.documentElement.scrollWidth-document.documentElement.clientWidth,scrollY:document.documentElement.scrollHeight-document.documentElement.clientHeight,addressWidth:document.querySelector('#addressBar').getBoundingClientRect().width})`);
    assert.ok(narrow.scrollX <= 1 && narrow.scrollY <= 1 && narrow.addressWidth > 100, JSON.stringify(narrow));
    if (process.env.SURFING_SCREENSHOT) {
        const output = path.join(__dirname, '..', 'dist', 'surfing-smoke.png');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, (await window.webContents.capturePage()).toPNG());
    }
    const settings = await window.webContents.executeJavaScript(`(()=>{
        document.querySelector('#menuBtn').click();
        [...document.querySelectorAll('#drawerContent button')].find(item=>item.textContent==='设置').click();
        const home=document.querySelector('#homeSetting');
        home.value='http://127.0.0.1:${port}/next';
        document.querySelector('#engineSetting').value='bing';
        [...document.querySelectorAll('#drawerContent button')].find(item=>item.textContent==='保存设置').click();
        return{drawerClosed:document.querySelector('#drawer').classList.contains('hidden'),bookmark:document.querySelectorAll('.bookmark-chip').length};
    })()`);
    assert.strictEqual(settings.drawerClosed, true);
    assert.strictEqual(settings.bookmark, 1);
    await waitUntil(() => data.get('browser-settings')?.searchEngine === 'https://www.bing.com/search?q=', '设置保存');
    assert.strictEqual(data.get('browser-settings').homePage, `http://127.0.0.1:${port}/next`);
    const delegated = await window.webContents.executeJavaScript(`(()=>{
        const enter=window.exports['main-feature'].args.enter;
        const view=document.querySelector('#pageView');
        let assigned=view.src;
        // 前面的用例已验证真实 webview 导航；此处截住 src 赋值，避免测试向外部搜索引擎发请求。
        Object.defineProperty(view,'src',{configurable:true,get(){return assigned},set(value){assigned=value}});
        const commands=['打开浏览器：我爱你','浏览器: 今天新闻','网页浏览：','打开浏览器','https://example.com/path'];
        return commands.map(payload=>{
            enter({type:'over',payload});
            return{address:document.querySelector('#addressBar').value,assigned};
        });
    })()`);
    assert.ok(delegated.every(item=>item.address===item.assigned),'委派结果应写入实际导航目标');
    assert.strictEqual(new URL(delegated[0].address).searchParams.get('q'),'我爱你','冒号前的打开浏览器指令不能进入搜索词');
    assert.strictEqual(new URL(delegated[1].address).searchParams.get('q'),'今天新闻','半角冒号也应只搜索后面的文本');
    assert.strictEqual(delegated[2].address,`http://127.0.0.1:${port}/next`,'只有浏览器命令时应打开主页');
    assert.strictEqual(delegated[3].address,`http://127.0.0.1:${port}/next`,'不带冒号的单纯打开命令也应打开主页');
    assert.strictEqual(delegated[4].address,'https://example.com/path','直接传入的网址应保持原样');
    assert.deepStrictEqual(errors, []);
    window.destroy();
}

(async () => {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' });
        response.end(request.url === '/next'
            ? '<!doctype html><title>第二页</title><p>站内导航成功</p>'
            : request.url === '/popup'
                ? '<!doctype html><title>新窗口链接</title><p>已在当前页打开</p>'
                : '<!doctype html><title>测试首页</title><p>iframe 禁止嵌入</p><a id="next" href="/next">下一页</a><a id="popup" target="_blank" href="/popup">新窗口</a>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let exitCode = 0;
    try {
        await app.whenReady();
        await inspect(1000, server.address().port);
        console.log('网页浏览 Electron 冒烟通过');
    } catch (error) {
        console.error(error);
        exitCode = 1;
    } finally {
        server.close();
        app.exit(exitCode);
    }
})().catch((error) => { console.error(error); app.exit(1); });
