const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { comparePluginVersions, initializePluginStore, syncBundledPluginRuntime } = require('../app/plugin_store');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-plugin-store-test-'));

function writePlugin(baseDir, folderName, pluginName, content, metadata = {}) {
    const pluginDir = path.join(baseDir, folderName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ pluginName, ...metadata }), 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'value.txt'), content, 'utf8');
    return pluginDir;
}

try {
    const bundledDir = path.join(testRoot, 'bundled');
    const migrationDir = path.join(testRoot, 'migration');
    const persistentDir = path.join(testRoot, 'persistent');

    writePlugin(bundledDir, 'remote-same-folder', '高版本插件', 'remote-version', {
        version: '2.0.0',
        updatedAt: '2026-09-20'
    });
    fs.writeFileSync(path.join(bundledDir, 'remote-same-folder', 'new-file.txt'), 'new', 'utf8');
    writePlugin(bundledDir, 'remote-lower-folder', '低版本插件', 'remote-lower', {
        version: '1.5.0',
        updatedAt: '2026-09-20'
    });
    writePlugin(bundledDir, 'remote-newer-date', '同版本新日期插件', 'remote-newer-date', {
        version: '1.0.0',
        updatedAt: '2026-09-20'
    });
    writePlugin(bundledDir, 'remote-older-date', '同版本旧日期插件', 'remote-older-date', {
        version: '1.0.0',
        updatedAt: '2026-09-01'
    });
    writePlugin(bundledDir, 'remote-only-folder', '远端新增插件', 'new-plugin');
    writePlugin(migrationDir, 'local-same-folder', '高版本插件', 'local-version', {
        version: '1.0.0',
        updatedAt: '2026-09-10'
    });
    fs.writeFileSync(path.join(migrationDir, 'local-same-folder', 'stale-file.txt'), 'stale', 'utf8');
    writePlugin(migrationDir, 'local-lower-folder', '低版本插件', 'local-higher', {
        version: '2.0.0',
        updatedAt: '2026-09-10'
    });
    writePlugin(migrationDir, 'local-newer-date', '同版本新日期插件', 'local-older-date', {
        version: '1.0.0',
        updatedAt: '2026-09-10'
    });
    writePlugin(migrationDir, 'local-older-date', '同版本旧日期插件', 'local-newer-date', {
        version: '1.0.0',
        updatedAt: '2026-09-10'
    });
    writePlugin(migrationDir, 'local-only-folder', '本地独有插件', 'custom-plugin');
    writePlugin(migrationDir, '.downloads', '下载缓存', 'download-cache');

    const result = initializePluginStore({
        bundledDir,
        persistentDir,
        migrationDirs: [migrationDir]
    });

    assert.strictEqual(
        fs.readFileSync(path.join(persistentDir, 'local-same-folder', 'value.txt'), 'utf8'),
        'remote-version',
        '内置插件版本更高时必须替换本地版本'
    );
    assert.strictEqual(
        fs.existsSync(path.join(persistentDir, 'remote-same-folder')),
        false,
        '同名插件升级时必须沿用本地目录，不能重复补入'
    );
    assert.strictEqual(fs.existsSync(path.join(persistentDir, 'local-same-folder', 'stale-file.txt')), false, '升级必须移除旧版遗留文件');
    assert.strictEqual(fs.readFileSync(path.join(persistentDir, 'local-same-folder', 'new-file.txt'), 'utf8'), 'new');
    assert.strictEqual(
        fs.readFileSync(path.join(persistentDir, 'local-lower-folder', 'value.txt'), 'utf8'),
        'local-higher',
        '内置插件版本更低时不得降级覆盖'
    );
    assert.strictEqual(
        fs.readFileSync(path.join(persistentDir, 'local-newer-date', 'value.txt'), 'utf8'),
        'remote-newer-date',
        '版本相同时，内置插件日期更新必须覆盖'
    );
    assert.strictEqual(
        fs.readFileSync(path.join(persistentDir, 'local-older-date', 'value.txt'), 'utf8'),
        'local-newer-date',
        '版本相同时，内置插件日期更旧不得覆盖'
    );
    assert.strictEqual(
        fs.readFileSync(path.join(persistentDir, 'local-only-folder', 'value.txt'), 'utf8'),
        'custom-plugin',
        '本地独有插件必须完成迁移'
    );
    assert.strictEqual(
        fs.readFileSync(path.join(persistentDir, 'remote-only-folder', 'value.txt'), 'utf8'),
        'new-plugin',
        '本地缺少的远端插件必须自动补入'
    );
    assert.strictEqual(fs.existsSync(path.join(persistentDir, '.downloads')), false, '不能迁移下载缓存');
    assert.strictEqual(fs.existsSync(migrationDir), false, '成功迁移后应清理临时备份');
    assert.deepStrictEqual(result.migrated.sort(), ['高版本插件', '低版本插件', '同版本新日期插件', '同版本旧日期插件', '本地独有插件'].sort());
    assert.deepStrictEqual(result.added, ['远端新增插件']);
    assert.deepStrictEqual(result.updated.sort(), ['高版本插件', '同版本新日期插件'].sort());
    assert.deepStrictEqual(result.preserved.sort(), ['低版本插件', '同版本旧日期插件'].sort());

    const secondRun = initializePluginStore({ bundledDir, persistentDir });
    assert.deepStrictEqual(secondRun.added, [], '重复启动不得覆盖或重复复制插件');
    assert.deepStrictEqual(secondRun.updated, [], '版本和日期没有变化时不得重复更新插件');
    assert.deepStrictEqual(
        secondRun.preserved.sort(),
        ['高版本插件', '低版本插件', '同版本新日期插件', '同版本旧日期插件', '远端新增插件'].sort()
    );

    assert.strictEqual(comparePluginVersions('1.10.0', '1.9.9'), 1, '版本比较不能按字符串排序');
    assert.strictEqual(comparePluginVersions('2.0.0-beta.1', '2.0.0'), -1, '预发布版本必须低于正式版本');
    assert.strictEqual(comparePluginVersions('v2.0', '2.0.0'), 0, '版本比较应兼容 v 前缀和省略的补零段');

    const bundledRuntime = path.join(testRoot, 'bundled-runtime');
    const installedRuntime = path.join(testRoot, 'installed-runtime');
    fs.mkdirSync(bundledRuntime, { recursive: true });
    fs.mkdirSync(installedRuntime, { recursive: true });
    fs.writeFileSync(path.join(bundledRuntime, 'ai-runtime.js'), 'new-runtime', 'utf8');
    fs.writeFileSync(path.join(installedRuntime, 'ai-runtime.js'), 'old-runtime', 'utf8');
    fs.writeFileSync(path.join(installedRuntime, 'local-only.js'), 'keep', 'utf8');
    assert.strictEqual(syncBundledPluginRuntime(bundledRuntime, installedRuntime), installedRuntime);
    assert.strictEqual(fs.readFileSync(path.join(installedRuntime, 'ai-runtime.js'), 'utf8'), 'new-runtime');
    assert.strictEqual(fs.readFileSync(path.join(installedRuntime, 'local-only.js'), 'utf8'), 'keep');

    console.log('plugin store test passed: bundled plugins upgraded by version/date without downgrades');
} finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
}
