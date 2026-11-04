'use strict';

// 低层钩子只能入队；管道写入可能等待 Electron，必须由独立线程处理。
const hookOutputSource = `
public static class SanrenjzHookOutput {
    private static readonly System.Collections.Concurrent.ConcurrentQueue<string> pending =
        new System.Collections.Concurrent.ConcurrentQueue<string>();
    private static readonly System.Threading.AutoResetEvent ready = new System.Threading.AutoResetEvent(false);
    private static int count;
    private static int overflow;

    public static void Start() {
        var writer = new System.Threading.Thread(WriteLoop);
        writer.IsBackground = true;
        writer.Start();
        // 父进程或插件窗口退出后 stdin 关闭，避免留下系统级监听进程。
        var lifetime = new System.Threading.Thread(() => {
            try { while (System.Console.ReadLine() != null) {} } catch {}
            System.Environment.Exit(0);
        });
        lifetime.IsBackground = true;
        lifetime.Start();
    }

    public static void TryWrite(string line) {
        if (System.Threading.Interlocked.Increment(ref count) > 256) {
            System.Threading.Interlocked.Decrement(ref count);
            System.Threading.Interlocked.Exchange(ref overflow, 1);
            return;
        }
        pending.Enqueue(line);
        ready.Set();
    }

    private static void WriteLoop() {
        while (true) {
            ready.WaitOne();
            string line;
            while (!pending.IsEmpty || System.Threading.Volatile.Read(ref overflow) != 0) {
                if (System.Threading.Interlocked.Exchange(ref overflow, 0) != 0) {
                    // 消费端长时间阻塞时丢弃过期事件，并让录音端复位，避免遗失 UP 后一直录音。
                    while (pending.TryDequeue(out line)) System.Threading.Interlocked.Decrement(ref count);
                    line = "HOOK_OUTPUT_OVERFLOW";
                } else {
                    if (!pending.TryDequeue(out line)) continue;
                    System.Threading.Interlocked.Decrement(ref count);
                }
                try { System.Console.WriteLine(line); System.Console.Out.Flush(); }
                catch { System.Environment.Exit(0); }
            }
        }
    }
}
`;

module.exports = { hookOutputSource };
