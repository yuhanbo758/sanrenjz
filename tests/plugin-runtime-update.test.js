'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const moduleRoot = process.env.SANRENJZ_UPDATE_MODULE_DIR || path.join(__dirname, '../app');
if (process.env.SANRENJZ_UPDATE_MODULE_DIR) {
    process.env.NODE_PATH = [path.join(__dirname, '../node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    require('node:module').Module._initPaths();
}
const { importTools, extractZip } = require(path.join(moduleRoot, 'plugin-import'));
const { replacePluginDirectory, copyMissingPlugins } = require(path.join(moduleRoot, 'plugin_store'));
const { zipSync, strToU8 } = require('fflate');

function write(root, relative, value) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    return file;
}
function fixture(t, existing = true) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-插件更新 空格-'));
    t.after(() => {
        assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
        assert(path.basename(root).startsWith('sanrenjz-插件更新 空格-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const source = path.join(root, '新版'), toolsDir = path.join(root, 'plugins'), target = path.join(toolsDir, '原目录');
    fs.mkdirSync(toolsDir);
    write(source, 'plugin.json', JSON.stringify({ pluginName: '更新测试', main: 'index.html', version: '2.0.0' }));
    write(source, 'index.html', 'new code');
    write(source, '.runtime/reader/Default/Network/Cookies', 'foreign session');
    if (existing) {
        write(target, 'plugin.json', JSON.stringify({ pluginName: '更新测试', main: 'index.html', version: '1.0.0' }));
        write(target, 'index.html', 'old code'); write(target, 'obsolete.js', 'obsolete');
        write(target, '.runtime/reader/Default/Network/Cookies', Buffer.from([0, 255, 4, 8]));
        write(target, '.runtime/reading-cli/existing-task/marker', 'keep task');
    }
    const manager = { getPluginList: async () => existing ? [{ name: '更新测试', path: target }] : [],
        pluginWindows: new Map(), pluginProcesses: new Map() };
    return { root, source, toolsDir, target, manager };
}
function session(target) { return fs.readFileSync(path.join(target, '.runtime/reader/Default/Network/Cookies')); }
function originalRestored(target) {
    assert.equal(fs.readFileSync(path.join(target, 'index.html'), 'utf8'), 'old code');
    assert.deepEqual(session(target), Buffer.from([0, 255, 4, 8]));
}

test('覆盖导入更新代码并原地保留完整本机 .runtime，不合并包内会话', async t => {
    const f = fixture(t), inode = fs.statSync(path.join(f.target, '.runtime')).ino;
    const result = await importTools(f.source, { ...f, overwrite: true });
    assert.equal(result.path, f.target); assert.equal(result.action, 'replaced');
    assert.equal(fs.readFileSync(path.join(f.target, 'index.html'), 'utf8'), 'new code');
    assert.deepEqual(session(f.target), Buffer.from([0, 255, 4, 8]));
    assert.equal(fs.statSync(path.join(f.target, '.runtime')).ino, inode);
    assert.equal(fs.readFileSync(path.join(f.target, '.runtime/reading-cli/existing-task/marker'), 'utf8'), 'keep task');
    assert.equal(fs.existsSync(path.join(f.target, 'obsolete.js')), false);
    assert.deepEqual(fs.readdirSync(f.toolsDir), ['原目录']);
});

test('首次导入及无旧会话的更新均不导入包内 .runtime', async t => {
    const f = fixture(t, false), result = await importTools(f.source, f);
    assert.equal(fs.existsSync(path.join(result.path, '.runtime')), false);
    replacePluginDirectory(f.source, result.path);
    assert.equal(fs.existsSync(path.join(result.path, '.runtime')), false);
});

test('商店 ZIP 解压后的更新沿用本机 .runtime', async t => {
    const f = fixture(t), archive = path.join(f.root, 'shop.zip'), extracted = path.join(f.root, 'unzipped');
    fs.writeFileSync(archive, zipSync({ 'tool/plugin.json': strToU8(fs.readFileSync(path.join(f.source, 'plugin.json'), 'utf8')),
        'tool/index.html': strToU8('zip code'), 'tool/.runtime/foreign': strToU8('must ignore') }));
    extractZip(archive, extracted);
    await importTools(path.join(extracted, 'tool'), { ...f, overwrite: true });
    assert.equal(fs.readFileSync(path.join(f.target, 'index.html'), 'utf8'), 'zip code');
    assert.deepEqual(session(f.target), Buffer.from([0, 255, 4, 8]));
    assert.equal(fs.existsSync(path.join(f.target, '.runtime/foreign')), false);
});

test('内置版本升级保留会话，首次内置安装排除包内会话', t => {
    const f = fixture(t), bundled = path.join(f.root, 'bundled');
    fs.mkdirSync(bundled); fs.renameSync(f.source, path.join(bundled, 'renamed-package'));
    const result = copyMissingPlugins(bundled, f.toolsDir, { updateExisting: true });
    assert.deepEqual(result.updated, ['更新测试']); assert.deepEqual(session(f.target), Buffer.from([0, 255, 4, 8]));
    const empty = path.join(f.root, 'empty');
    copyMissingPlugins(bundled, empty, { updateExisting: true });
    assert.equal(fs.existsSync(path.join(empty, 'renamed-package/.runtime')), false);
    const migrated = path.join(f.root, 'migrated');
    copyMissingPlugins(f.toolsDir, migrated);
    assert.deepEqual(session(path.join(migrated, '原目录')), Buffer.from([0, 255, 4, 8]));
});

for (const phase of ['backup', 'runtime', 'commit']) {
    test(`更新在 ${phase} 阶段失败时，旧代码和会话均回滚`, t => {
        const f = fixture(t), rename = fs.renameSync;
        let injected = false;
        t.mock.method(fs, 'renameSync', (from, to) => {
            if (!injected && ((phase === 'backup' && from === f.target) ||
                (phase === 'runtime' && path.basename(from) === '.runtime') ||
                (phase === 'commit' && path.basename(from).startsWith('.plugin-update-') && to === f.target))) {
                injected = true; throw new Error('injected failure');
            }
            return rename(from, to);
        });
        assert.throws(() => replacePluginDirectory(f.source, f.target), /injected failure/);
        assert(injected); originalRestored(f.target);
        assert.deepEqual(fs.readdirSync(f.toolsDir), ['原目录']);
    });
}

test('复制新版失败不改变旧代码或会话', t => {
    const f = fixture(t);
    t.mock.method(fs, 'cpSync', () => { throw new Error('copy failed'); });
    assert.throws(() => replacePluginDirectory(f.source, f.target), /copy failed/);
    originalRestored(f.target);
});

test('回滚本身失败时保留恢复目录与原会话，不清理唯一数据副本', t => {
    const f = fixture(t), rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if ((path.basename(from).startsWith('.plugin-update-') && to === f.target) ||
            (path.basename(from) === '.runtime' && path.basename(path.dirname(from)).startsWith('.plugin-update-'))) throw new Error('rename blocked');
        return rename(from, to);
    });
    assert.throws(() => replacePluginDirectory(f.source, f.target), error => {
        assert.match(error.message, /自动回滚未完成/);
        assert.equal(error.recoveryPaths.length, 2);
        assert.equal(fs.readFileSync(path.join(error.recoveryPaths[0], 'index.html'), 'utf8'), 'old code');
        assert.deepEqual(session(error.recoveryPaths[1]), Buffer.from([0, 255, 4, 8]));
        return true;
    });
});

test('提交成功后的旧代码清理失败不会回滚或丢失会话', t => {
    const f = fixture(t), remove = fs.rmSync;
    t.mock.method(fs, 'rmSync', (target, options) => {
        if (path.basename(target).startsWith('.plugin-backup-')) throw new Error('cleanup blocked');
        return remove(target, options);
    });
    const result = replacePluginDirectory(f.source, f.target);
    assert.match(result.cleanupWarning, /旧版本目录未清理/);
    assert.equal(fs.readFileSync(path.join(f.target, 'index.html'), 'utf8'), 'new code');
    assert.deepEqual(session(f.target), Buffer.from([0, 255, 4, 8]));
    assert.equal(fs.existsSync(path.join(result.backupPath, '.runtime')), false);
});

test('运行中的插件继续拒绝覆盖，.runtime 普通文件不会被当作缓存删除', async t => {
    const f = fixture(t);
    f.manager.pluginWindows.set('更新测试', {});
    await assert.rejects(importTools(f.source, { ...f, overwrite: true }), /正在运行/);
    originalRestored(f.target); f.manager.pluginWindows.clear();
    fs.rmSync(path.join(f.target, '.runtime'), { recursive: true }); write(f.target, '.runtime', 'important');
    await assert.rejects(importTools(f.source, { ...f, overwrite: true }), /必须是本地目录/);
    assert.equal(fs.readFileSync(path.join(f.target, '.runtime'), 'utf8'), 'important');
});

test('.runtime 链接拒绝更新且不触碰外部数据', async t => {
    const f = fixture(t), external = path.join(f.root, 'external');
    write(external, 'keep', 'external'); fs.rmSync(path.join(f.target, '.runtime'), { recursive: true });
    fs.symlinkSync(external, path.join(f.target, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(importTools(f.source, { ...f, overwrite: true }), /必须是本地目录/);
    assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'external');
});

test('拒绝以被排除的 .runtime 文件作为插件入口，保持已安装版本', async t => {
    const f = fixture(t);
    write(f.source, '.runtime/index.html', 'foreign runtime code');
    write(f.source, 'plugin.json', JSON.stringify({ pluginName: '更新测试', main: '.runtime/index.html' }));
    await assert.rejects(importTools(f.source, { ...f, overwrite: true }), /入口不能位于/);
    originalRestored(f.target);
});
