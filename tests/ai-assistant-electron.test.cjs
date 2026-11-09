const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
test('真实助手页面的 OpenAI、排序与搜索选择回归', async () => {
    const parent = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(parent, 'sanrenjz-assistant-'));
    for (const dir of ['userData', 'appData']) fs.mkdirSync(path.join(root, dir));
    try {
        const result = await new Promise(resolve => {
            const env = { ...process.env, APPDATA: path.join(root, 'appData'), AI_ASSISTANT_TEST_ROOT: root };
            delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
            const child = spawn(require('electron'), [path.join(__dirname, 'ai-assistant-electron.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            let log = '', spawnError;
            for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString('utf8'); });
            child.once('error', error => { spawnError = error; });
            child.once('close', code => resolve({ code, log, spawnError }));
        });
        assert.ifError(result.spawnError); assert.equal(result.code, 0, result.log);
        assert.match(result.log, /AI 助手 OpenAI 直连、排序和模型搜索验收通过/);
    } finally {
        assert.equal(path.dirname(path.resolve(root)), parent);
        assert(path.basename(root).startsWith('sanrenjz-assistant-') && !fs.lstatSync(root).isSymbolicLink());
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});
