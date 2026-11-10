const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync, execFile } = require('node:child_process');
const { MacTextInsertion, ACTION_SCRIPT } = require('../app/mac-text-insertion');

test('macOS 原生 JXA 桥接可编译实际脚本、创建 Command+V 事件并正常退出，不发送按键', { skip: process.platform !== 'darwin' }, () => {
    const script = `
        console.log('native: imports');
        ObjC.import('AppKit');
        ObjC.import('ApplicationServices');
        console.log('native: compile');
        new Function(${JSON.stringify(ACTION_SCRIPT)});
        if (typeof $.AXIsProcessTrusted !== 'function' || typeof $.CGEventPost !== 'function') throw new Error('Missing native API');
        // 只运行当前脚本进程的消息循环，不激活应用或发送按键。
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01));
        $.AXIsProcessTrusted();
        var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
        if (front && !front.isNil()) {
            var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(front.processIdentifier);
            if (target.isNil()) throw new Error('Invalid frontmost application');
            Boolean(target.terminated);
        }
        console.log('native: create event');
        var event = $.CGEventCreateKeyboardEvent($(), 9, true);
        $.CGEventSetFlags(event, $.kCGEventFlagMaskCommand);
        if (Number($.CGEventGetFlags(event)) !== 1048576) throw new Error('Invalid Command flag');
        console.log('native: finished');
        'native-bridge-ok';
    `;
    const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 8192
    });
    assert.equal(result.status, 0, `原生 JXA 桥接失败：status=${result.status}, signal=${result.signal}, ${result.stderr || result.error || '未知错误'}`);
    assert.equal(result.stdout.trim(), 'native-bridge-ok');
});

test('搜索显示前记录外部 PID，自身、无效结果和采样失败清除旧目标', () => {
    let output = '321\n';
    const insertion = new MacTextInsertion({ ownPid: 123, runSync(file, args, options) {
        assert.equal(file, '/usr/bin/osascript');
        assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
        assert.equal(options.timeout, 2000);
        if (output instanceof Error) throw output;
        return output;
    } });
    assert.equal(insertion.capture(), 321);
    for (output of ['123', '', '0', '321;evil()', '9007199254740993', new Error('timeout')]) {
        insertion.targetPid = 321;
        assert.equal(insertion.capture(), null);
    }
});

test('插入顺序、PID 快照、重复请求与子进程超时参数', async () => {
    const calls = [];
    let finish;
    const insertion = new MacTextInsertion({ run(file, args, options, callback) {
        calls.push('paste');
        assert.equal(file, '/usr/bin/osascript');
        assert.deepEqual(args.slice(-2), ['321', 'paste']);
        assert.equal(options.timeout, 5000);
        assert.equal(args.includes('片段正文'), false);
        finish = callback;
    } });
    insertion.targetPid = 321;
    const pending = insertion.insert(() => calls.push('hide'));
    insertion.targetPid = 999;
    await assert.rejects(insertion.insert(() => calls.push('duplicate')), /正在插入/);
    await insertion.restore();
    assert.deepEqual(calls, ['hide', 'paste']);
    finish(null, 'sent\n', '');
    await pending;
    assert.equal(insertion.isInserting, false);
});

test('权限拒绝、目标退出、焦点失败与异常输出均反馈失败并解除忙状态', async () => {
    for (const [detail, expected] of [
        ['MAC_ACCESSIBILITY', /辅助功能/], ['MAC_TARGET_GONE', /已退出/],
        ['MAC_FOCUS_CHANGED', /焦点/], ['timeout', /Command\+V/], ['', /未确认/]
    ]) {
        const insertion = new MacTextInsertion({ run(_file, _args, _options, callback) {
            callback(detail ? new Error(detail) : null, 'invalid', detail);
        } });
        insertion.targetPid = 321;
        await assert.rejects(insertion.insert(() => {}), expected);
        assert.equal(insertion.isInserting, false);
    }
    let hidden = false;
    const insertion = new MacTextInsertion();
    await assert.rejects(insertion.insert(() => { hidden = true; }), /目标输入框/);
    assert.equal(hidden, false);
});

