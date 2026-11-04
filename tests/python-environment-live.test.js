const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const { PythonEnvironment } = require('../app/python-environment');

test('official PythonCore archive installs and creates a hidden Tk window in an isolated app directory', {
    skip: process.env.SANRENJZ_PYTHON_LIVE !== '1' || process.platform !== 'win32' || process.arch !== 'x64',
    timeout: 240000
}, async t => {
    const runtimeRoot = path.resolve(__dirname, '..', 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const appRoot = fs.mkdtempSync(path.join(runtimeRoot, '.python-env-acceptance-'));
    // 只删除本次测试创建的隔离目录，绝不触及实际应用的解释器与设置。
    t.after(() => {
        const relative = path.relative(runtimeRoot, appRoot);
        assert.ok(relative.startsWith('.python-env-acceptance-') && !relative.includes(path.sep));
        if (process.env.SANRENJZ_PYTHON_LIVE_KEEP === '1') console.log(`[python-live] retained appRoot: ${appRoot}`);
        else fs.rmSync(appRoot, { recursive: true, force: true });
    });
    let settings = { pluginPreferences: { preserved: true } };
    let lastPhase;
    const environment = new PythonEnvironment({
        appRoot, userData: path.join(appRoot, 'user-data'),
        loadSettings: () => settings,
        saveSettings: value => { settings = value; },
        onProgress: event => {
            if (event.phase !== lastPhase) {
                lastPhase = event.phase;
                console.log(`[python-live] ${event.phase}: ${event.message}`);
            }
        }
    });
    const installed = await environment.install();
    assert.equal(installed.version, '3.14.10');
    assert.equal(installed.mode, 'managed');
    assert.equal(installed.pip, true);
    assert.equal(installed.tkWindow, true);
    assert.equal(installed.ssl, true);
    assert.equal(installed.venv, true);
    assert.deepEqual(settings.pluginPreferences, { preserved: true });
    const resolved = await environment.resolve();
    assert.equal(resolved.executable, installed.executable);
    const inspected = await environment.inspect(installed.executable, { hiddenTk: true });
    assert.equal(inspected.tkWindow, true);
    const reused = await environment.install();
    assert.equal(reused.executable, installed.executable);
});
