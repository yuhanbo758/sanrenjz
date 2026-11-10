const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { MacTextInsertion, ACTION_SCRIPT } = require('../app/mac-text-insertion');

test('macOS 原生 JXA 桥接可编译实际脚本、创建 Command+V 事件并正常退出，不发送按键', { skip: process.platform !== 'darwin' }, () => {
    const script = `
        console.log('native: imports');
        ObjC.import('AppKit');
        ObjC.import('ApplicationServices');
        console.log('native: compile');
        new Function(${JSON.stringify(ACTION_SCRIPT)});
        if (typeof $.AXIsProcessTrusted !== 'function' || typeof $.CGEventPost !== 'function') throw new Error('Missing native API');
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

function nativeFixture({ trusted = true, gone = false, switchFocus = false, activate = true } = {}) {
    const events = [];
    let frontPid = 123;
    const target = { isNil: () => gone, terminated: gone, activateWithOptions(value) {
        assert.equal(value, 2);
        if (activate) frontPid = 321;
        return activate;
    } };
    const workspace = { get frontmostApplication() { return { processIdentifier: frontPid }; } };
    const $ = () => null;
    Object.assign($, {
        NSWorkspace: { sharedWorkspace: workspace },
        NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => { assert.equal(pid, 321); return target; } },
        NSThread: { sleepForTimeInterval(seconds) { if (seconds === 0.12 && switchFocus) frontPid = 999; } },
        AXIsProcessTrusted: () => trusted,
        CGEventCreateKeyboardEvent: (_source, key, down) => ({ key, down }),
        CGEventSetFlags: (event, flags) => { event.flags = flags; },
        CGEventPost: (_tap, event) => { assert.equal(frontPid, 321); events.push(event); },
        CFRelease: () => assert.fail('JXA 不得手动调用 CFRelease'), kCGEventFlagMaskCommand: 1048576, kCGHIDEventTap: 0
    });
    const context = vm.createContext({ $, ObjC: { import() {} } });
    vm.runInContext(ACTION_SCRIPT, context);
    return { run: mode => context.run(['321', mode]), events };
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
