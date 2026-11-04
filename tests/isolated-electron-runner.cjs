const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const testFile = path.resolve(root, process.argv[2] || '');
const allowed = new Set(['plugin-management-electron.test.js', 'electron-plugin-smoke.js']);
if (path.dirname(testFile) !== __dirname || !allowed.has(path.basename(testFile))) throw new Error('请选择受支持的隔离 Electron 验收脚本');
const logFile = path.join(root, 'dist', `legacy-${path.basename(testFile)}.log`);
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const log = fs.createWriteStream(logFile, { flags: 'w' });
const env = { ...process.env, SANRENJZ_TEST_HIDDEN: '1' };
delete env.ELECTRON_RUN_AS_NODE;
// Windows GUI 程序从 PowerShell 调用可能提前返回；Node close 才代表测试真正结束。
const child = spawn(require('electron'), [testFile], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
let timedOut = false;
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log.write(chunk); tail = (tail + chunk.toString('utf8')).slice(-16000); });
const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    else child.kill('SIGKILL');
}, 180000);
child.on('error', error => {
    clearTimeout(timer);
    log.end(error.stack || error.message);
    console.error(error.message);
    process.exitCode = 1;
});
child.on('close', (code, signal) => {
    clearTimeout(timer);
    log.end();
    const exitCode = timedOut ? 124 : (code === null ? 1 : code);
    console.log(tail.split(/\r?\n/).filter(Boolean).slice(-26).join('\n'));
    console.log(JSON.stringify({ test: path.basename(testFile), exitCode, signal, timedOut, logFile }));
    process.exitCode = exitCode;
});