test('真实 execFile 失败附带完整脚本时，只按实际 stderr 分类，不误报权限', async () => {
    for (const [code, expected] of [
        ['MAC_FOCUS_FAILED', /焦点/], ['MAC_TARGET_GONE', /已退出/],
        ['MAC_FOCUS_CHANGED', /焦点/], ['MAC_ACCESSIBILITY', /辅助功能/]
    ]) {
        const insertion = new MacTextInsertion({ run(_file, args, options, callback) {
            // 使用无桌面副作用的真实子进程，保留 Node 把完整脚本写入 error.message 的行为。
            const script = `/* ${args[3]} */\nprocess.stderr.write(${JSON.stringify(`execution error: Error: ${code} (-2700)\n`)}); process.exit(1);`;
            execFile(process.execPath, ['-e', script], options, (error, stdout, stderr) => {
                assert.match(error.message, /MAC_ACCESSIBILITY/);
                callback(error, stdout, stderr);
            });
        } });
        insertion.targetPid = 321;
        await assert.rejects(insertion.insert(() => {}), error => {
            assert.equal(error.code, code);
            assert.match(error.message, expected);
            if (code !== 'MAC_ACCESSIBILITY') assert.doesNotMatch(error.message, /辅助功能/);
            return true;
        });
        assert.equal(insertion.isInserting, false);
    }
});

test('错误消息和 stderr 中的脚本源码不能当作真实权限拒绝', async () => {
    for (const stderr of ['', ACTION_SCRIPT, `execution error: Error: unexpected MAC_ACCESSIBILITY text (-2700)`]) {
        const insertion = new MacTextInsertion({ run(_file, args, _options, callback) {
            callback(new Error(`Command failed: osascript ${args.join(' ')}`), '', stderr);
        } });
        insertion.targetPid = 321;
        await assert.rejects(insertion.insert(() => {}), error => {
            assert.equal(error.code, 'MAC_SCRIPT_FAILED');
            assert.doesNotMatch(error.message, /辅助功能/);
            return true;
        });
    }
});

test('真实 macOS 脚本错误行可正确分类，不激活窗口或发送按键', { skip: process.platform !== 'darwin' }, async () => {
    for (const code of ['MAC_ACCESSIBILITY', 'MAC_TARGET_GONE', 'MAC_FOCUS_FAILED', 'MAC_FOCUS_CHANGED']) {
        const insertion = new MacTextInsertion({ run(file, _args, options, callback) {
            execFile(file, ['-l', 'JavaScript', '-e', `throw new Error('${code}')`], options, callback);
        } });
        await assert.rejects(insertion.action(321, 'paste'), { code });
    }
});

test('超时、崩溃及未知错误分开报告，诊断仅保留固定字段', async () => {
    for (const [metadata, code] of [
        [{ code: null, killed: true, signal: 'SIGTERM' }, 'MAC_TIMEOUT'],
        [{ code: null, killed: false, signal: 'SIGSEGV' }, 'MAC_SCRIPT_SIGNAL'],
        [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }, 'MAC_SCRIPT_FAILED'],
        [{ code: 'ENOENT' }, 'MAC_SCRIPT_FAILED']
    ]) {
        const diagnostics = [];
        const insertion = new MacTextInsertion({ onDiagnostic: d => diagnostics.push(d), run(_file, args, _options, callback) {
            callback(Object.assign(new Error(`Command failed: ${args.join(' ')} SECRET`), metadata), '', 'SECRET (-2700)');
        } });
        insertion.targetPid = 321;
        await assert.rejects(insertion.insert(() => {}), error => {
            assert.equal(error.code, code);
            assert.doesNotMatch(error.message, /辅助功能|SECRET/);
            assert.deepEqual(error.diagnostic, diagnostics[0]);
            return true;
        });
        assert.deepEqual(Object.keys(diagnostics[0]).sort(), ['code', 'operation', 'targetPid', 'exitCode', 'signal', 'nativeCode'].sort());
        assert.equal(diagnostics[0].nativeCode, -2700);
        assert.doesNotMatch(JSON.stringify(diagnostics), /SECRET|ObjC|Command failed/);
        assert.equal(insertion.isInserting, false);
    }
});

