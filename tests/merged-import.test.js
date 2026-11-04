const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { zipSync, strToU8 } = require('fflate');
const { findRoots, extractZip, importTools } = require('../app/plugin-import');

test('ZIP 判型、路径穿越、清单冲突和效率插件替换', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-import-'));
    try {
        const archive = path.join(root, 'sample.zip'), extracted = path.join(root, 'extracted');
        fs.writeFileSync(archive, zipSync({ 'tool/plugin.json': strToU8(JSON.stringify({ pluginName: '示例', main: 'index.html' })), 'tool/index.html': strToU8('<p>safe</p>') }));
        extractZip(archive, extracted);
        assert.equal(findRoots(extracted)[0].engine, 'tools');
        const tools = path.join(root, 'tools'); fs.mkdirSync(tools);
        const manager = { getPluginList: async () => [], pluginWindows: new Map(), pluginProcesses: new Map() };
        const added = await importTools(path.join(extracted, 'tool'), { toolsDir: tools, manager });
        assert.equal(added.action, 'added');
        manager.getPluginList = async () => [{ name: '示例', path: added.path }];
        await assert.rejects(importTools(path.join(extracted, 'tool'), { toolsDir: tools, manager }), { code: 'PLUGIN_EXISTS' });
        manager.pluginWindows.set('示例', {});
        await assert.rejects(importTools(path.join(extracted, 'tool'), { toolsDir: tools, manager, overwrite: true }), /正在运行/);
        manager.pluginWindows.clear();
        const renamedConfig = { pluginName: '另一个插件', main: 'index.html' };
        fs.writeFileSync(path.join(extracted, 'tool', 'plugin.json'), JSON.stringify(renamedConfig));
        await assert.rejects(importTools(path.join(extracted, 'tool'), { toolsDir: tools, manager, overwrite: true }), /另一个插件/);
        fs.writeFileSync(path.join(extracted, 'tool', 'plugin.json'), JSON.stringify({ pluginName: '示例', main: 'index.html' }));
        fs.writeFileSync(path.join(extracted, 'tool', 'index.html'), '<p>new</p>');
        await importTools(path.join(extracted, 'tool'), { toolsDir: tools, manager, overwrite: true });
        assert.equal(fs.readFileSync(path.join(added.path, 'index.html'), 'utf8'), '<p>new</p>');
        fs.writeFileSync(path.join(extracted, 'tool', 'settings.json'), '{}');
        assert.throws(() => findRoots(extracted), /同时包含/);
        fs.writeFileSync(archive, zipSync({ '../outside.py': strToU8('unsafe') }));
        assert.throws(() => extractZip(archive, path.join(root, 'bad')), /不安全路径/);
        assert.equal(fs.existsSync(path.join(root, 'outside.py')), false);
        for (const name of ['.. /outside.py', 'folder./file', 'folder/file:stream', 'CON.txt']) {
            fs.writeFileSync(archive, zipSync({ [name]: strToU8('unsafe') }));
            assert.throws(() => extractZip(archive, path.join(root, 'bad')), /不安全/);
        }
        fs.writeFileSync(archive, zipSync({ 'A.txt': strToU8('a'), 'a.txt': strToU8('b') }));
        assert.throws(() => extractZip(archive, path.join(root, 'bad')), /大小写冲突/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('主进程明确禁用旧更新通道和新 Python 默认不安装', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(main, /pythonMode: 'none'/);
    assert.match(main, /async function checkForToolsUpdates\(\) \{\s*throw new Error/);
    assert.match(main, /app\.setPath\('userData'/);
    const pkg = require('../package.json');
    assert.equal(pkg.name, 'sanrenjz'); assert.equal(pkg.build.appId, 'com.sanrenjz.app');
    assert.deepEqual(pkg.build.publish, []);
    assert.equal(pkg.scripts['release-win'].includes('publish always'), false);
});
