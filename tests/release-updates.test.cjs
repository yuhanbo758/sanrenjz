'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { ReleaseUpdates, API_URL, installerName, newerThanStable, parseVersion } = require('../app/release-updates');
const bytes = Buffer.from('MZ synthetic installer, never execute');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function release(version = '0.1.8', platform = 'win32', arch = 'x64') {
    const name = installerName(version, platform, arch);
    return { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://github.com/yuhanbo758/sanrenjz/releases/tag/v${version}`, assets: [{ name, size: bytes.length, state: 'uploaded', digest: `sha256:${sha(bytes)}`, browser_download_url: `https://github.com/yuhanbo758/sanrenjz/releases/download/v${version}/${name}` }] };
}
function fixture(t, payload = release(), options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-update-unit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const events = [], requests = [], routes = new Map();
    routes.set(API_URL, { body: Buffer.from(JSON.stringify(payload)) });
    for (const asset of payload.assets || []) routes.set(asset.browser_download_url, { body: bytes });
    const request = config => {
        const req = new EventEmitter();
        req.headers = {}; req.setHeader = (key, value) => { req.headers[key] = value; };
        req.abort = () => { req.aborted = true; req.emit('abort'); };
        req.end = () => queueMicrotask(() => {
            const route = routes.get(config.url);
            if (route?.stall) return;
            if (route?.error) { req.emit('error', route.error); return; }
            if (route?.redirect) { req.emit('redirect', 302, 'GET', route.redirect, {}); return; }
            const response = Readable.from(route?.chunks || [route?.body || Buffer.alloc(0)]);
            response.statusCode = route?.status || 200; response.headers = route?.headers || {};
            req.emit('response', response);
        });
        requests.push({ config, req }); return req;
    };
    const manager = new ReleaseUpdates({ currentVersion: '0.1.7', platform: 'win32', arch: 'x64', updatesDir: path.join(root, 'updates'), request, emit: event => events.push(event), ...options });
    return { root, manager, routes, events, requests };
}

test('严格版本比较，不降级，不将先行版本当正式版', () => {
    assert(newerThanStable('0.1.8', '0.1.7'));
    assert(newerThanStable('0.1.7', '0.1.7-preview.2'));
    assert(!newerThanStable('0.1.7', '0.1.7'));
    assert(!newerThanStable('0.1.7', '0.1.8-preview.1'));
    assert(!newerThanStable('9.0.0', '10.0.0'));
    for (const value of ['01.1.0', '1.1.0\n', '1.1.0+build', '1.1.0-preview.01', '../1.1.0']) assert.throws(() => parseVersion(value));
    assert.throws(() => parseVersion('0.1.8-preview.1', true));
});

test('只读官方 Latest；同版本不下载、不创建更新目录', async t => {
    const f = fixture(t, release('0.1.7'));
    const result = await f.manager.check();
    assert.equal(result.available, false);
    assert.equal(f.events.at(-1).type, 'not-available');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].config.url, API_URL);
    assert.equal(f.requests[0].config.credentials, 'omit');
    assert.equal(f.requests[0].config.useSessionCookies, false);
    assert.equal(f.requests[0].req.headers.Authorization, undefined);
    assert(!fs.existsSync(f.manager.updatesDir));
    await assert.rejects(f.manager.download(), /先检查/);
});

test('四个平台精确选择原生包名，不接受其他架构', async t => {
    for (const [platform, arch, ending] of [['win32', 'x64', 'win-x64.exe'], ['darwin', 'x64', 'mac-x64.dmg'], ['darwin', 'arm64', 'mac-arm64.dmg'], ['linux', 'x64', 'linux-x64.AppImage']]) {
        const f = fixture(t, release('0.1.8', platform, arch), { platform, arch });
        assert((await f.manager.check()).updateInfo.assetName.endsWith(ending));
        assert.equal(f.requests.length, 1);
    }
    const unsupported = fixture(t, release(), { platform: 'win32', arch: 'arm64' });
    await assert.rejects(unsupported.manager.check(), /架构/);
});

