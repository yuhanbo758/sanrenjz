const { execFile, execFileSync } = require('child_process');

const CAPTURE_SCRIPT = `
ObjC.import('AppKit');
String($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
`;

// 只传进程 ID，片段正文始终留在剪贴板，不拼接进脚本或命令行。
const ACTION_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
function run(argv) {
    var pid = Number(argv[0]);
    var paste = argv[1] === 'paste';
    if (paste && !$.AXIsProcessTrusted()) throw new Error('MAC_ACCESSIBILITY');
    var target = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (!target || target.isNil() || target.terminated) throw new Error('MAC_TARGET_GONE');
    if (!target.activateWithOptions(2)) throw new Error('MAC_FOCUS_FAILED');
    var ready = false;
    for (var attempt = 0; attempt < 30; attempt++) {
        if ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier === pid) {
            ready = true;
            break;
        }
        $.NSThread.sleepForTimeInterval(0.05);
    }
    if (!ready) throw new Error('MAC_FOCUS_FAILED');
    if (!paste) return 'focused';
    $.NSThread.sleepForTimeInterval(0.12);
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

class MacTextInsertion {
    constructor({ runSync = execFileSync, run = execFile, ownPid = process.pid } = {}) {
        this.runSync = runSync;
        this.run = run;
        this.ownPid = ownPid;
        this.targetPid = null;
        this.isInserting = false;
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
                const detail = String(stderr || '') + String(error.message || '');
                if (detail.includes('MAC_ACCESSIBILITY')) return reject(new Error('请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许三人聚智控制电脑，然后重新尝试；内容已复制，可按 Command+V 粘贴。'));
                if (detail.includes('MAC_TARGET_GONE')) return reject(new Error('原目标应用已退出，请重新在目标输入框中呼出快捷搜索；内容已复制。'));
                reject(new Error('未能恢复目标应用焦点或发送粘贴快捷键，请重试；内容已复制，可按 Command+V 粘贴。'));
            });
        });
        if (output !== (mode === 'paste' ? 'sent' : 'focused')) throw new Error('macOS 未确认粘贴操作，内容已复制，可按 Command+V 粘贴。');
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
