const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createMergedHost } = require('../app/merged-host');

function fixture(t, initial = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-config-location-'));
    const profile = path.join(root, 'profile');
    const toolsDir = path.join(root, 'app', 'software');
    fs.mkdirSync(profile);
    fs.mkdirSync(toolsDir, { recursive: true });
    const settingsFile = path.join(profile, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ pythonMode: 'none', unrelated: '保留', ...initial }), 'utf8');
    const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const selected = [], opened = [];
    let failSave = false, openError = '', failRefresh = false, pythonActions = 0;
    const build = () => {
        const handlers = new Map();
        const host = createMergedHost({
            app: { isPackaged: false, getPath: () => profile }, appRoot: root,
            ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
            dialog: { showOpenDialog: async () => selected.shift() || { canceled: true, filePaths: [] } },
            shell: { openPath: async directory => { opened.push(directory); return openError; } },
            getWindow: () => null, getManager: () => ({ pluginDir: toolsDir, getPluginList: async () => [] }),
            loadSettings: read,
            saveSettings: value => {
                if (failSave) throw new Error('模拟设置写入失败');
                fs.writeFileSync(settingsFile, JSON.stringify({ ...read(), ...value }), 'utf8');
            },
            refresh: async () => { if (failRefresh) throw new Error('模拟列表刷新失败'); }, send: () => {}
        });
        for (const action of ['inspect', 'resolve', 'discover', 'install']) host.environment[action] = () => {
            pythonActions++; throw new Error('目录管理不得操作 Python');
        };
        host.python.run = () => { pythonActions++; throw new Error('目录管理不得启动插件'); };
        const invoke = (name, ...args) => handlers.get(name)({}, ...args);
        return { host, invoke };
    };
    const active = build();
    t.after(async () => {
        await active.host.python.shutdown();
        assert(path.relative(path.resolve(os.tmpdir()), root).startsWith('sanrenjz-config-location-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, profile, toolsDir, read, build, selected, opened, ...active,
        get pythonActions() { return pythonActions; },
        set failSave(value) { failSave = value; },
        set openError(value) { openError = value; },
        set failRefresh(value) { failRefresh = value; }
    };
}

test('配置目录读取不初始化配置或 Python；旧别名按实际运行规则读取', async t => {
    const f = fixture(t);
    const initial = await f.invoke('python:config-location');
    assert.deepEqual(initial, { path: path.join(f.profile, 'python-plugin-configs'), defaultPath: path.join(f.profile, 'python-plugin-configs'), custom: false });
    assert.equal(fs.existsSync(initial.path), false);
    assert.equal(f.pythonActions, 0);

    const old = path.join(f.root, '旧配置 目录');
    fs.writeFileSync(path.join(f.profile, 'settings.json'), JSON.stringify({ pythonMode: 'none', pythonPluginConfigDir: old, customPluginConfigDir: path.join(f.root, '被旧键遮蔽') }));
    assert.equal((await f.invoke('python:config-location')).path, old);
    assert.equal(f.host.python._configRoot(), old);
    assert.equal(fs.existsSync(old), false);
});

test('选择与重启读回一致；迁移只复制缺少项，别名和默认恢复保持一致', async t => {
    const f = fixture(t);
    const initial = await f.invoke('python:config-location');
    fs.mkdirSync(initial.path);
    fs.writeFileSync(path.join(initial.path, 'existing.json'), '{"原目录":"内容"}\n', 'utf8');
    fs.writeFileSync(path.join(initial.path, 'missing.json'), '{"中文":"配置原字节"}\n', 'utf8');
    const target = path.join(f.root, '用户选择 配置');
    fs.mkdirSync(target);
    const preserved = '{"用户":"目标优先"}\n';
    fs.writeFileSync(path.join(target, 'existing.json'), preserved, 'utf8');
    f.selected.push({ canceled: false, filePaths: [target] });
    const selected = await f.invoke('python:config-directory');
    assert.equal(selected.success, true);
    assert.equal(selected.path, target);
    assert.equal(selected.custom, true);
    assert.deepEqual(selected.copied, ['missing.json']);
    assert.equal(fs.readFileSync(path.join(target, 'existing.json'), 'utf8'), preserved);
    assert.equal(fs.readFileSync(path.join(target, 'missing.json'), 'utf8'), '{"中文":"配置原字节"}\n');
    assert.equal(f.read().customPluginConfigDir, target);
    assert.equal(f.read().pythonPluginConfigDir, target);
    assert.equal(f.read().unrelated, '保留');
    const restarted = f.build();
    assert.equal((await restarted.invoke('python:config-location')).path, target);
    assert.equal(restarted.host.python._configRoot(), target);
    fs.writeFileSync(path.join(target, 'new.json'), '{"新":"配置"}', 'utf8');
    const reset = await f.invoke('python:config-reset');
    assert.equal(reset.success, true);
    assert.equal(reset.custom, false);
    assert.equal(reset.path, initial.defaultPath);
    assert.equal(f.read().customPluginConfigDir, '');
    assert.equal(f.read().pythonPluginConfigDir, '');
    assert.equal(fs.readFileSync(path.join(initial.path, 'existing.json'), 'utf8'), '{"原目录":"内容"}\n');
    assert.equal(fs.readFileSync(path.join(initial.path, 'new.json'), 'utf8'), '{"新":"配置"}');
    assert.equal(fs.readFileSync(path.join(target, 'existing.json'), 'utf8'), preserved, '旧目录保留原字节');
    assert.equal((await restarted.invoke('python:config-location')).path, initial.path);
    assert.equal(f.pythonActions, 0);
    await restarted.host.python.shutdown();
});

test('旧别名来源迁移正确；取消、复制失败和保存失败不改变原选择', async t => {
    const f = fixture(t);
    const old = path.join(f.root, '旧别名配置');
    fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'keep.json'), '{"旧键":"必须迁移"}', 'utf8');
    fs.writeFileSync(path.join(f.profile, 'settings.json'), JSON.stringify({ pythonMode: 'none', pythonPluginConfigDir: old, customPluginConfigDir: path.join(f.root, '过时配置键') }));
    assert.deepEqual(await f.invoke('python:config-directory'), { canceled: true });
    assert.equal((await f.invoke('python:config-location')).path, old);

    const target = path.join(f.root, '新目录');
    const originalCopy = fs.copyFileSync;
    fs.copyFileSync = () => { throw new Error('模拟复制失败'); };
    try {
        f.selected.push({ canceled: false, filePaths: [target] });
        assert.equal((await f.invoke('python:config-directory')).success, false);
    } finally { fs.copyFileSync = originalCopy; }
    assert.equal((await f.invoke('python:config-location')).path, old);
    assert.equal(fs.readFileSync(path.join(old, 'keep.json'), 'utf8'), '{"旧键":"必须迁移"}');

    f.failSave = true;
    f.selected.push({ canceled: false, filePaths: [target] });
    const failed = await f.invoke('python:config-directory');
    assert.equal(failed.success, false);
    assert.match(failed.error, /写入失败/);
    assert.equal((await f.invoke('python:config-location')).path, old);
    f.failSave = false;
    f.selected.push({ canceled: false, filePaths: [target] });
    assert.equal((await f.invoke('python:config-directory')).success, true);
    assert.equal(fs.readFileSync(path.join(target, 'keep.json'), 'utf8'), '{"旧键":"必须迁移"}');
    assert.equal(f.host.python._configRoot(), target);
});