test('连续五次采样和插入：首成功、后续焦点失败及再成功均不遗留忙状态', async () => {
    const outcomes = ['sent', 'MAC_FOCUS_CHANGED', 'sent', 'MAC_FOCUS_FAILED', 'sent'];
    const diagnostics = [];
    let index = 0, hidden = 0;
    const insertion = new MacTextInsertion({ ownPid: 123, onDiagnostic: d => diagnostics.push(d),
        runSync: () => String(321 + index), run(_file, args, _options, callback) {
            assert.equal(args.at(-2), String(321 + index));
            const outcome = outcomes[index++];
            if (outcome === 'sent') callback(null, 'sent\n', '');
            else callback(new Error(`Command failed: ${args.join(' ')}`), '', `execution error: Error: ${outcome} (-2700)`);
        }
    });
    for (const outcome of outcomes) {
        insertion.capture();
        const pending = insertion.insert(() => hidden++);
        if (outcome === 'sent') await pending;
        else await assert.rejects(pending, { code: outcome });
        assert.equal(insertion.isInserting, false);
    }
    assert.equal(hidden, 5);
    assert.deepEqual(diagnostics.map(d => d.code), ['MAC_FOCUS_CHANGED', 'MAC_FOCUS_FAILED']);
});

test('诊断写入失败不掩盖真正的插入错误，也不泄露原始信息', async () => {
    for (const onDiagnostic of [() => { throw new Error('logger failed'); }, () => Promise.reject(new Error('logger failed'))]) {
        const insertion = new MacTextInsertion({ onDiagnostic, run(_file, _args, _options, callback) {
            callback(new Error('Command failed: SECRET MAC_ACCESSIBILITY'), '', 'MAC_FOCUS_FAILED');
        } });
        await assert.rejects(insertion.action(321, 'focus'), error => {
            assert.equal(error.code, 'MAC_FOCUS_FAILED');
            assert.doesNotMatch(error.message, /辅助功能|已复制|SECRET|logger failed/);
            return true;
        });
    }
});

test('宿主实际初始化的诊断回调进入统一日志，筛选后仍只有脱敏字段', async () => {
    const { RunLogStore } = require('../app/run-log-store');
    const store = new RunLogStore();
    const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf('const macTextInsertion =');
    const end = source.indexOf('const { ReleaseUpdates,', start);
    assert.ok(start >= 0 && end > start, '找不到实际宿主初始化边界');
    const context = vm.createContext({ process: { platform: 'darwin' },
        MacTextInsertion: class extends MacTextInsertion {
            constructor(options) {
                super({ ...options, run(_file, args, _options, callback) {
                    callback(new Error(`Command failed: ${args.join(' ')} SECRET`), '', 'execution error: Error: Error: MAC_FOCUS_CHANGED (-2700)');
                } });
            }
        },
        mergedHost: { recordToolLog: event => store.append({ ...event, engine: 'tools' }) }
    });
    vm.runInContext(source.slice(start, end), context);
    const insertion = vm.runInContext('macTextInsertion', context);
    await assert.rejects(insertion.action(321, 'paste'), { code: 'MAC_FOCUS_CHANGED' });
    const records = store.query({ engine: 'tools', id: 'tools:host-text-insertion' });
    assert.equal(records.length, 1);
    assert.equal(JSON.parse(records[0].message).code, 'MAC_FOCUS_CHANGED');
    assert.doesNotMatch(records[0].message, /SECRET|ObjC|Command failed|片段正文/);
    assert.ok(store.sources().some(item => item.id === 'tools:host-text-insertion'));
});