test('拒绝预览、草稿、旧仓库、同名重复及非官方下载地址', async t => {
    const mutations = [
        r => { r.prerelease = true; }, r => { r.draft = true; },
        r => { r.tag_name = 'v0.1.8-preview.1'; },
        r => { r.html_url = r.html_url.replace('/sanrenjz/', '/sanrenjz-tools/'); },
        r => { r.assets.push({ ...r.assets[0] }); },
        r => { r.assets[0].name = 'sanrenjz-0.1.8-win-arm64.exe'; },
        r => { r.assets[0].browser_download_url = 'https://example.invalid/update.exe'; },
        r => { r.assets[0].browser_download_url += '?token=untrusted'; },
        r => { r.assets[0].size = -1; }, r => { r.assets[0].digest = 'md5:untrusted'; }
    ];
    for (const mutate of mutations) {
        const payload = release(); mutate(payload);
        const f = fixture(t, payload);
        await assert.rejects(f.manager.check());
        assert.equal(f.manager.candidate, null);
        assert.equal(f.requests.length, 1);
    }
});

test('无 API digest 时读取同一 Release 的唯一 SHA256 记录', async t => {
    const payload = release(); delete payload.assets[0].digest;
    const sums = { name: 'SHA256SUMS.txt', state: 'uploaded', browser_download_url: 'https://github.com/yuhanbo758/sanrenjz/releases/download/v0.1.8/SHA256SUMS.txt' };
    payload.assets.push(sums);
    const f = fixture(t, payload);
    f.routes.set(sums.browser_download_url, { body: Buffer.from(`${sha(bytes)}  ${payload.assets[0].name}\n`) });
    assert.equal((await f.manager.check()).available, true);
    assert.equal(f.manager.candidate.sha256, sha(bytes));
    const duplicate = fixture(t, payload);
    duplicate.routes.set(sums.browser_download_url, { body: Buffer.from(`${sha(bytes)}  ${payload.assets[0].name}\n`.repeat(2)) });
    await assert.rejects(duplicate.manager.check(), /重复/);
});

test('流式下载经大小及 SHA256 核验才成为可安装文件；不执行安装', async t => {
    const f = fixture(t);
    await f.manager.check();
    const result = await f.manager.download();
    assert.equal(result.success, true);
    assert.equal(result.installAction, 'install');
    assert.deepEqual(fs.readFileSync(result.path), bytes);
    assert.equal(f.events.at(-1).type, 'downloaded');
    assert.equal(f.events.at(-1).installAction, 'install');
    assert.equal(fs.readdirSync(f.manager.updatesDir).length, 1);
    assert.equal((await f.manager.verifyDownloaded()).path, result.path);
    fs.writeFileSync(result.path, Buffer.alloc(bytes.length, 1));
    await assert.rejects(f.manager.verifyDownloaded(), /SHA256/);
    assert.equal(f.manager.downloaded, null);
});

test('Mac下载完成只允许用户主动安装并重启，安装前传递复核所需的大小和SHA256', async t => {
    const f = fixture(t, release('0.1.8', 'darwin', 'arm64'), { platform: 'darwin', arch: 'arm64' });
    assert.equal((await f.manager.check()).updateInfo.installAction, 'install-macos');
    const downloaded = await f.manager.download();
    assert.equal(downloaded.installAction, 'install-macos');
    assert.match(f.events.at(-1).message, /安装并重启/);
    const verified = await f.manager.verifyDownloaded();
    assert.equal(verified.bytes, bytes.length);
    assert.equal(verified.sha256, sha(bytes));
    assert.equal(verified.arch, 'arm64');
});

test('损坏与截断下载不覆盖已有文件，不留下 part 或可安装状态', async t => {
    for (const body of [Buffer.alloc(bytes.length, 3), bytes.subarray(0, 5), Buffer.concat([bytes, bytes])]) {
        const f = fixture(t); await f.manager.check();
        fs.mkdirSync(f.manager.updatesDir);
        const finalPath = path.join(f.manager.updatesDir, f.manager.candidate.assetName);
        fs.writeFileSync(finalPath, 'old file');
        f.routes.set(f.manager.candidate.url, { body });
        await assert.rejects(f.manager.download(), /SHA256|大小/);
        assert.equal(fs.readFileSync(finalPath, 'utf8'), 'old file');
        assert.equal(fs.readdirSync(f.manager.updatesDir).length, 1);
        assert.equal(f.manager.downloaded, null);
    }
});

test('官方 CDN 重定向有限跟随，不携带认证头；拒绝外部和 HTTP 地址', async t => {
    const f = fixture(t); await f.manager.check();
    const cdn = 'https://release-assets.githubusercontent.com/fixture/installer?example=fixture';
    f.routes.set(f.manager.candidate.url, { redirect: cdn }); f.routes.set(cdn, { body: bytes });
    assert.equal((await f.manager.download()).success, true);
    assert(f.requests.every(r => !r.req.headers.Authorization));
    for (const redirect of ['http://github.com/file', 'https://evil.invalid/file', 'https://github.com@evil.invalid/file', 'https://github.com:8443/file']) {
        const rejected = fixture(t); await rejected.manager.check();
        rejected.routes.set(rejected.manager.candidate.url, { redirect });
        await assert.rejects(rejected.manager.download(), /非官方/);
        assert.equal(rejected.requests.length, 2);
    }
    const loop = fixture(t); await loop.manager.check();
    loop.routes.set(loop.manager.candidate.url, { redirect: loop.manager.candidate.url });
    await assert.rejects(loop.manager.download(), /次数/);
    assert.equal(loop.requests.length, 7);
});

