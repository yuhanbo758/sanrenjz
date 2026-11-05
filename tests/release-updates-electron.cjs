const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { app, BrowserWindow, globalShortcut, net, session, shell } = require('electron');
const { PluginCatalog } = require('../app/plugin-catalog');
const RealManager = require('../app/software_manager');
const pythonModule = require('../app/python-manager');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-update-ui-'));
const profile = path.join(root, 'profile');
const toolsDir = path.join(root, 'tools');
const pythonDir = path.join(root, 'python');
const output = path.resolve(__dirname, '../dist/release-update-validation');
for (const directory of [profile, toolsDir, pythonDir]) fs.mkdirSync(directory, { recursive: true });
const settingsFile = path.join(profile, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({
    pythonMode: 'none', autoStart: false, migrationPrompted: true,
    globalHotkey: 'Ctrl+Alt+F11', pinHotkey: 'Ctrl+Alt+F10', superPanelHotkey: '',
    enableRightClickPanel: false, unrelatedPreference: '保留测试配置'
}));
const initialSettings = fs.readFileSync(settingsFile);
process.env.SANRENJZ_USER_DATA = profile;
process.env.SANRENJZ_ACCEPTANCE = '1';
app.setPath('userData', profile);
app.disableHardwareAcceleration();
app.setLoginItemSettings = () => {};
globalShortcut.register = () => true;
globalShortcut.unregister = () => {};
globalShortcut.unregisterAll = () => {};
globalShortcut.isRegistered = () => false;
class FixtureManager extends RealManager {
    constructor(window, options) { super(window, options); this.pluginDir = toolsDir; this.catalog = new PluginCatalog(toolsDir); }
}
class FixturePython extends pythonModule.PythonManager {
    constructor(options) { super({ ...options, pluginDir: pythonDir }); }
    async run() { throw new Error('禁止验收运行业务'); }
}
require.cache[require.resolve('../app/software_manager')].exports = FixtureManager;
require.cache[require.resolve('../app/python-manager')].exports = { ...pythonModule, PythonManager: FixturePython };

const fixture = Buffer.from('MZ' + 'isolated-install-package\n'.repeat(300));
const fixtureSha = crypto.createHash('sha256').update(fixture).digest('hex');
const currentVersion = require('../package.json').version;
app.getVersion = () => currentVersion;
// 新版验收使用高一补丁号的内存响应，避免项目版本升级后夹具变成“已是最新”。
const currentParts = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(currentVersion);
assert(currentParts, '当前项目版本必须为 SemVer');
const nextVersion = `${currentParts[1]}.${currentParts[2]}.${BigInt(currentParts[3]) + 1n}`;
let latestVersion = nextVersion;
let networkFailure = false;
let checkGate = false;
let downloadGate = false;
let corruptDownload = false;
let stallDownload = false;
const pendingChecks = [];
const pendingDownloads = [];
const requests = [];
const opened = [];
const report = { isolatedProfile: true, assertions: [], errors: [], networkIsMocked: true, installerIsMocked: true };
let quitCalls = 0;
let openFailure = '';
shell.openPath = async file => { opened.push({ type: 'path', file }); return openFailure; };
shell.showItemInFolder = file => { opened.push({ type: 'folder', file }); };
shell.openExternal = async url => { opened.push({ type: 'external', url }); };
app.quit = () => { quitCalls++; };

function release(version) {
    const name = `sanrenjz-${version}-win-x64.exe`;
    const prefix = `https://github.com/yuhanbo758/sanrenjz/releases/download/v${version}/`;
    return {
        id: 100, tag_name: `v${version}`, name: `三人聚智 ${version}`, draft: false, prerelease: false,
        html_url: `https://github.com/yuhanbo758/sanrenjz/releases/tag/v${version}`,
        assets: [
            { name, state: 'uploaded', size: fixture.length, digest: `sha256:${fixtureSha}`, browser_download_url: `${prefix}${name}` },
            { name: 'SHA256SUMS.txt', state: 'uploaded', size: 100, browser_download_url: `${prefix}SHA256SUMS.txt` }
        ]
    };
}

