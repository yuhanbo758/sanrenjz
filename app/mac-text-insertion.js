const { execFile, execFileSync } = require('child_process');

const CAPTURE_SCRIPT = `
ObjC.import('AppKit');
String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
`;

// 只传进程 ID，片段正文始终留在剪贴板，不拼接进脚本或命令行。
const ACTION_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function waitWithRunLoop(seconds) {
    var deadline = Date.now() + seconds * 1000;
    var remaining;
    // AppKit 的可变状态要在主 run loop 运行后才更新；阻塞 sleep 会一直读到旧前台。
    // runUntilDate 可能提前返回，因此按实际截止时间等待，不能用调用次数当作耗时。
    while ((remaining = deadline - Date.now()) > 0) {
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(remaining / 1000));
    }
}
function run(argv) {
    var pid = Number(argv[0]);
    var paste = argv[1] === 'paste';
    if (paste && !$.AXIsProcessTrusted()) throw new Error('MAC_ACCESSIBILITY');
    var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (!target || target.isNil() || target.terminated) throw new Error('MAC_TARGET_GONE');
    if (!target.activateWithOptions(2)) throw new Error('MAC_FOCUS_FAILED');
    var ready = false;
    var focusDeadline = Date.now() + 1500;
    for (;;) {
        if ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier === pid) {
            ready = true;
            break;
        }
        var remaining = focusDeadline - Date.now();
        if (remaining <= 0) break;
        waitWithRunLoop(Math.min(0.05, remaining / 1000));
    }
    if (!ready) throw new Error('MAC_FOCUS_FAILED');
    if (!paste) return 'focused';
    waitWithRunLoop(0.12);
    // 切换动画后再次核对焦点，不能把片段粘贴进用户刚切换到的其他应用。
    if ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier !== pid) {
        throw new Error('MAC_FOCUS_CHANGED');
    }
    var down = $.CGEventCreateKeyboardEvent($(), 9, true);
    var up = $.CGEventCreateKeyboardEvent($(), 9, false);
    // JXA 的 CFRelease 桥接会使 osascript 崩溃；两个事件随本次短进程退出回收。
    $.CGEventSetFlags(down, $.kCGEventFlagMaskCommand);
    $.CGEventSetFlags(up, $.kCGEventFlagMaskCommand);
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
    return 'sent';
}
`;

const FAILURE_MESSAGES = Object.freeze({
    MAC_ACCESSIBILITY: '请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许三人聚智控制电脑，然后重新尝试',
    MAC_TARGET_GONE: '原目标应用已退出，请重新在目标输入框中呼出快捷搜索',
    MAC_FOCUS_FAILED: '未能恢复原目标应用焦点，请先点击目标输入框，再重新呼出快捷搜索',
    MAC_FOCUS_CHANGED: '粘贴前焦点已切换，为避免误输入已取消插入，请在目标输入框中重试',
    MAC_TIMEOUT: '恢复焦点或发送粘贴快捷键超时，请重新在目标输入框中呼出快捷搜索',
    MAC_SCRIPT_FAILED: 'macOS 自动插入脚本执行失败，请查看日志后重试',
    MAC_SCRIPT_SIGNAL: 'macOS 自动插入进程异常终止，请查看日志后重试',
    MAC_UNCONFIRMED: 'macOS 未确认粘贴操作，请重试'
});

function failureCode(error, stderr) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'MAC_SCRIPT_FAILED';
    if (error.killed && error.signal) return 'MAC_TIMEOUT';
    if (error.signal) return 'MAC_SCRIPT_SIGNAL';
    // execFile 的 error.message 带完整命令，其中脚本源码本身就包含全部错误标记。
    // 只接受 stderr 的完整错误行；不能在命令或源码中搜索关键字来判断权限。
    const match = String(stderr || '').match(/^(?:execution error:[ \t]*(?:Error:[ \t]*)*)?(MAC_ACCESSIBILITY|MAC_TARGET_GONE|MAC_FOCUS_FAILED|MAC_FOCUS_CHANGED)(?:[ \t]*\(-?\d+\))?[ \t]*\r?$/m);
    return match ? match[1] : 'MAC_SCRIPT_FAILED';
}

class MacTextInsertion {
    constructor({ runSync = execFileSync, run = execFile, ownPid = process.pid, onDiagnostic = () => {} } = {}) {
        this.runSync = runSync;
        this.run = run;
        this.ownPid = ownPid;
        this.targetPid = null;
        this.isInserting = false;
        this.onDiagnostic = onDiagnostic;
    }

    failure(code, pid, mode, error = {}, stderr = '') {
        const nativeCode = String(stderr || '').match(/\((-?\d{1,10})\)\s*$/);
        // 不保留 error.message、原始 stderr、脚本、片段标题或正文，只记录固定字段。
        const diagnostic = {
            code, operation: mode === 'paste' ? 'paste' : 'focus',
            targetPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
            exitCode: Number.isInteger(error.code) ? error.code : null,
            signal: /^SIG[A-Z0-9]{1,16}$/.test(error.signal || '') ? error.signal : null,
            nativeCode: nativeCode ? Number(nativeCode[1]) : null
        };
        try { Promise.resolve(this.onDiagnostic({ ...diagnostic })).catch(() => {}); } catch (_) { /* 日志失败不改变插入结果。 */ }
        const failure = new Error(FAILURE_MESSAGES[code] + (mode === 'paste' ? '；内容已复制，可按 Command+V 粘贴。' : '。'));
        failure.code = code;
        failure.diagnostic = diagnostic;
        return failure;
    }

    capture() {
        // 必须在搜索窗口显示前完成采样；失败清空旧目标，避免误投上一次的应用。
        this.targetPid = null;
        try {
            const output = String(this.runSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CAPTURE_SCRIPT], {
                encoding: 'utf8', timeout: 2000, maxBuffer: 4096, windowsHide: true
            })).trim();
            const pid = Number(output);
            if (/^[1-9]\d*$/.test(output) && Number.isSafeInteger(pid) && pid !== this.ownPid) this.targetPid = pid;
        } catch (_) { /* 无有效目标时由主动插入操作反馈，不在呼出搜索时弹窗。 */ }
        return this.targetPid;
    }

    async action(pid, mode) {
        if (!pid) throw new Error('没有可恢复的目标应用，请先在目标输入框中呼出快捷搜索；内容已复制，可按 Command+V 粘贴。');
        const output = await new Promise((resolve, reject) => {
            this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACTION_SCRIPT, String(pid), mode], {
                encoding: 'utf8', timeout: 5000, maxBuffer: 8192, windowsHide: true
            }, (error, stdout, stderr) => {
                if (!error) return resolve(String(stdout).trim());
                reject(this.failure(failureCode(error, stderr), pid, mode, error, stderr));
            });
        });
        if (output !== (mode === 'paste' ? 'sent' : 'focused')) throw this.failure('MAC_UNCONFIRMED', pid, mode);
    }

    restore() {
        if (this.isInserting || !this.targetPid) return Promise.resolve();
        return this.action(this.targetPid, 'focus');
    }

    async insert(prepare) {
        if (this.isInserting) throw new Error('正在插入片段，请稍候。');
        const pid = this.targetPid;
        if (!pid) return this.action(pid, 'paste');
        this.isInserting = true;
        try {
            await prepare();
            await this.action(pid, 'paste');
        } finally {
            this.isInserting = false;
        }
    }
}

module.exports = { MacTextInsertion, CAPTURE_SCRIPT, ACTION_SCRIPT };
