const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { MacPluginDock } = require('../app/plugin_runtime/mac-dock');
const { resolvePluginVisual } = require('../app/python-support/plugin_visual');

function fixture(t, platform = 'darwin') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-dock-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const helper = path.join(root, 'helper'); fs.writeFileSync(helper, 'test-helper');
    const children = [];
    const dock = new MacPluginDock({ runtimeRoot: path.join(root, 'runtime'), helperPath: helper, platform,
        spawnProcess(executable, args) {
            const child = new EventEmitter();
            child.executable = executable; child.args = args;
            child.stdin = new PassThrough(); child.stdout = new PassThrough();
            child.exitCode = null; child.kill = () => { child.exitCode = -1; child.emit('close', -1); };
            children.push(child); return child;
        }
    });
    t.after(() => dock.dispose());
    return { root, dock, children };
}

test('Mac/Linux 元数据指向 ICO 时也优先 PNG，只有 ICO 时回退宿主；不写插件资源', t => {
    const { root } = fixture(t);
    fs.writeFileSync(path.join(root, 'logo.ico'), 'ico');
    const fallback = path.join(root, 'host.png'); fs.writeFileSync(fallback, 'host');
    const options = { folderPath: root, settings: { logo: 'logo.ico' }, defaultLogoPath: fallback };
    for (const platform of ['darwin', 'linux']) {
        assert.equal(resolvePluginVisual({ ...options, platform }).logoPath, fallback);
        assert.equal(resolvePluginVisual({ ...options, platform }).macIconPath, path.join(root, 'logo.ico'));
    }
    fs.writeFileSync(path.join(root, 'logo.png'), 'png');
    for (const platform of ['darwin', 'linux']) assert.equal(resolvePluginVisual({ ...options, platform }).logoPath, path.join(root, 'logo.png'));
    assert.equal(resolvePluginVisual({ ...options, platform: 'win32' }).logoPath, path.join(root, 'logo.ico'));
    const before = fs.readdirSync(root);
    resolvePluginVisual({ ...options, platform: 'darwin' });
    assert.deepEqual(fs.readdirSync(root), before);
});

test('多个钉住插件各有稳定应用身份，点击只聚焦对应窗口，关闭/取消后忽略过期信号', t => {
    const { dock, children } = fixture(t);
    const actions = [];
    // Windows 文件系统不接受尖括号；Mac 继续覆盖原始名称的完整 XML 转义。
    for (const id of ['tools:a', 'tools:b']) dock.pin({ id, name: process.platform === 'win32' ? `名称 & ${id}` : `名称 & <${id}>`, icon: '/image.png', focus: () => actions.push(id), close: () => dock.unpin(id) });
    assert.equal(children.length, 2);
    const plists = children.map(child => fs.readFileSync(path.join(child.executable, '..', '..', 'Info.plist'), 'utf8'));
    assert.notEqual(plists[0].match(/com\.sanrenjz\.dock\.\w+/)[0], plists[1].match(/com\.sanrenjz\.dock\.\w+/)[0]);
    assert.match(plists[0], /&amp;/);
    if (process.platform !== 'win32') assert.match(plists[0], /&amp; &lt;/);
    children[0].stdout.write('fo'); children[0].stdout.write('cus\n');
    assert.deepEqual(actions, ['tools:a']);
    children[1].stdout.write('close\n');
    assert.equal(dock.entries.has('tools:b'), false);
    assert.equal(children[1].stdin.writableEnded, true);
    children[1].stdout.write('focus\n');
    assert.deepEqual(actions, ['tools:a']);
    dock.dispose(); assert.equal(dock.entries.size, 0);
});

test('Windows 不创建辅助应用；重复钉住不启动第二个进程', t => {
    const win = fixture(t, 'win32');
    win.dock.pin({ id: 'a' }); assert.equal(win.children.length, 0);
    const mac = fixture(t);
    const item = { id: 'a', name: 'a', focus() {}, close() {} };
    mac.dock.pin(item); mac.dock.pin(item); assert.equal(mac.children.length, 1);
});
