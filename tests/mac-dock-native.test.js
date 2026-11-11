const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { once } = require('events');
const { MacPluginDock } = require('../app/plugin_runtime/mac-dock');
const helperPath = path.resolve(__dirname, '../app/native/mac-dock-helper');
const waitFor = async predicate => {
    const until = Date.now() + 8000;
    while (!predicate()) {
        if (Date.now() > until) throw new Error('等待 Mac Dock 辅助进程超时');
        await new Promise(resolve => setTimeout(resolve, 50));
    }
};

test('真实 Mac Dock 多身份、点击激活、退出与宿主管道断开清理', { skip: process.platform !== 'darwin' || !fs.existsSync(helperPath) }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-native-dock-'));
    const errors = [], children = [], output = [], actions = [];
    const dock = new MacPluginDock({ runtimeRoot: root, helperPath, onError: error => errors.push(error),
        spawnProcess(executable, args, options) {
            const child = require('child_process').spawn(executable, args, options);
            children.push({ child, executable });
            child.stdout.on('data', chunk => output.push(`${child.pid}:${chunk}`));
            return child;
        }
    });
    t.after(async () => {
        const exits = children.filter(({ child }) => child.exitCode === null).map(({ child }) => once(child, 'close'));
        dock.dispose(); await Promise.all(exits);
        fs.rmSync(root, { recursive: true, force: true });
    });
    for (const [id, icon] of [['a', 'logo.png'], ['b', 'logo.ico']]) dock.pin({ id, name: `隔离 Dock ${id}`,
        icon: path.resolve(__dirname, '../app/software/sanrenjz-tools-text', icon),
        focus: () => actions.push(id), close: () => dock.unpin(id) });
    await waitFor(() => output.filter(line => line.includes('ready')).length === 2 || errors.length);
    assert.deepEqual(errors, []);
    // LaunchServices 读取真实运行应用身份；不访问辅助功能或运行插件业务。
    const states = children.map(({ child }) => {
        const probe = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit');var app=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid});JSON.stringify({id:ObjC.unwrap(app.bundleIdentifier),name:ObjC.unwrap(app.localizedName)})`], { encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr);
        return JSON.parse(probe.stdout);
    });
    assert.notEqual(states[0].id, states[1].id);
    assert.equal(states[0].name, '隔离 Dock a');
    const bundle = path.resolve(children[0].executable, '..', '..', '..');
    const opened = spawnSync('/usr/bin/open', ['-a', bundle], { encoding: 'utf8' });
    assert.equal(opened.status, 0, opened.stderr);
    await waitFor(() => actions.includes('a'));
    assert.deepEqual(actions, ['a']);
    const firstExit = once(children[0].child, 'close');
    dock.unpin('a');
    dock.pin({ id: 'a', name: '隔离 Dock a', icon: path.resolve(__dirname, '../app/software/sanrenjz-tools-text/logo.png'), focus() {}, close() {} });
    await firstExit;
    assert.equal(children[0].child.exitCode, 0);
    await waitFor(() => output.filter(line => line.includes('ready')).length === 3);
    // 模拟宿主退出/崩溃关闭管道；没有驻留孤儿辅助进程。
    const secondExit = once(children[1].child, 'close');
    children[1].child.stdin.end(); await secondExit;
    assert.equal(children[1].child.exitCode, 0);
});
