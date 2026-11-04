const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { setupConsoleEncoding, decodeUtf8Stream } = require('../app/console-encoding');
const { startApp } = require('../scripts/start-app.cjs');

test('Windows console is configured before Electron is spawned; stdio and arguments are inherited', async () => {
    const calls = [];
    const child = new EventEmitter();
    const host = new EventEmitter();
    const running = startApp({
        executable: 'test-electron', args: ['--inspect=9229', '--user-argument'], processObject: host,
        setupEncoding: () => calls.push('encoding'),
        spawnImpl: (executable, args, options) => {
            calls.push('spawn');
            assert.equal(executable, 'test-electron');
            assert.deepEqual(args, ['.', '--inspect=9229', '--user-argument']);
            assert.equal(options.stdio, 'inherit');
            assert.equal(options.windowsHide, false);
            return child;
        }
    });
    child.emit('close', 17, null);
    assert.deepEqual(await running, { code: 17, signal: null });
    assert.deepEqual(calls, ['encoding', 'spawn']);
    assert.equal(host.listenerCount('SIGINT'), 0);
    assert.equal(host.listenerCount('SIGTERM'), 0);
});

test('launcher forwards termination signals and preserves the child signal result', async () => {
    const host = new EventEmitter();
    const child = new EventEmitter();
    const sent = [];
    child.killed = false;
    child.kill = signal => { sent.push(signal); child.killed = true; };
    const running = startApp({ executable: 'test-electron', processObject: host, setupEncoding: () => {}, spawnImpl: () => child });
    host.emit('SIGINT');
    host.emit('SIGTERM');
    child.emit('close', null, 'SIGINT');
    assert.deepEqual(await running, { code: null, signal: 'SIGINT' });
    assert.deepEqual(sent, ['SIGINT']);
    assert.equal(host.listenerCount('SIGINT'), 0);
});

test('spawn errors propagate without leaving signal listeners installed', async () => {
    const host = new EventEmitter();
    const child = new EventEmitter();
    const running = startApp({ executable: 'test-electron', processObject: host, setupEncoding: () => {}, spawnImpl: () => child });
    child.emit('error', new Error('test executable missing'));
    child.emit('close', -1, null);
    await assert.rejects(running, /test executable missing/);
    assert.equal(host.listenerCount('SIGTERM'), 0);
});

test('non-Windows encoding setup does not invoke Windows commands', () => {
    for (const platform of ['linux', 'darwin']) {
        assert.deepEqual(setupConsoleEncoding({ platform, spawnSyncImpl: () => { throw new Error('unexpected Windows command'); } }), { changed: false, reason: 'not-windows' });
    }
});

test('Windows setup uses the current console only and tolerates GUI launches without a console', () => {
    let count = 0;
    const result = setupConsoleEncoding({
        platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
        spawnSyncImpl: (executable, args, options) => {
            count++;
            assert.equal(executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
            assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
            const script = Buffer.from(args[3], 'base64').toString('utf16le');
            assert.ok(script.includes(`AttachConsole(${process.pid})`));
            assert.ok(script.includes('GetConsoleOutputCP() -eq 65001'));
            assert.equal(options.windowsHide, true);
            assert.equal(options.stdio, 'ignore');
            assert.equal(options.timeout, 5000);
            return { status: 0 };
        }
    });
    assert.equal(count, 1);
    assert.deepEqual(result, { changed: true, codePage: 65001 });
    assert.equal(setupConsoleEncoding({ platform: 'win32', spawnSyncImpl: () => ({ status: 1 }) }).changed, false);
    assert.doesNotThrow(() => setupConsoleEncoding({ platform: 'win32', spawnSyncImpl: () => { throw new Error('no console'); } }));
});

test('UTF-8 child output preserves Chinese and emoji across every byte boundary', async () => {
    const expected = '三人聚智：插件初始化完成\nCtrl+D 已注册 😀\n';
    const stream = new PassThrough();
    let actual = '';
    decodeUtf8Stream(stream, text => { actual += text; });
    const ended = new Promise(resolve => stream.once('end', resolve));
    for (const byte of Buffer.from(expected, 'utf8')) stream.write(Buffer.from([byte]));
    stream.end();
    await ended;
    assert.equal(actual, expected);
    assert.ok(!actual.includes('\uFFFD'));
});

test('inherited subprocess stdio preserves unknown legacy bytes without UTF-8 reinterpretation', () => {
    const launcher = path.resolve(__dirname, '../scripts/start-app.cjs');
    const fixture = `const {spawn}=require('node:child_process'); const {startApp}=require(${JSON.stringify(launcher)}); startApp({executable:process.execPath,args:[],setupEncoding:()=>{},spawnImpl:(exe,_args,options)=>spawn(exe,['-e','process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))'],options)}).then(result=>{process.exitCode=result.code});`;
    const result = spawnSync(process.execPath, ['-e', fixture], { windowsHide: true });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(result.stdout, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
});

test('hidden temporary Windows console changes from GBK to UTF-8 and writes intact Chinese output', { skip: process.platform !== 'win32', timeout: 20000 }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-console-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fixture = path.join(directory, 'console-fixture.cjs');
    const report = path.join(directory, 'report.json');
    const stdout = path.join(directory, 'stdout.txt');
    const stderr = path.join(directory, 'stderr.txt');
    const modulePath = path.resolve(__dirname, '../app/console-encoding');
    const message = '三人聚智 插件初始化 Ctrl+D 已注册 😀\n';
    fs.writeFileSync(fixture, `const fs=require('node:fs');const {spawnSync}=require('node:child_process');const {setupConsoleEncoding}=require(${JSON.stringify(modulePath)});const command=process.env.ComSpec||process.env.COMSPEC;spawnSync(command,['/d','/c','chcp 936 >nul'],{windowsHide:false,stdio:'ignore'});const before=spawnSync(command,['/d','/c','chcp'],{windowsHide:false,encoding:'utf8'}).stdout;const setup=setupConsoleEncoding();const after=spawnSync(command,['/d','/c','chcp'],{windowsHide:false,encoding:'utf8'}).stdout;process.stdout.write(${JSON.stringify(message)});fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({before,after,setup}),'utf8');`, 'utf8');
    const quote = value => `'${String(value).replace(/'/g, "''")}'`;
    // 独立隐藏控制台，避免测试更改正在使用的终端代码页。
    const command = `$child = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(`"${fixture}"`)} -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput ${quote(stdout)} -RedirectStandardError ${quote(stderr)}; exit $child.ExitCode`;
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 18000 });
    assert.equal(result.status, 0, result.stderr.toString('utf8'));
    const saved = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.match(saved.before, /936/);
    assert.match(saved.after, /65001/);
    assert.equal(saved.setup.changed, true);
    assert.equal(fs.readFileSync(stdout, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), message);
    assert.equal(fs.readFileSync(stderr, 'utf8'), '');
    const artifact = path.resolve(__dirname, '../dist/console-encoding-report.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({
        success: true, isolatedHiddenConsole: true,
        beforeCodePage: Number(saved.before.match(/\d+/)[0]),
        afterCodePage: Number(saved.after.match(/\d+/)[0]),
        nativeCodePageVerified: saved.setup.changed, stdout: message
    }, null, 2), 'utf8');
});
