'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { parseOptions, locatePackage, isolatedEnvironment, inside, stopOwnedProcess, runSmoke, runtimeArguments, sanitizeSystemLine, createSystemDiagnostics, connectCdp } = require('../scripts/test-packaged-runtime.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-smoke-test-'));
    fs.mkdirSync(path.join(root, 'dist'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    return root;
}

test('仅接受四个平台架构组合，拒绝重复、缺失和未知参数', () => {
    for (const [platform, arch] of [['win', 'x64'], ['mac', 'x64'], ['mac', 'arm64'], ['linux', 'x64']]) {
        assert.deepEqual(parseOptions(['--platform', platform, '--arch', arch]), { platform, arch });
    }
    for (const args of [[], ['--platform', 'win'], ['--platform', 'win', '--arch', 'arm64'], ['--platform', 'linux', '--arch', 'x64', '--file', 'other'], ['--platform', 'mac', '--arch', 'x64', '--arch', 'arm64']]) assert.throws(() => parseOptions(args));
});

test('包定位要求唯一公开构建和有效程序，不能选择个人包或旧包', t => {
    const root = fixture(t);
    const pkg = { name: 'sanrenjz', build: { productName: '三人聚智' } };
    const target = path.join(root, 'dist/public-package-1-2/win-unpacked');
    fs.mkdirSync(path.join(target, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(target, '三人聚智.exe'), 'MZ');
    fs.writeFileSync(path.join(target, 'resources/app.asar'), 'archive');
    assert.equal(locatePackage(root, { platform: 'win', arch: 'x64' }, pkg).binary, path.join(target, '三人聚智.exe'));
    fs.mkdirSync(path.join(root, 'dist/public-package-3-4'));
    assert.throws(() => locatePackage(root, { platform: 'win', arch: 'x64' }, pkg), { code: 'AMBIGUOUS_PACKAGE' });
    fs.rmSync(path.join(root, 'dist/public-package-3-4'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist/personal-stage-5-6'));
    assert.throws(() => locatePackage(root, { platform: 'win', arch: 'x64' }, pkg), { code: 'PERSONAL_PACKAGE_PRESENT' });
});

test('环境隔离覆盖旧用户目录与Node模式，非Windows真实使用用户数据安装根', () => {
    const base = { ELECTRON_RUN_AS_NODE: '1', SANRENJZ_REMOTE_ACCEPTANCE: '1', SANRENJZ_USER_DATA: 'old', PORTABLE_EXECUTABLE_DIR: 'old-portable', KEEP_VALUE: 'keep' };
    const args = { profile: 'isolated-profile', pluginRoot: 'isolated-root' };
    const win = isolatedEnvironment(base, { ...args, platform: 'win' });
    assert.equal(win.PORTABLE_EXECUTABLE_DIR, args.pluginRoot);
    for (const platform of ['mac', 'linux']) assert.equal(isolatedEnvironment(base, { ...args, platform }).PORTABLE_EXECUTABLE_DIR, undefined);
    assert.equal(win.SANRENJZ_USER_DATA, args.profile);
    assert.equal(win.SANRENJZ_ACCEPTANCE, '1');
    assert.equal(win.SANRENJZ_PYTHON_LIVE, '0');
    assert.equal(win.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(win.SANRENJZ_REMOTE_ACCEPTANCE, undefined);
    assert.equal(base.SANRENJZ_USER_DATA, 'old');
});

test('插件路径必须在隔离目录内，邻接目录和父目录均拒绝', () => {
    const root = path.resolve('isolation');
    assert.equal(inside(root, path.join(root, 'plugins/tool')), true);
    assert.equal(inside(root, root), false);
    assert.equal(inside(root, path.resolve('isolation-other/plugins')), false);
    assert.equal(inside(root, path.dirname(root)), false);
});

test('超时清理只终止本次拥有的子进程', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { windowsHide: true, detached: process.platform !== 'win32', stdio: 'ignore' });
    const closed = new Promise(resolve => child.once('close', resolve));
    await stopOwnedProcess(child, closed);
    assert.ok(child.exitCode !== null || child.signalCode);
});

test('失败报告不包含本地路径或原始程序输出，平台不符时不启动程序', async t => {
    const root = fixture(t);
    const platform = process.platform === 'win32' ? 'linux' : 'win';
    const report = await runSmoke({ root, platform, arch: 'x64' });
    assert.equal(report.success, false);
    assert.deepEqual(report.errors, [{ stage: 'preflight', code: 'NATIVE_RUNNER_REQUIRED' }]);
    const serialized = fs.readFileSync(path.join(root, 'dist', `packaged-runtime-${platform}-x64.json`), 'utf8');
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(os.homedir()), false);
});

test('只有Linux隔离验收使用共享内存规避和无沙盒参数', () => {
    assert.ok(runtimeArguments('linux').includes('--disable-dev-shm-usage'));
    assert.ok(runtimeArguments('linux').includes('--no-sandbox'));
    for (const platform of ['win', 'mac']) {
        assert.equal(runtimeArguments(platform).includes('--disable-dev-shm-usage'), false);
        assert.equal(runtimeArguments(platform).includes('--no-sandbox'), false);
    }
});

test('系统诊断逐行解码、过滤和限长，凭据与本机路径不输出', () => {
    const directory = path.join(os.tmpdir(), 'private-diagnostic-location');
    const value = ['fixture', 'credential', 'content'].join('-');
    const collector = createSystemDiagnostics([directory]);
    const line = `[FATAL] 共享内存 ${directory}/config error api_` + `key=${value} from person@example.invalid\n`;
    const bytes = Buffer.from(line);
    for (let offset = 0; offset < bytes.length; offset += 7) collector.write(bytes.subarray(offset, offset + 7));
    collector.write(Buffer.from('routine user configuration is omitted\n'));
    collector.end();
    const result = collector.lines().join('\n');
    assert.ok(result.includes('共享内存') && result.includes('[REDACTED]'));
    assert.equal(result.includes(value), false);
    assert.equal(result.includes(directory), false);
    assert.equal(result.includes('person@example.invalid'), false);
    assert.equal(result.includes('\uFFFD'), false);
    assert.equal(collector.lines().length, 1);
    const authorization = sanitizeSystemLine('[ERROR] Authorization: Bearer ' + value);
    assert.equal(authorization.includes(value), false);
    const memory = sanitizeSystemLine('[ERROR] shared memory mmap /dev/shm/fixture failed');
    assert.ok(memory.includes('[system-shm]'));
    assert.equal(sanitizeSystemLine('[ERROR] file:///home/private-user/config.json').includes('private-user'), false);
});

test('系统诊断容量有界，超长未完成行整行丢弃', () => {
    const collector = createSystemDiagnostics();
    collector.write(Buffer.from('[ERROR] ' + 'x'.repeat(17000)));
    collector.write(Buffer.from(' [ERROR] must-not-be-a-separate-line\n'));
    for (let index = 0; index < 30; index++) collector.write(Buffer.from(`[ERROR] system line ${index} ${'x'.repeat(900)}\n`));
    collector.end();
    assert.equal(collector.lines().some(line => line.includes('must-not-be')), false);
    assert.ok(collector.lines().length <= 8);
    assert.ok(collector.lines().join('\n').length <= 5000);
    assert.ok(collector.lines().every(line => line.length <= 700));
});

test('CDP进程断连立即拒绝待处理请求，不能被误报为15秒超时', { timeout: 4000 }, async () => {
    const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
    await new Promise(resolve => server.once('listening', resolve));
    server.on('connection', socket => socket.once('message', () => socket.close()));
    const cdp = connectCdp(`ws://127.0.0.1:${server.address().port}`);
    try {
        await cdp.opened;
        const started = Date.now();
        await assert.rejects(cdp.evaluate('true'), { code: 'CDP_DISCONNECTED' });
        assert.ok(Date.now() - started < 1500);
    } finally {
        cdp.close();
        for (const client of server.clients) client.terminate();
        await new Promise(resolve => server.close(resolve));
    }
});
