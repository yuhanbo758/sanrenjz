'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { hookOutputSource } = require('../app/plugin_runtime/windows-hook-output');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '../app/software/sanrenjz-tools-speech_input/renderer.js'), 'utf8');

function scriptFor(source, functionName, delay = 350) {
    const start = source.indexOf('const psScript = `', source.indexOf(`function ${functionName}`)) + 'const psScript = '.length;
    const end = source.indexOf('`;', start) + 1;
    return new Function('delay', 'hookOutputSource', `return ${source.slice(start, end)}`)(delay, hookOutputSource);
}

// 主程序重启监听时，迟到的旧进程 exit 不得清空新实例或再注册一个全局钩子。
const children = [];
const timers = new Set();
const context = vm.createContext({
    process: { platform: 'win32' }, app: { getPath: () => os.tmpdir(), isQuiting: false },
    loadSettings: () => ({ enableRightClickPanel: true, rightClickDelay: 350 }),
    fs: { writeFileSync() {} }, path, hookOutputSource, console: { log() {}, warn() {}, error() {} },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    spawn() {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = { end() {} }; child.kill = () => { child.killed = true; };
        children.push(child); return child;
    },
    captureSelectedTextForPanel: async () => ({}), showSuperPanel() {}
});
vm.runInContext(main.slice(main.indexOf('let mouseMonitorProcess = null;'), main.indexOf('async function copySelectedTextToClipboard()')), context);
vm.runInContext('startMouseMonitor(); stopMouseMonitor(); startMouseMonitor()', context);
children[0].emit('exit', 1);
assert.strictEqual(vm.runInContext('mouseMonitorProcess', context), children[1]);
assert.strictEqual(timers.size, 0);
children[1].emit('exit', 1);
assert.strictEqual(timers.size, 1);
vm.runInContext('stopMouseMonitor()', context);
assert.strictEqual(timers.size, 0);
context.app.isQuiting = true;
vm.runInContext('startMouseMonitor()', context);
assert.strictEqual(children.length, 2);

const harness = `
public class BlockingHookWriter : System.IO.TextWriter {
    public readonly System.Threading.ManualResetEvent Entered = new System.Threading.ManualResetEvent(false);
    public readonly System.Threading.ManualResetEvent Release = new System.Threading.ManualResetEvent(false);
    public readonly System.Threading.ManualResetEvent OverflowSeen = new System.Threading.ManualResetEvent(false);
    public override System.Text.Encoding Encoding { get { return System.Text.Encoding.UTF8; } }
    public override void WriteLine(string value) {
        Entered.Set(); Release.WaitOne();
        if (value == "HOOK_OUTPUT_OVERFLOW") OverflowSeen.Set();
    }
}

public static class HookRegression {
    private static readonly System.Reflection.BindingFlags PrivateStatic =
        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static IntPtr Mouse(int message, int x, int y, uint time, int flags = 0) {
        IntPtr data = Marshal.AllocHGlobal(40);
        try {
            for (int i = 0; i < 40; i += 4) Marshal.WriteInt32(data, i, 0);
            Marshal.WriteInt32(data, 0, x); Marshal.WriteInt32(data, 4, y);
            Marshal.WriteInt32(data, 12, flags); Marshal.WriteInt32(data, 16, unchecked((int)time));
            return (IntPtr)typeof(SanrenjzMouseHook).GetMethod("HookCallback", PrivateStatic)
                .Invoke(null, new object[] { 0, new IntPtr(message), data });
        } finally { Marshal.FreeHGlobal(data); }
    }
    private static void Key(int key, bool down, int flags = 0) {
        IntPtr data = Marshal.AllocHGlobal(32);
        try {
            for (int i = 0; i < 32; i += 4) Marshal.WriteInt32(data, i, 0);
            Marshal.WriteInt32(data, 0, key); Marshal.WriteInt32(data, 8, flags);
            typeof(KeyboardHook).GetMethod("HookCallback", PrivateStatic)
                .Invoke(null, new object[] { 0, new IntPtr(down ? 0x100 : 0x101), data });
        } finally { Marshal.FreeHGlobal(data); }
    }
    public static void Run() {
        var writer = new BlockingHookWriter();
        System.Console.SetOut(writer);
        SanrenjzHookOutput.Start();
        SanrenjzHookOutput.TryWrite("block-output");
        Check(writer.Entered.WaitOne(3000), "writer did not block");
        typeof(SanrenjzMouseHook).GetField("threshold", PrivateStatic).SetValue(null, 350);
        var queue = (ConcurrentQueue<uint[]>)typeof(SanrenjzMouseHook).GetField("replayQueue", PrivateStatic).GetValue(null);
        uint[] flags;

        Mouse(0x204, 10, 10, 100); Mouse(0x205, 10, 10, 150);
        Check(queue.TryDequeue(out flags) && flags.Length == 2 && flags[0] == 8 && flags[1] == 16, "short click must be paired");
        Mouse(0x204, 10, 10, 200); Mouse(0x200, 30, 10, 210);
        Check(Mouse(0x205, 30, 10, 220) != IntPtr.Zero, "drag UP must not overtake async DOWN");
        Check(queue.TryDequeue(out flags) && flags.Length == 1 && flags[0] == 8, "drag DOWN missing");
        Check(queue.TryDequeue(out flags) && flags.Length == 1 && flags[0] == 16, "drag UP missing");
        Mouse(0x204, 10, 10, uint.MaxValue - 100); Mouse(0x205, 10, 10, 150);
        Check(queue.TryDequeue(out flags) && flags.Length == 2, "clock wraparound broke short click");
        Mouse(0x204, 10, 10, 100, 1); Mouse(0x205, 10, 10, 150, 1);
        Check(queue.IsEmpty, "injected mouse events were intercepted");
        var pendingCount = typeof(SanrenjzHookOutput).GetField("count", PrivateStatic);
        int beforeInjectedKey = (int)pendingCount.GetValue(null);
        Key(0xA3, true, 0x10); Key(0xA3, false, 0x10);
        Check((int)pendingCount.GetValue(null) == beforeInjectedKey, "injected keys triggered speech hotkeys");
        Check(Marshal.SizeOf(typeof(SanrenjzMouseHook).GetNestedType("INPUT", System.Reflection.BindingFlags.NonPublic))
            == (IntPtr.Size == 8 ? 40 : 28), "SendInput structure has the wrong native size");

        var timer = Stopwatch.StartNew();
        for (int i = 0; i < 1000; i++) {
            Mouse(0x204, 10, 10, (uint)(i * 1000)); Mouse(0x205, 10, 10, (uint)(i * 1000 + 500));
            Key(0xA3, true); Key(0xA3, false);
        }
        timer.Stop();
        Check(timer.ElapsedMilliseconds < 1000, "blocked output stalled global input callbacks");
        Check(queue.IsEmpty, "long press replayed a native context click");
        int count = (int)typeof(SanrenjzHookOutput).GetField("count", PrivateStatic).GetValue(null);
        Check(count <= 256, "output backlog grew without limit");
        writer.Release.Set();
        Check(writer.OverflowSeen.WaitOne(3000), "overflow must reset consumer state");
        System.Console.Error.WriteLine("Native hook regression passed: 4000 callbacks while output blocked, " + timer.ElapsedMilliseconds + "ms; paired click/drag, injected bypass, rollover and bounded backlog");
    }
}
`;

