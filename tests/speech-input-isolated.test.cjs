const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('语音输入法共享转写配置及工作台的隐藏 Electron 回归', async () => {
    const parent = fs.realpathSync(os.tmpdir());
    const temporary = fs.mkdtempSync(path.join(parent, 'sanrenjz-speech-'));
    fs.mkdirSync(path.join(temporary, 'userData'));
    fs.mkdirSync(path.join(temporary, 'appData'));
    try {
        const result = await new Promise(resolve => {
            const env = { ...process.env, APPDATA: path.join(temporary, 'appData'), SPEECH_INPUT_TEST_ROOT: temporary };
            delete env.ELECTRON_RUN_AS_NODE;
            delete env.NODE_OPTIONS;
            const child = spawn(require('electron'), [path.join(__dirname, 'speech-input-electron.test.js')], {
                env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
            });
            let log = '', spawnError;
            for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString('utf8'); });
            child.once('error', error => { spawnError = error; });
            child.once('close', code => resolve({ code, log, spawnError }));
        });
        assert.ifError(result.spawnError);
        assert.equal(result.code, 0, result.log);
        assert.match(result.log, /AI 语音输入法 Electron 工作台交互测试通过/);
    } finally {
        // 父进程等原生 Electron 退出后，核验临时目录归属再清理。
        assert.equal(path.dirname(path.resolve(temporary)), parent);
        assert(path.basename(temporary).startsWith('sanrenjz-speech-'));
        assert(!fs.lstatSync(temporary).isSymbolicLink());
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});