// 替换 Chromium 请求边界，真实主进程与 renderer 仍通过原 IPC 执行，所有响应仅来自内存。
net.request = options => {
    const url = typeof options === 'string' ? options : options.url;
    const request = new EventEmitter();
    const headers = {};
    let aborted = false;
    request.setHeader = (name, value) => { headers[name] = value; };
    request.getHeader = name => headers[name];
    request.removeHeader = name => { delete headers[name]; };
    request.write = () => {};
    request.followRedirect = () => {};
    request.abort = () => { aborted = true; request.emit('abort'); request.response?.destroy(); };
    request.end = () => {
        requests.push({ url, headers });
        const send = () => {
            if (aborted) return;
            if (url === 'https://api.github.com/repos/yuhanbo758/sanrenjz/releases/latest' && networkFailure) {
                const error = new Error('net::ERR_NAME_NOT_RESOLVED');
                error.code = 'ERR_NAME_NOT_RESOLVED';
                request.emit('error', error); return;
            }
            let body;
            let statusCode = 200;
            if (url === 'https://api.github.com/repos/yuhanbo758/sanrenjz/releases/latest') body = Buffer.from(JSON.stringify(release(latestVersion)));
            else if (/^https:\/\/github\.com\/yuhanbo758\/sanrenjz\/releases\/download\/v[^/]+\/SHA256SUMS\.txt$/.test(url)) body = Buffer.from(`${fixtureSha}  sanrenjz-${latestVersion}-win-x64.exe\n`);
            else if (/^https:\/\/github\.com\/yuhanbo758\/sanrenjz\/releases\/download\/v[^/]+\/sanrenjz-[^/]+-win-x64\.exe$/.test(url)) body = corruptDownload ? Buffer.from('bad-install') : fixture;
            else { statusCode = 404; body = Buffer.from('{}'); }
            const stalled = stallDownload && url.endsWith('.exe');
            const response = stalled ? new Readable({ read() {} }) : Readable.from([body]);
            request.response = response;
            response.statusCode = statusCode;
            response.headers = { 'content-length': String(body.length), 'content-type': url.endsWith('.exe') ? 'application/octet-stream' : 'application/json' };
            request.emit('response', response);
            if (stalled) response.push(body.subarray(0, 256));
        };
        if (url.endsWith('/releases/latest') && checkGate) pendingChecks.push(send);
        else if (url.endsWith('.exe') && downloadGate) pendingDownloads.push(send);
        else setImmediate(send);
    };
    return request;
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, label) => { assert(condition, label); report.assertions.push(label); };
async function until(callback, label) {
    for (let i = 0; i < 300; i++) { if (await callback()) return; await delay(20); }
    throw new Error(label || '等待更新界面超时');
}
process.on('unhandledRejection', error => report.errors.push(String(error)));
app.whenReady().then(() => {
    const block = target => target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    block(session.defaultSession);
    block(session.fromPartition('persist:sanrenjz-shop'));
});
const ready = new Promise(resolve => app.once('browser-window-created', (_event, window) => window.webContents.once('did-finish-load', () => resolve(window))));
require('../main');