function nativeFixture({ trusted = true, gone = false, switchFocus = false, activate = true,
    cachedActivation = false, activationDelayMs = 0, earlyReturnMs = Infinity } = {}) {
    const events = [];
    let frontPid = 123, now = 0, activatedAt = null, activationPending = false;
    const waits = { runLoop: 0, sleep: 0 };
    const updateFocus = () => {
        if (activationPending && now >= activationDelayMs) {
            frontPid = 321;
            activatedAt = now;
            activationPending = false;
        }
        if (switchFocus && activatedAt !== null && now >= activatedAt + 120) frontPid = 999;
    };
    const target = { isNil: () => gone, terminated: gone, activateWithOptions(value) {
        assert.equal(value, 2);
        if (activate) {
            if (cachedActivation) activationPending = true;
            else { frontPid = 321; activatedAt = now; }
        }
        return activate;
    } };
    const workspace = { get frontmostApplication() { return { processIdentifier: frontPid }; } };
    const $ = () => null;
    Object.assign($, {
        NSWorkspace: { sharedWorkspace: workspace },
        NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => { assert.equal(pid, 321); return target; } },
        // 模拟 AppKit 缓存：阻塞 sleep 只推进时间，不接收已排队的激活通知。
        NSThread: { sleepForTimeInterval(seconds) {
            waits.sleep++;
            now += Math.round(seconds * 1000);
            if (seconds === 0.12 && switchFocus) frontPid = 999;
        } },
        NSDate: { dateWithTimeIntervalSinceNow: seconds => ({ time: now + Math.round(seconds * 1000) }) },
        NSRunLoop: { currentRunLoop: { runUntilDate(date) {
            waits.runLoop++;
            now = Math.min(date.time, now + earlyReturnMs);
            updateFocus();
        } } },
        AXIsProcessTrusted: () => trusted,
        CGEventCreateKeyboardEvent: (_source, key, down) => ({ key, down }),
        CGEventSetFlags: (event, flags) => { event.flags = flags; },
        CGEventPost: (_tap, event) => { assert.equal(frontPid, 321); events.push(event); },
        CFRelease: () => assert.fail('JXA 不得手动调用 CFRelease'), kCGEventFlagMaskCommand: 1048576, kCGHIDEventTap: 0
    });
    const context = vm.createContext({ $, ObjC: { import() {} }, Date: { now: () => now } });
    vm.runInContext(ACTION_SCRIPT, context);
    return { run: mode => context.run(['321', mode]), events, waits, elapsed: () => now };
}

test('实际 JXA 脚本先确认权限和目标焦点，再发 Command+V 的按下/释放', () => {
    const native = nativeFixture();
    assert.equal(native.run('paste'), 'sent');
    assert.deepEqual(native.events, [
        { key: 9, down: true, flags: 1048576 }, { key: 9, down: false, flags: 1048576 }
    ]);
    const focusOnly = nativeFixture({ trusted: false });
    assert.equal(focusOnly.run('focus'), 'focused');
    assert.equal(focusOnly.events.length, 0);
});

test('实际 JXA 脚本遇到权限拒绝、目标退出或焦点被切走，绝不发送按键', () => {
    for (const [options, error] of [
        [{ trusted: false }, /MAC_ACCESSIBILITY/], [{ gone: true }, /MAC_TARGET_GONE/],
        [{ activate: false }, /MAC_FOCUS_FAILED/], [{ switchFocus: true }, /MAC_FOCUS_CHANGED/]
    ]) {
        const native = nativeFixture(options);
        assert.throws(() => native.run('paste'), error);
        assert.equal(native.events.length, 0);
    }
});

test('AppKit 激活状态仅在 run loop 运行后更新，缓存旧前台 PID 时仍能插入', () => {
    const native = nativeFixture({ cachedActivation: true });
    assert.equal(native.run('paste'), 'sent');
    assert.equal(native.events.length, 2);
    assert.ok(native.waits.runLoop > 0);
    assert.equal(native.waits.sleep, 0);
    assert.ok(native.elapsed() >= 120, '发送按键前须完成稳定等待');
});

test('runUntilDate 提前返回不能耗尽重试次数，真实超时预算保持 1.5 秒', () => {
    const delayed = nativeFixture({ cachedActivation: true, activationDelayMs: 600, earlyReturnMs: 1 });
    assert.equal(delayed.run('paste'), 'sent');
    assert.ok(delayed.waits.runLoop > 30, '提前返回不等于已等待 50 毫秒');
    assert.ok(delayed.elapsed() >= 720, '激活后仍须稳定等待 120 毫秒');
    const timeout = nativeFixture({ cachedActivation: true, activationDelayMs: 1600, earlyReturnMs: 1 });
    assert.throws(() => timeout.run('paste'), /MAC_FOCUS_FAILED/);
    assert.equal(timeout.elapsed(), 1500);
    assert.equal(timeout.events.length, 0);
});

