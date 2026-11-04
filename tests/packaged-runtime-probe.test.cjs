'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parseOptions, locatePackage, isolatedEnvironment, inside, stopOwnedProcess, runSmoke } = require('../scripts/test-packaged-runtime.cjs');

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