test('配置目录与两类程序目录不能互相包含，目录联接不能绕过检查', async t => {
    const f = fixture(t);
    const pythonDir = f.host.python.pluginDir;
    const original = await f.invoke('python:config-location');
    for (const target of [f.toolsDir, path.join(f.toolsDir, '配置'), pythonDir, path.join(pythonDir, '配置'), f.root]) {
        f.selected.push({ canceled: false, filePaths: [target] });
        const result = await f.invoke('python:config-directory');
        assert.equal(result.success, false, target);
        assert.match(result.error, /不能.*插件程序目录/);
    }
    const linked = path.join(f.root, '指向插件的联接');
    try { fs.symlinkSync(pythonDir, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; return; }
    f.selected.push({ canceled: false, filePaths: [path.join(linked, '配置')] });
    assert.equal((await f.invoke('python:config-directory')).success, false);
    assert.equal((await f.invoke('python:config-location')).path, original.path);
});

test('Git 跟踪目录和运行中变更被拒绝；打开仅作用于实际目录并明确返回错误', async t => {
    const f = fixture(t);
    const tracked = path.join(f.root, 'tracked');
    fs.mkdirSync(tracked);
    assert.equal(spawnSync('git', ['init', tracked], { windowsHide: true }).status, 0);
    fs.writeFileSync(path.join(tracked, 'tracked.json'), '{}');
    assert.equal(spawnSync('git', ['-C', tracked, 'add', 'tracked.json'], { windowsHide: true }).status, 0);
    f.selected.push({ canceled: false, filePaths: [tracked] });
    const rejected = await f.invoke('python:config-directory');
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /Git/);

    const target = path.join(f.root, '运行中禁止改动');
    f.host.python.pending.add('python:test.py');
    f.selected.push({ canceled: false, filePaths: [target] });
    assert.equal((await f.invoke('python:config-directory')).success, false);
    assert.equal((await f.invoke('python:config-reset')).success, false);
    assert.equal(fs.existsSync(target), false);
    f.host.python.pending.clear();
    const current = await f.invoke('python:config-location');
    assert.equal((await f.invoke('python:config-open')).success, true);
    assert.deepEqual(f.opened, [current.path]);
    assert.equal(fs.existsSync(path.join(current.path, '.gitignore')), true);
    f.openError = '模拟文件管理器失败';
    const failed = await f.invoke('python:config-open');
    assert.equal(failed.success, false);
    assert.match(failed.error, /文件管理器失败/);
    assert.equal(f.pythonActions, 0);
});

test('配置保存成功后的刷新失败只返回警告，不误报变更失败', async t => {
    const f = fixture(t);
    const target = path.join(f.root, '保存后刷新失败');
    f.failRefresh = true;
    f.selected.push({ canceled: false, filePaths: [target] });
    const result = await f.invoke('python:config-directory');
    assert.equal(result.success, true);
    assert.match(result.warning, /已保存.*刷新失败/);
    assert.equal((await f.invoke('python:config-location')).path, target);
    assert.equal(f.read().customPluginConfigDir, target);
});
