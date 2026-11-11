const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removePluginPath, isUninstalled, assertPluginAvailable } = require('../app/plugin-uninstall');
const { initializePluginStore } = require('../app/plugin_store');
const { PythonManager } = require('../app/python-manager');
const { createMergedHost } = require('../app/merged-host');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-uninstall-'));
    const plugins = path.join(root, 'plugins');
    fs.mkdirSync(plugins);
    t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    return { root, plugins };
}
function tool(root, name = '中文插件') {
    const directory = path.join(root, '中文 插件');
    fs.mkdirSync(path.join(directory, '.runtime'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: name }));
    fs.writeFileSync(path.join(directory, '.runtime', 'cache.txt'), 'cache');
    return directory;
}

test('删除完整目录与运行资料，保留独立数据；内置插件重启不复活，主动重装仍可更新', async t => {
    const { root, plugins } = fixture(t);
    const target = tool(plugins);
    const data = path.join(root, 'config.json'); fs.writeFileSync(data, '保留');
    await removePluginPath(plugins, target, 'tools:中文插件');
    assert(!fs.existsSync(target));
    assert.equal(fs.readFileSync(data, 'utf8'), '保留');
    assert(isUninstalled(plugins, 'tools:中文插件'));
    const bundled = path.join(root, 'bundled'); fs.mkdirSync(bundled); tool(bundled);
    assert.equal(initializePluginStore({ bundledDir: bundled, persistentDir: plugins }).added.length, 0);
    tool(plugins);
    assert.equal(initializePluginStore({ bundledDir: bundled, persistentDir: plugins }).preserved.length, 1);
});

test('拒绝根目录、相似前缀、外部路径和目录联接，不删除外部文件', async t => {
    const { root, plugins } = fixture(t);
    const outside = path.join(root, 'plugins-other'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    const link = path.join(plugins, 'link'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const target of [plugins, root, outside, link]) await assert.rejects(removePluginPath(plugins, target, 'invalid'), /不能卸载/);
    assert(fs.existsSync(path.join(outside, 'keep')));
});

test('删除失败返回错误；卸载记录写入失败时保留插件', async t => {
    const { plugins } = fixture(t);
    const target = tool(plugins);
    const original = fs.promises.rm;
    fs.promises.rm = async () => { throw new Error('模拟文件占用'); };
    try { await assert.rejects(removePluginPath(plugins, target, 'tools:中文插件'), /文件占用/); }
    finally { fs.promises.rm = original; }
    assert(fs.existsSync(target));
    fs.rmSync(path.join(plugins, '.uninstalled'), { recursive: true });
    fs.writeFileSync(path.join(plugins, '.uninstalled'), '阻止创建记录');
    await assert.rejects(removePluginPath(plugins, target, 'tools:中文插件'));
    assert(fs.existsSync(target));
});

test('删除期间阻止重复卸载与重新启动，结束后释放锁', async t => {
    const { plugins } = fixture(t);
    const target = tool(plugins);
    const original = fs.promises.rm;
    let release;
    fs.promises.rm = () => new Promise(resolve => { release = resolve; });
    try {
        const pending = removePluginPath(plugins, target, 'tools:中文插件');
        assert.throws(() => assertPluginAvailable(path.join(target, 'index.html')), /正在卸载/);
        await assert.rejects(removePluginPath(plugins, target, 'tools:中文插件'), /正在卸载/);
        release(); await pending;
        assert.doesNotThrow(() => assertPluginAvailable(target));
    } finally { fs.promises.rm = original; }
});

test('Python 同目录多个入口运行或启动中均拒绝卸载；独立脚本只删除自身', async t => {
    const { root, plugins } = fixture(t);
    const folder = path.join(plugins, '多入口'); fs.mkdirSync(folder);
    for (const name of ['a.py', 'b.py']) fs.writeFileSync(path.join(folder, name), '# test');
    const manager = new PythonManager({ pluginDir: plugins, userData: root, appRoot: root, loadSettings: () => ({}), environment: {} });
    const id = 'python:多入口/a.py', sibling = 'python:多入口/b.py';
    manager.pending.add(sibling);
    await assert.rejects(manager.remove(id), /先停止/);
    manager.pending.clear(); manager.running.set(sibling, {});
    await assert.rejects(manager.remove(id), /先停止/);
    manager.running.clear(); await manager.remove(id);
    assert(!fs.existsSync(folder));
    assert(isUninstalled(plugins, 'python:多入口'));
    fs.writeFileSync(path.join(plugins, 'one.py'), '# test');
    fs.writeFileSync(path.join(plugins, 'two.py'), '# test');
    await manager.remove('python:one.py');
    assert(!fs.existsSync(path.join(plugins, 'one.py')));
    assert(fs.existsSync(path.join(plugins, 'two.py')));
});

test('安装态 Python 插件卸载后重新初始化宿主，不再自动补齐；其他内置插件正常补齐', async t => {
    const { root, plugins } = fixture(t);
    const resources = path.join(root, 'resources');
    const bundled = path.join(resources, 'app', 'python-software');
    for (const name of ['removed', 'retained']) {
        const folder = path.join(bundled, name); fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'main.py'), '# fixture');
    }
    const original = process.resourcesPath;
    process.resourcesPath = resources;
    try {
        const app = { isPackaged: true, getPath: () => path.join(root, 'profile') };
        const initialize = () => createMergedHost({ app, appRoot: root, ipcMain: { handle() {} }, dialog: {}, shell: {},
            getWindow: () => null, getManager: () => ({ pluginDir: plugins }), loadSettings: () => ({}), saveSettings() {}, refresh: async () => {}, send() {} });
        const host = initialize();
        assert(fs.existsSync(path.join(root, 'python-plugins', 'removed')));
        await host.python.remove('python:removed/main.py');
        initialize();
        assert(!fs.existsSync(path.join(root, 'python-plugins', 'removed')));
        assert(fs.existsSync(path.join(root, 'python-plugins', 'retained')));
    } finally {
        if (original === undefined) delete process.resourcesPath;
        else process.resourcesPath = original;
    }
});
