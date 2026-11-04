const path = require('path');
const { spawn } = require('child_process');
const { setupConsoleEncoding } = require('../app/console-encoding');

function startApp({
    args = process.argv.slice(2),
    executable,
    cwd = path.resolve(__dirname, '..'),
    spawnImpl = spawn,
    setupEncoding = setupConsoleEncoding,
    processObject = process
} = {}) {
    setupEncoding();
    const electron = executable || require('electron');
    return new Promise((resolve, reject) => {
        let child;
        try {
            // 直接继承字节流，不在启动器里把原生程序输出再次解码或转换。
            child = spawnImpl(electron, ['.', ...args], { cwd, stdio: 'inherit', windowsHide: false });
        } catch (error) { reject(error); return; }
        const handlers = new Map();
        const cleanup = () => {
            for (const [signal, handler] of handlers) processObject.removeListener(signal, handler);
        };
        for (const signal of ['SIGINT', 'SIGTERM']) {
            const handler = () => { if (!child.killed) child.kill(signal); };
            handlers.set(signal, handler);
            processObject.on(signal, handler);
        }
        child.once('error', error => { cleanup(); reject(error); });
        child.once('close', (code, signal) => { cleanup(); resolve({ code: code === null ? null : code, signal: signal || null }); });
    });
}

if (require.main === module) {
    startApp().then(({ code, signal }) => {
        if (signal) process.kill(process.pid, signal);
        else process.exitCode = code === null ? 1 : code;
    }).catch(error => {
        console.error(`启动三人聚智失败：${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { startApp };