(async () => {
    let extraWindow;
    try {
        const window = await ready;
        window.webContents.setBackgroundThrottling(false);
        const evaluate = source => window.webContents.executeJavaScript(source);
        const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click();true;`);
        const invoke = channel => evaluate(`require('electron').ipcRenderer.invoke(${JSON.stringify(channel)})`);
        await until(() => evaluate("Boolean(document.getElementById('update-check-btn') && typeof checkUpdate==='function')"));
        await delay(100);
        check(requests.filter(item => item.url.includes('/releases/')).length === 0, '启动不会检查或下载更新');
        check(opened.length === 0 && quitCalls === 0, '启动不执行安装或打开外部页面');

        checkGate = true;
        await evaluate('showUpdateModal(true);true;');
        await until(() => pendingChecks.length === 1, '检查请求未进入隔离门');
        check(await evaluate("document.getElementById('update-check-btn').disabled && document.getElementById('update-download-btn').disabled && document.getElementById('update-install-btn').disabled"), '检查期间锁定三个操作按钮');
        await click('update-check-btn');
        check(pendingChecks.length === 1, '检查中重复点击不会发送重复请求');
        checkGate = false; pendingChecks.shift()();
        await until(() => evaluate("!document.getElementById('update-check-btn').disabled && !document.getElementById('update-download-btn').disabled"), '新版本未解锁下载');
        check(await evaluate(`document.getElementById('update-message').textContent.includes(${JSON.stringify(nextVersion)})`), '正式 Release 新版显示在更新状态中');
        check(requests.every(item => !item.url.includes('sanrenjz-tools')), '检查更新不访问旧效率工具仓库');
        check(requests.every(item => !Object.keys(item.headers).some(name => name.toLowerCase() === 'authorization')), '公开更新请求不携带账号凭据');
        check(!requests.some(item => item.url.endsWith('.exe')), '发现新版不会自动下载');

        downloadGate = true;
        await click('update-download-btn');
        await until(() => pendingDownloads.length === 1, '下载请求未进入隔离门');
        check(await evaluate("document.getElementById('update-check-btn').disabled && document.getElementById('update-download-btn').disabled && document.getElementById('update-install-btn').disabled"), '下载中禁用重复下载及检查安装');
        await click('update-download-btn');
        check(pendingDownloads.length === 1, '下载按钮重复点击只保留一次下载');
        downloadGate = false; pendingDownloads.shift()();
        await until(() => evaluate("!document.getElementById('update-install-btn').disabled"), '下载校验后未解锁安装');
        check(opened.length === 0 && quitCalls === 0, '下载完成不会自动运行安装包');
        const installer = path.join(profile, 'updates', `sanrenjz-${nextVersion}-win-x64.exe`);
        check(fs.existsSync(installer) && fs.readFileSync(installer).equals(fixture), '校验后的下载内容与隔离安装包一致');
        check(!fs.readdirSync(path.dirname(installer)).some(name => name.endsWith('.part')), '下载完成不残留半成品');

        openFailure = '隔离安装打开失败';
        const failedInstall = await invoke('update:install');
        check(failedInstall.success === false && quitCalls === 0, '系统无法打开安装包时保留主程序并返回失败');
        openFailure = '';
        fs.appendFileSync(installer, 'tampered');
        const tampered = await invoke('update:install');
        check(tampered.success === false && quitCalls === 0 && opened.length === 1, '安装前再次校验并拒绝被修改的安装包');

        latestVersion = currentVersion;
        await click('update-check-btn');
        await until(() => evaluate("!document.getElementById('update-check-btn').disabled"));
        check(await evaluate("document.getElementById('update-message').textContent.includes('最新') && document.getElementById('update-download-btn').disabled"), '当前正式版本不会被识别为更新');
        networkFailure = true;
        await click('update-check-btn');
        await until(() => evaluate("!document.getElementById('update-check-btn').disabled"));
        check(await evaluate("!document.getElementById('update-message').textContent.includes('Error invoking remote method') && !document.getElementById('update-message').textContent.includes('合并预览版')"), '网络失败提示不显示 Electron IPC 包装或旧预览错误');
        check(await evaluate("document.getElementById('update-download-btn').disabled && document.getElementById('update-install-btn').disabled"), '检查失败不保留旧下载或安装按钮');

        networkFailure = false; latestVersion = nextVersion;
        await click('update-check-btn');
        await until(() => evaluate("!document.getElementById('update-download-btn').disabled"));
        stallDownload = true;
        await click('update-download-btn');
        await until(() => fs.readdirSync(path.dirname(installer)).some(name => name.endsWith('.part')), '隔离下载未开始写入半成品');
        check(await evaluate("!document.getElementById('update-cancel-btn').hidden"), '下载时显示取消入口');
        await click('update-cancel-btn');
        await until(() => evaluate("!document.getElementById('update-check-btn').disabled"));
        check(!fs.readdirSync(path.dirname(installer)).some(name => name.endsWith('.part')), '取消下载会清理本次半成品');
        check(await evaluate("document.getElementById('update-cancel-btn').hidden && document.getElementById('update-install-btn').disabled && !document.getElementById('update-download-btn').disabled"), '取消后恢复操作且可重试下载');
        stallDownload = false;
        corruptDownload = true;
        await click('update-download-btn');
        await until(() => evaluate("!document.getElementById('update-check-btn').disabled"));
        check(await evaluate("document.getElementById('update-install-btn').disabled"), '下载字节或哈希错误时不会开放安装');
        corruptDownload = false;
        await click('update-download-btn');
        await until(() => evaluate("!document.getElementById('update-install-btn').disabled"));
        check(true, '失败后可重新检查并下载成功');

        extraWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
        await extraWindow.loadURL('data:text/html,<p>isolated unauthorized sender</p>');
        const unauthorized = await extraWindow.webContents.executeJavaScript("Promise.all(['update:check','update:download','update:install','update:cancel','update:open-release'].map(channel=>require('electron').ipcRenderer.invoke(channel).then(value=>value?.success===false,()=>true)))");
        check(unauthorized.every(Boolean), '非主窗口无法检查下载或执行更新安装');

        await click('update-release-btn');
        await until(() => opened.some(item => item.type === 'external'));
        check(opened.find(item => item.type === 'external').url === 'https://github.com/yuhanbo758/sanrenjz/releases/latest', '发布页面入口只打开当前合并应用的正式 Release');

        const installed = await invoke('update:install');
        check(installed.success === true && quitCalls === 1 && opened.filter(item => item.type === 'path').length === 2, '用户明确安装后才打开已验证安装包并退出');
        check(fs.readFileSync(settingsFile).equals(initialSettings), '整个更新流程保持已有应用设置原字节不变');
        check(report.errors.length === 0, '更新真实 IPC 和界面无未处理异常');
        report.success = true;
    } catch (error) {
        report.success = false;
        report.errors.push(error.stack || String(error));
    } finally {
        if (extraWindow && !extraWindow.isDestroyed()) extraWindow.destroy();
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'electron-report.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        app.isQuiting = true;
        app.exit(report.success ? 0 : 1);
    }
})();
setTimeout(() => { console.error('更新集成验收超时'); app.exit(2); }, 60000).unref();