test('稳定等待处理 run loop 期间焦点被切走，仍取消粘贴', () => {
    const native = nativeFixture({ cachedActivation: true, switchFocus: true, earlyReturnMs: 1 });
    assert.throws(() => native.run('paste'), /MAC_FOCUS_CHANGED/);
    assert.equal(native.events.length, 0);
    assert.equal(native.waits.sleep, 0);
});

// 使用宿主真实 IPC 处理函数，隔离剪贴板、窗口和系统命令等桌面副作用。
function hostFixture(platform, macTextInsertion) {
    const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf("ipcMain.handle('insert-content',");
    const end = source.indexOf('// 带重试机制的粘贴函数', start);
    let handler;
    const clipboard = [];
    const calls = [];
    function window(name) {
        return { visible: true, destroyed: false, isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; },
            hide() { calls.push(name + ':hide'); this.visible = false; },
            show() { calls.push(name + ':show'); this.visible = true; },
            close() { calls.push(name + ':close'); this.destroyed = true; } };
    }
    const search = window('search'), plugin = window('plugin');
    vm.runInNewContext(source.slice(start, end), {
        ipcMain: { handle(_channel, fn) { handler = fn; } },
        require: () => ({ clipboard: { writeText: text => clipboard.push(text) }, Notification: { isSupported: () => false } }),
        BrowserWindow: { fromWebContents: () => plugin }, mainWindow: {}, searchWindow: search,
        macTextInsertion, process: { platform }, console: { log() {}, error() {} }, Buffer,
        lastSearchHotkeyTime: 0, setTimeout: fn => fn(),
        restoreFocusToLastActiveWindow: () => calls.push('restore'),
        spawn(file, args) {
            calls.push({ file, args });
            const child = new EventEmitter(); child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
            queueMicrotask(() => child.emit('exit', 0));
            return child;
        }
    });
    const content = { title: '测试', contentType: 'text-snippet', content: '中文\n引号\" $() 片段正文', directInsert: true };
    return { invoke: overrides => handler({ sender: {} }, { ...content, ...overrides }), calls, clipboard, search, plugin };
}

test('宿主 macOS 真实插入 IPC：先复制再隐藏，成功后关闭搜索；复制模式不发按键', async () => {
    const mac = { async insert(prepare) { assert.equal(f.clipboard.length, 1); await prepare(); f.calls.push('paste'); } };
    const f = hostFixture('darwin', mac);
    assert.equal((await f.invoke()).success, true);
    assert.deepEqual(f.calls, ['search:hide', 'plugin:hide', 'paste', 'search:close']);
    const copy = hostFixture('darwin', { insert() { assert.fail('复制模式不应插入'); } });
    assert.equal((await copy.invoke({ directInsert: false })).success, true);
    assert.deepEqual(copy.calls, ['search:hide']);
});

test('宿主 macOS 失败恢复窗口、保留剪贴板；忙状态不能覆盖正在粘贴的正文', async () => {
    const f = hostFixture('darwin', { async insert(prepare) { await prepare(); throw new Error('辅助功能权限被拒绝'); } });
    const result = await f.invoke();
    assert.equal(result.success, false);
    assert.match(result.error, /辅助功能/);
    assert.deepEqual(f.calls, ['search:hide', 'plugin:hide', 'search:show', 'plugin:show']);
    assert.equal(f.clipboard.length, 1);
    assert.equal(f.search.destroyed, false);
    const busy = hostFixture('darwin', { isInserting: true });
    assert.equal((await busy.invoke()).success, false);
    assert.equal(busy.clipboard.length, 0);
});

test('Windows 继续发送 Ctrl+V；其他系统不再误调用 PowerShell', async () => {
    const win = hostFixture('win32', null);
    assert.equal((await win.invoke()).success, true);
    const command = win.calls.find(value => value.file);
    assert.equal(command.file, 'powershell');
    assert.match(Buffer.from(command.args.at(-1), 'base64').toString('utf16le'), /SendWait\('\^v'\)/);
    const linux = hostFixture('linux', null);
    assert.equal((await linux.invoke()).success, false);
    assert.equal(linux.clipboard.length, 1);
    assert.equal(linux.calls.length, 0);
});

