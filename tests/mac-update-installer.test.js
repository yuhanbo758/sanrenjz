'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { MacUpdateInstaller } = require('../app/mac-update-installer');
const { checkedJob, atomicJSON, checkBundle, samePublisher, replaceAndRestart, runCommand, BUNDLE_ID } = require('../app/mac-update-worker');

function fixture(t) {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'sanrenjz-mac-install-'));
    t.after(async () => {
        assert.equal(path.dirname(root), parent);
        assert(!fs.lstatSync(root).isSymbolicLink());
        if (process.platform === 'darwin') {
            const mounts = await runCommand('/sbin/mount', [], { timeout: 10000 });
            if (mounts.stdout.includes(root)) throw new Error('测试镜像仍挂载，保留临时目录，禁止删除');
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const installed = path.join(root, '三人聚智.app'), updatesDir = path.join(root, 'updates');
    const imageRoot = path.join(root, 'image');
    fs.mkdirSync(updatesDir); fs.mkdirSync(imageRoot);
    function bundle(directory, version) {
        fs.mkdirSync(path.join(directory, 'Contents', 'MacOS'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'version.txt'), version);
        fs.writeFileSync(path.join(directory, 'Contents', 'MacOS', 'fixture'), 'fixture executable');
        return directory;
    }
    bundle(installed, '0.1.11');
    const incoming = bundle(path.join(imageRoot, '三人聚智.app'), '0.1.12');
    const image = path.join(updatesDir, 'update.dmg'); fs.writeFileSync(image, 'verified disk image fixture');
    const downloaded = { path: image, version: '0.1.12', arch: 'x64', bytes: fs.statSync(image).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex') };
    const calls = []; let mountPoint;
    const run = async (file, args) => {
        calls.push([file, args]);
        if (file.endsWith('hdiutil') && args[0] === 'attach') {
            const mount = args[args.indexOf('-mountpoint') + 1];
            mountPoint = mount;
            fs.cpSync(imageRoot, mount, { recursive: true, filter: () => true });
            return { stdout: JSON.stringify({ 'system-entities': [{ 'dev-entry': '/dev/disk99s1', 'mount-point': mount }] }), stderr: '' };
        }
        if (file.endsWith('plutil')) return { stdout: JSON.stringify({ 'system-entities': [{ 'dev-entry': '/dev/disk99s1', 'mount-point': mountPoint }] }), stderr: '' };
        if (file.endsWith('ditto')) fs.cpSync(args[0], args[1], { recursive: true, filter: () => true });
        return { stdout: '', stderr: '' };
    };
    const validate = async (directory, expected) => {
        assert.equal(fs.readFileSync(path.join(directory, 'version.txt'), 'utf8'), expected.version);
        return { team: 'not set' };
    };
    const installer = new MacUpdateInstaller({ updatesDir, executable: path.join(installed, 'Contents', 'MacOS', 'fixture'), version: '0.1.11', arch: 'x64', platform: 'darwin', run, validate });
    let job;
    installer.launch = async file => { job = checkedJob(file); };
    return { root, installed, incoming, updatesDir, imageRoot, downloaded, installer, calls, run, validate, bundle, get job() { return job; } };
}

test('准备阶段仅暂存应用，核验并卸载镜像后才启动助手，旧程序不变', async t => {
    const f = fixture(t);
    assert.equal((await f.installer.start(f.downloaded)).success, true);
    assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.11');
    assert.equal(fs.readFileSync(path.join(f.job.replacement, 'version.txt'), 'utf8'), '0.1.12');
    const attachment = f.calls.find(([file, args]) => file.endsWith('hdiutil') && args[0] === 'attach')[1];
    for (const argument of ['-readonly', '-nobrowse', '-noautoopen']) assert(attachment.includes(argument));
    assert.deepEqual(f.calls.at(-1), ['/usr/bin/hdiutil', ['detach', '/dev/disk99s1']]);
    assert.equal(fs.existsSync(f.job.backup), false);
    await assert.rejects(f.installer.start(f.downloaded), /正在准备/);
});

test('哈希篡改、无效安装位置不退出应用，也不挂载镜像', async t => {
    const f = fixture(t);
    fs.appendFileSync(f.downloaded.path, 'tampered');
    await assert.rejects(f.installer.start(f.downloaded), /重新下载/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.installer.busy, false);
    assert(fs.existsSync(f.installed));
    f.installer.executable = '/Volumes/Disk/三人聚智.app/Contents/MacOS/fixture';
    assert.throws(() => f.installer.targetApp(), /请先把应用安装/);
    f.installer.executable = path.join(f.root, 'electron.exe');
    assert.throws(() => f.installer.targetApp(), /请先把应用安装/);
});

test('发布者变化、复制失败与镜像卸载失败保留旧版并拒绝开始替换', async t => {
    for (const failure of ['publisher', 'copy', 'detach']) {
        const f = fixture(t);
        if (failure === 'publisher') f.installer.validate = async (file, expected) => { await f.validate(file, expected); return { team: file === f.installed ? 'TEAM-A' : 'TEAM-B' }; };
        f.installer.run = async (file, args, options) => {
            if (failure === 'copy' && file.endsWith('ditto')) throw new Error('copy failed');
            if (failure === 'detach' && file.endsWith('hdiutil') && args[0] === 'detach') throw Object.assign(new Error('detach failed'), { code: 1 });
            return f.run(file, args, options);
        };
        await assert.rejects(f.installer.start(f.downloaded));
        assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.11');
        assert.equal(f.installer.busy, false);
        assert.equal(f.job, undefined);
    }
});

test('只对本次镜像的退出码16且Resource busy有限重试', async t => {
    const f = fixture(t); let attempts = 0;
    f.installer.run = async (file, args) => {
        assert.equal(file, '/usr/bin/hdiutil'); assert.deepEqual(args, ['detach', '/dev/disk99s1']);
        attempts++; if (attempts < 3) throw Object.assign(new Error('busy'), { code: 16, stderr: 'Resource busy' });
    };
    await f.installer.detach('/dev/disk99s1'); assert.equal(attempts, 3);
    attempts = 0;
    f.installer.run = async () => { attempts++; throw Object.assign(new Error('other failure'), { code: 16, stderr: 'different error' }); };
    await assert.rejects(f.installer.detach('/dev/disk99s1')); assert.equal(attempts, 1);
});

test('实际文件系统事务替换、启动确认及旧版本备份，设置数据保持原字节', async t => {
    const f = fixture(t); await f.installer.start(f.downloaded);
    const data = path.join(f.updatesDir, 'settings-fixture.json'); fs.writeFileSync(data, '{"keep":true}');
    const opens = [];
    await replaceAndRestart(f.job, { validate: f.validate, run: async (_file, args) => { assert.equal(args[0], '-n'); opens.push(args.at(-1)); }, waitForStartup: async () => {
        const updated = new MacUpdateInstaller({ updatesDir: f.updatesDir, executable: f.installer.executable, version: '0.1.12', arch: 'x64', platform: 'darwin' });
        assert.equal(updated.acknowledgeStartup(), true);
        return true;
    } });
    assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.12');
    assert.equal(fs.readFileSync(path.join(f.job.backup, 'version.txt'), 'utf8'), '0.1.11');
    assert.equal(JSON.parse(fs.readFileSync(f.job.status)).state, 'success');
    assert.equal(fs.readFileSync(data, 'utf8'), '{"keep":true}');
    assert.deepEqual(opens, [f.installed]);
});

test('新应用无法启动时原路径回滚，失败的新应用保留且重新打开旧版', async t => {
    const f = fixture(t); await f.installer.start(f.downloaded); let opens = 0;
    await assert.rejects(replaceAndRestart(f.job, { validate: f.validate, run: async () => { if (++opens === 1) throw new Error('open failed'); }, waitForStartup: async () => true }), /open failed/);
    assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.11');
    assert.equal(fs.readFileSync(path.join(f.job.failed, 'version.txt'), 'utf8'), '0.1.12');
    assert.equal(JSON.parse(fs.readFileSync(f.job.status)).state, 'rolled-back');
    assert.equal(opens, 2);
});

test('第二次重命名失败时恢复旧应用，而不是留下空安装位置', async t => {
    const f = fixture(t); await f.installer.start(f.downloaded);
    const validate = async (file, expected) => {
        const result = await f.validate(file, expected);
        if (file === f.job.replacement) fs.rmSync(file, { recursive: true });
        return result;
    };
    await assert.rejects(replaceAndRestart(f.job, { validate, run: async () => {} }));
    assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.11');
    assert.equal(JSON.parse(fs.readFileSync(f.job.status)).state, 'rolled-back');
});

test('助手握手成功才允许退出，助手启动失败保留原安装', async t => {
    const f = fixture(t); await f.installer.start(f.downloaded);
    f.installer.watch = () => {};
    let unreferenced = false;
    f.installer.spawnWorker = (_file, args, options) => {
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(options.env.NODE_OPTIONS, undefined);
        const child = new EventEmitter(); child.pid = 12345; child.exitCode = null;
        child.unref = () => { unreferenced = true; }; child.kill = () => {};
        queueMicrotask(() => atomicJSON(f.job.ready, { token: f.job.token, workerPid: child.pid }));
        assert.equal(args[1], path.join(f.job.directory, 'job.json'));
        return child;
    };
    await MacUpdateInstaller.prototype.launch.call(f.installer, path.join(f.job.directory, 'job.json'));
    assert(unreferenced);
    fs.unlinkSync(f.job.ready);
    f.installer.spawnWorker = () => { const child = new EventEmitter(); child.exitCode = 1; child.kill = () => {}; return child; };
    await assert.rejects(MacUpdateInstaller.prototype.launch.call(f.installer, path.join(f.job.directory, 'job.json')), /未能启动/);
    f.installer.spawnWorker = () => { const child = new EventEmitter(); child.exitCode = null; child.signalCode = 'SIGSEGV'; child.kill = () => {}; return child; };
    await assert.rejects(MacUpdateInstaller.prototype.launch.call(f.installer, path.join(f.job.directory, 'job.json')), /未能启动/);
    assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.11');
});

test('open仅接受启动但没有新宿主确认时保留备份并明确未确认状态', async t => {
    const f = fixture(t); await f.installer.start(f.downloaded);
    assert.equal(await replaceAndRestart(f.job, { validate: f.validate, run: async () => {}, waitForStartup: async () => false }), false);
    assert.equal(JSON.parse(fs.readFileSync(f.job.status)).state, 'startup-unconfirmed');
    assert(fs.existsSync(f.job.backup));
    const wrongVersion = new MacUpdateInstaller({ updatesDir: f.updatesDir, executable: f.installer.executable, version: '0.1.11', arch: 'x64', platform: 'darwin' });
    assert.equal(wrongVersion.acknowledgeStartup(), false);
});

test('任务路径、发布者和恢复材料冲突必须拒绝，不覆盖既有目录', async t => {
    const f = fixture(t); await f.installer.start(f.downloaded);
    assert.throws(() => samePublisher({ team: 'TEAM-A' }, { team: 'not set' }), /发布者/);
    fs.mkdirSync(f.job.backup);
    await assert.rejects(replaceAndRestart(f.job, { validate: f.validate }), /停止覆盖/);
    const original = JSON.parse(fs.readFileSync(path.join(f.job.directory, 'job.json')));
    atomicJSON(path.join(f.job.directory, 'job.json'), { ...original, targetApp: path.join(f.root, '..', 'other.app') });
    assert.throws(() => checkedJob(path.join(f.job.directory, 'job.json')), /路径或内容无效/);
    assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.11');
});

test('原生应用验证核对身份、版本、架构及签名，拒绝越界链接', async t => {
    const f = fixture(t);
    let info = { CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: '0.1.11', CFBundleExecutable: 'fixture' }, arch = 'x86_64', validSignature = true;
    const run = async (file, args) => {
        if (file.endsWith('plutil')) return { stdout: JSON.stringify(info), stderr: '' };
        if (file.endsWith('lipo')) return { stdout: arch, stderr: '' };
        if (args[0] === '--verify' && !validSignature) throw new Error('invalid signature');
        return { stdout: '', stderr: `Identifier=${BUNDLE_ID}\nTeamIdentifier=not set\n` };
    };
    assert.equal((await checkBundle(f.installed, { version: '0.1.11', arch: 'x64' }, run)).team, 'not set');
    info.CFBundleIdentifier = 'other.app'; await assert.rejects(checkBundle(f.installed, { version: '0.1.11', arch: 'x64' }, run), /身份/);
    info.CFBundleIdentifier = BUNDLE_ID; arch = 'arm64'; await assert.rejects(checkBundle(f.installed, { version: '0.1.11', arch: 'x64' }, run), /架构/);
    arch = 'x86_64'; validSignature = false; await assert.rejects(checkBundle(f.installed, { version: '0.1.11', arch: 'x64' }, run), /signature/);
    validSignature = true;
    fs.symlinkSync(f.updatesDir, path.join(f.installed, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkBundle(f.installed, { version: '0.1.11', arch: 'x64' }, run), /越界/);
});

test('宿主真实安装IPC：Mac助手准备成功后才退出，失败时保持宿主运行', async () => {
    const text = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = text.indexOf("ipcMain.handle('update:install',"); const end = text.indexOf('// 隐藏搜索窗口', start);
    let handler, quit = 0, prepared = 0, fail = false;
    const app = { quit() { quit++; } };
    vm.runInNewContext(text.slice(start, end), {
        ipcMain: { handle(_channel, fn) { handler = fn; } }, app,
        runUpdateAction: (_event, action) => action({ verifyDownloaded: async () => ({ installAction: 'install-macos', path: 'fixture' }) }),
        getMacUpdateInstaller: () => ({ start: async () => { prepared++; if (fail) throw new Error('permission denied'); return { success: true }; } }),
        shell: { openPath() { assert.fail('Mac不得只打开Finder安装包'); } }
    });
    assert.equal((await handler({})).success, true); assert.equal(quit, 1); assert.equal(prepared, 1);
    fail = true; await assert.rejects(handler({}), /permission denied/); assert.equal(quit, 1);
});

test('Mac下载标记和按钮对应安装并重启，只有新宿主DOM就绪才发送启动确认', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    assert(html.includes("'install-macos': '安装并重启'"));
    const create = main.slice(main.indexOf('function createWindow() {'), main.indexOf('function createWindow() {') + 4000);
    assert(create.includes("mainWindow.webContents.once('dom-ready', () => getMacUpdateInstaller().acknowledgeStartup())"));
});

test('macOS原生：签名应用DMG、只读挂载复制、真实Electron助手握手及同盘替换', { skip: process.platform !== 'darwin', timeout: 180000 }, async t => {
    const f = fixture(t);
    const source = path.join(f.root, 'fixture.c'); fs.writeFileSync(source, 'int main(void) { return 0; }\n');
    const arch = process.arch;
    const nativeArch = arch === 'x64' ? 'x86_64' : 'arm64';
    for (const [directory, version] of [[f.installed, '0.1.11'], [f.incoming, '0.1.12']]) {
        const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`;
        fs.writeFileSync(path.join(directory, 'Contents', 'Info.plist'), plist);
        await runCommand('/usr/bin/clang', ['-arch', nativeArch, source, '-o', path.join(directory, 'Contents', 'MacOS', 'fixture')], { timeout: 30000 });
        await runCommand('/usr/bin/codesign', ['--force', '--sign', '-', directory], { timeout: 30000 });
    }
    fs.unlinkSync(f.downloaded.path);
    await runCommand('/usr/bin/hdiutil', ['create', '-srcfolder', f.imageRoot, '-format', 'UDZO', '-volname', 'sanrenjz-update-test', f.downloaded.path], { timeout: 60000 });
    const image = fs.readFileSync(f.downloaded.path);
    const downloaded = { ...f.downloaded, arch, bytes: image.length, sha256: crypto.createHash('sha256').update(image).digest('hex') };
    let helper;
    const installer = new MacUpdateInstaller({ updatesDir: f.updatesDir, executable: f.installer.executable, version: '0.1.11', arch,
        spawnWorker: (_file, args, options) => { helper = spawn(require('electron'), args, options); return helper; } });
    installer.watch = () => {};
    try {
        assert.equal((await installer.start(downloaded)).success, true);
        const pending = JSON.parse(fs.readFileSync(installer.pendingFile));
        const job = checkedJob(pending.jobFile);
        assert.equal(JSON.parse(fs.readFileSync(job.ready)).workerPid, helper.pid);
        assert.equal(fs.readFileSync(path.join(f.installed, 'version.txt'), 'utf8'), '0.1.11');
        await new Promise(resolve => { helper.once('exit', resolve); helper.kill(); });
        helper = null;
        assert.equal(await replaceAndRestart(job, { run: async (file, args, options) => {
            assert.equal(file, '/usr/bin/open'); assert.deepEqual(args, ['-n', f.installed]); return { stdout: '', stderr: '' };
        }, waitForStartup: async () => {
            const updated = new MacUpdateInstaller({ updatesDir: f.updatesDir, executable: installer.executable, version: '0.1.12', arch });
            assert(updated.acknowledgeStartup()); return true;
        } }), true);
        await checkBundle(f.installed, downloaded);
        assert.equal(JSON.parse(fs.readFileSync(job.status)).state, 'success');
    } finally {
        if (helper && helper.exitCode === null && helper.signalCode === null) await new Promise(resolve => { helper.once('exit', resolve); helper.kill(); });
    }
});