async function runPowerShell(script, readyMarker) {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-hook-test-'));
    const file = path.join(fixture, 'test.ps1');
    fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
    try {
        await new Promise((resolve, reject) => {
            const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', file],
                { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            let out = ''; let err = ''; let ready = false;
            const timeout = setTimeout(() => { child.kill(); reject(new Error(`Hook test timeout: ${out} ${err}`)); }, 20000);
            child.stdout.on('data', data => {
                out += data.toString();
                if (readyMarker && out.includes(readyMarker)) { ready = true; child.stdin.end(); }
            });
            child.stderr.on('data', data => { err += data.toString(); });
            child.on('error', reject);
            child.on('exit', code => {
                clearTimeout(timeout);
                if (code !== 0 || (readyMarker ? !ready : !err.includes('Native hook regression passed'))) reject(new Error(`${code}: ${out} ${err}`));
                else { if (err) console.log(err.trim()); resolve(); }
            });
        });
    } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}

(async () => {
    console.log('Mouse monitor lifecycle passed: stale exit, restart cancellation and quit');
    if (process.platform !== 'win32') { console.log('Native hook tests skipped: Windows required'); return; }
    const mouseScript = scriptFor(main, 'startMouseMonitor');
    const keyboardScript = scriptFor(renderer, 'startRightCtrlHook');
    const mouseSource = mouseScript.split("$source = @'\n")[1].split("\n'@")[0];
    const keyboardSource = keyboardScript.split('Add-Type -TypeDefinition @"\n')[1].split('\n"@')[0]
        .replace(hookOutputSource, '').replace(/^using .*;\r?\n/gm, '');
    // 调用真实回调，但不装钩子、不发送系统输入，防止影响用户正在编辑的笔记。
    await runPowerShell(`$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${mouseSource}\n${keyboardSource}\n${harness}\n'@ -ReferencedAssemblies System.Windows.Forms\n[HookRegression]::Run()\n`);
    // 安装一次真实钩子，只检查初始化和 stdin EOF 自动退出，不模拟点击用户窗口。
    await runPowerShell(mouseScript, 'HOOK_READY');
    await runPowerShell(keyboardScript.replace('try { Application.Run(); }', 'SanrenjzHookOutput.TryWrite("HOOK_READY"); try { Application.Run(); }'), 'HOOK_READY');
    console.log('Native mouse/keyboard installation and parent-pipe cleanup passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
