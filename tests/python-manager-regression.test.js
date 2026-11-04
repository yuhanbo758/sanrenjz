const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PythonManager } = require('../app/python-manager');

const probe = spawnSync(process.env.SANRENJZ_ACCEPTANCE_PYTHON || 'python', ['-B', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
const python = probe.status === 0 ? probe.stdout.trim() : '';
async function until(predicate) {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('等待隔离 Python 运行结束超时');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}
function fixture(t, script) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-python-regression-'));
    const source = path.join(root, '源 程序'); fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ name: '隔离运行回归', main_file: 'main.py' }));
    fs.writeFileSync(path.join(source, 'main.py'), script);
    const manager = new PythonManager({ pluginDir: path.join(root, 'plugins'), userData: path.join(root, 'profile'), appRoot: root,
        environment: { resolve: async () => ({ executable: python, pip: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' } }) }
    });
    t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, source, manager };
}

test('真实 UTF-8 分块输出完整还原中文和 emoji，跨块敏感键仍脱敏', { skip: !python }, async t => {
    const script = `import os, time\nfor value in "中文🌟\\ntoken=isolated-secret-value\\n".encode("utf-8"):\n    os.write(1, bytes([value]))\n    time.sleep(0.012)\nos.write(2, "末尾无换行中文🌟".encode("utf-8"))\n`;
    const { source, manager } = fixture(t, script);
    const item = await manager.importPath(source);
    await manager.run(item.id);
    await until(() => manager.getLogs(item.id).some(row => /已退出/.test(row.message)));
    const stdout = manager.getLogs(item.id).filter(row => row.stream === 'stdout').map(row => row.message).join('');
    const stderr = manager.getLogs(item.id).filter(row => row.stream === 'stderr').map(row => row.message).join('');
    assert.match(stdout, /中文🌟/);
    assert.equal(stdout.includes('�'), false);
    assert.equal(stdout.includes('isolated-secret-value'), false);
    assert.match(stdout, /已隐藏/);
    assert.equal(stderr, '末尾无换行中文🌟');
});

test('运行与退出的刷新回调失败不会变成未处理拒绝或阻断管理器', { skip: !python }, async t => {
    const { source, manager } = fixture(t, 'print("isolated-runtime-ok", flush=True)\n');
    const item = await manager.importPath(source);
    manager.onChanged = async () => { throw new Error('隔离模拟目录刷新失败'); };
    manager.onLog = async () => { throw new Error('隔离模拟界面日志通知失败'); };
    const started = await manager.run(item.id);
    assert.equal(started.success, true);
    await until(() => manager.getLogs(item.id).some(row => /已退出/.test(row.message)));
    assert.equal(manager.running.size, 0);
    assert.equal(manager.pending.size, 0);
    assert(manager.getLogs(item.id).some(row => row.message.includes('isolated-runtime-ok')));
});

test('真实停止清理拥有的 Python 子树，关闭后不能再次启动', { skip: !python || process.platform !== 'win32' }, async t => {
    const { root, source, manager } = fixture(t, '');
    const marker = path.join(root, 'owned-processes.json');
    const script = `import subprocess, sys, pathlib, json, time\nchild=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"])\npathlib.Path(${JSON.stringify(marker)}).write_text(json.dumps({"child":child.pid}),encoding="utf-8")\nprint("owned-parent-ready", flush=True)\ntime.sleep(60)\n`;
    fs.writeFileSync(path.join(source, 'main.py'), script);
    const item = await manager.importPath(source);
    let ownedPid;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
    t.after(() => { if (ownedPid && alive(ownedPid)) spawnSync('taskkill.exe', ['/PID', String(ownedPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); });
    const started = await manager.run(item.id);
    await until(() => fs.existsSync(marker) && fs.statSync(marker).size > 0);
    ownedPid = JSON.parse(fs.readFileSync(marker, 'utf8')).child;
    assert(alive(started.pid) && alive(ownedPid));
    await manager.stop(item.id);
    await until(() => !alive(started.pid) && !alive(ownedPid));
    assert.equal(manager.running.size, 0);
    assert.equal(manager.pending.size, 0);
    await manager.shutdown();
    await assert.rejects(manager.run(item.id), { code: 'APP_CLOSING' });
});
