const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');

test('共享模型更新按钮的隐藏 Electron 交互与未保存输入保护', async () => {
    const parent = fs.realpathSync(os.tmpdir());
    const temporary = fs.mkdtempSync(path.join(parent, 'sanrenjz-catalog-'));
    fs.mkdirSync(path.join(temporary, 'userData'));
    fs.mkdirSync(path.join(temporary, 'appData'));
    const runtimeRoot = process.env.AI_CATALOG_RUNTIME_DIR || path.resolve(__dirname, '../app/plugin_runtime');
    const script = pathToFileURL(path.join(runtimeRoot, 'ai-provider-manager.js')).href;
    fs.writeFileSync(path.join(temporary, 'catalog.html'), `<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}#drawer{width:100%;padding:16px}</style><div id="overlay"></div><div id="drawer"></div><script src="${script}"></script>`);
    try {
        const result = await new Promise(resolve => {
            const env = { ...process.env, APPDATA: path.join(temporary, 'appData'), AI_CATALOG_TEST_ROOT: temporary };
            delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
            const child = spawn(require('electron'), [path.join(__dirname, 'ai-provider-catalog-electron.cjs')], {
                env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
            });
            let log = '', spawnError;
            for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString('utf8'); });
            child.once('error', error => { spawnError = error; });
            child.once('close', code => resolve({ code, log, spawnError }));
        });
        assert.ifError(result.spawnError);
        assert.equal(result.code, 0, result.log);
        assert.match(result.log, /AI 供应商更新模型 Electron 交互验证通过/);
    } finally {
        assert.equal(path.dirname(path.resolve(temporary)), parent);
        assert(path.basename(temporary).startsWith('sanrenjz-catalog-'));
        assert(!fs.lstatSync(temporary).isSymbolicLink());
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});