test('宿主呼出搜索时先记录目标，再显示和聚焦窗口', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf('function showSearchWindow() {');
    const end = source.indexOf('// 记录当前活动窗口 (同步)', start);
    const calls = [];
    const screen = {
        getCursorScreenPoint: () => ({ x: 500, y: 500 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
    };
    const context = vm.createContext({
        hasActiveInput: false, recordActiveWindowWithInputStatusAsync: () => calls.push('capture'),
        searchWindow: { isDestroyed: () => false, setBounds() {}, show: () => calls.push('show'), focus: () => calls.push('focus') },
        require: () => ({ screen }), console
    });
    vm.runInContext(source.slice(start, end), context);
    context.showSearchWindow();
    assert.deepEqual(calls, ['capture', 'show', 'focus']);
});

function searchWindowLifecycleFixture() {
    const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf('function createSearchWindow() {');
    const end = source.indexOf('// 显示搜索窗口', start);
    assert.ok(start >= 0 && end > start, '找不到实际搜索窗口创建函数');
    const closed = [];
    let restored = 0;
    class FixtureWindow extends EventEmitter {
        constructor() { super(); this.destroyed = false; this.webContents = {}; }
        isDestroyed() { return this.destroyed; }
        loadFile() {}
        close() { closed.push(this); }
    }
    const context = vm.createContext({
        searchWindow: null, BrowserWindow: FixtureWindow, getIconPath: () => 'fixture-icon',
        remoteMain: null, getResourcePath: () => 'fixture-search-window.html',
        fs: { existsSync: () => true }, isPinned: false, macTextInsertion: null,
        restoreFocusToLastActiveWindow: () => restored++, console: { log() {} }
    });
    vm.runInContext(source.slice(start, end), context);
    const previous = context.createSearchWindow();
    // 原生窗口已销毁，但旧窗口排队的事件尚未进入 JS；下一次热键已经创建新窗口。
    previous.destroyed = true;
    const current = context.createSearchWindow();
    return { previous, current, context, closed, restored: () => restored };
}

test('旧搜索窗口延迟 blur 不关闭新搜索窗口或恢复旧焦点', () => {
    const fixture = searchWindowLifecycleFixture();
    fixture.previous.emit('blur');
    assert.deepEqual(fixture.closed, []);
    assert.equal(fixture.restored(), 0);
    assert.equal(fixture.context.searchWindow, fixture.current);
    fixture.current.emit('blur');
    assert.deepEqual(fixture.closed, [fixture.current]);
    assert.equal(fixture.restored(), 1);
});

test('旧搜索窗口延迟 closed 不清空新窗口引用或其钉住状态', () => {
    const fixture = searchWindowLifecycleFixture();
    fixture.context.isPinned = true;
    fixture.previous.emit('closed');
    assert.equal(fixture.context.searchWindow, fixture.current);
    assert.equal(fixture.context.isPinned, true);
    fixture.current.emit('closed');
    assert.equal(fixture.context.searchWindow, null);
    assert.equal(fixture.context.isPinned, false);
});

test('搜索页面延迟失焦：执行中或已恢复焦点时保留窗口，普通失焦仍隐藏', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../search-window.html'), 'utf8');
    const start = source.indexOf("window.addEventListener('blur',");
    const end = source.indexOf('// 监听主进程发送的钉住状态变化', start);
    let onBlur, delayed, hides = 0, focused = false;
    const context = vm.createContext({
        window: { addEventListener(_name, fn) { onBlur = fn; } },
        setTimeout(fn, ms) { assert.equal(ms, 200); delayed = fn; },
        isPinned: false, isExecuting: false, document: { hasFocus: () => focused },
        hideWindow: () => hides++
    });
    vm.runInContext(source.slice(start, end), context);
    onBlur(); context.isExecuting = true; delayed();
    assert.equal(hides, 0);
    onBlur(); context.isExecuting = false; focused = true; delayed();
    assert.equal(hides, 0);
    onBlur(); focused = false; context.isPinned = true; delayed();
    assert.equal(hides, 0);
    onBlur(); context.isPinned = false; delayed();
    assert.equal(hides, 1);
});