test('取消、超时、DNS 与限流返回中文安全错误并可重试', async t => {
    const f = fixture(t, release(), { timeoutMs: 30 });
    f.routes.set(API_URL, { stall: true });
    await assert.rejects(f.manager.check(), /超时|最长/);
    assert.equal(f.manager.busy, false);
    f.routes.set(API_URL, { error: Object.assign(new Error('sensitive request details'), { code: 'ENOTFOUND' }) });
    await assert.rejects(f.manager.check(), /解析 GitHub/);
    f.routes.set(API_URL, { status: 403 });
    await assert.rejects(f.manager.check(), /频率/);
    f.routes.set(API_URL, { body: Buffer.from(JSON.stringify(release())) });
    await f.manager.check();
    f.routes.set(f.manager.candidate.url, { stall: true });
    const download = f.manager.download();
    await new Promise(resolve => setImmediate(resolve));
    f.manager.cancel();
    await assert.rejects(download, /取消/);
    assert.equal(f.events.at(-1).type, 'cancelled');
    assert.equal(f.manager.busy, false);
    assert.equal(fs.readdirSync(f.manager.updatesDir).length, 0);
    f.routes.set(f.manager.candidate.url, { body: bytes });
    assert.equal((await f.manager.download()).success, true);
});

test('重新检查失败后清除旧候选及已下载状态，界面通知异常不破坏清理', async t => {
    const f = fixture(t, release(), { emit() { throw new Error('window closed'); } });
    await f.manager.check(); await f.manager.download();
    f.routes.set(API_URL, { body: Buffer.from('invalid response') });
    await assert.rejects(f.manager.check(), /无效版本/);
    assert.equal(f.manager.candidate, null); assert.equal(f.manager.downloaded, null);
    await assert.rejects(f.manager.verifyDownloaded(), /尚未下载/);
});

test('文件系统错误不显示系统路径或覆盖目录外原文件', async t => {
    const f = fixture(t);
    const original = path.join(f.root, 'original-file');
    fs.writeFileSync(original, 'preserve original');
    f.manager.updatesDir = path.join(original, 'updates');
    await f.manager.check();
    await assert.rejects(f.manager.download(), error => /更新文件或目录/.test(error.message) && !error.message.includes(f.root));
    assert.equal(fs.readFileSync(original, 'utf8'), 'preserve original');
    assert.equal(f.manager.downloaded, null);
    assert(!f.events.at(-1).message.includes(f.root));
});

test('下载网络完成后的校验阶段仍可取消，不能替换原文件或成为可安装状态', async t => {
    const f = fixture(t);
    await f.manager.check();
    fs.mkdirSync(f.manager.updatesDir);
    const finalPath = path.join(f.manager.updatesDir, f.manager.candidate.assetName);
    fs.writeFileSync(finalPath, 'preserve prior installer');
    const verifyFile = f.manager.verifyFile.bind(f.manager);
    let enterVerification, finishVerification;
    const entered = new Promise(resolve => { enterVerification = resolve; });
    const released = new Promise(resolve => { finishVerification = resolve; });
    f.manager.verifyFile = async (...args) => {
        await verifyFile(...args);
        enterVerification();
        await released;
    };
    const download = f.manager.download();
    await entered;
    assert.equal(f.manager.cancelRequest, null);
    assert.equal(f.manager.busy, true);
    f.manager.cancel();
    finishVerification();
    await assert.rejects(download, /取消/);
    assert.equal(f.events.at(-1).type, 'cancelled');
    assert.equal(f.manager.downloaded, null);
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'preserve prior installer');
    assert.equal(fs.readdirSync(f.manager.updatesDir).length, 1);
    assert(!f.events.some(event => event.type === 'downloaded'));
    await assert.rejects(f.manager.verifyDownloaded(), /尚未下载/);
    f.manager.verifyFile = verifyFile;
    assert.equal((await f.manager.download()).success, true);
    assert.deepEqual(fs.readFileSync(finalPath), bytes);
});
