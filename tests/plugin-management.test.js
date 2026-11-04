const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { performance } = require('perf_hooks');
const { PluginCatalog } = require('../app/plugin-catalog');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-plugin-management-'));
const pluginDir = path.join(temp, 'plugins');
const dataDir = path.join(temp, 'plugin-data');
fs.mkdirSync(pluginDir);
fs.mkdirSync(dataDir);
function fixture(folder, name, settings = {}) {
    const directory = path.join(pluginDir, folder);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: name, features: [{ code: folder, cmds: ['示例'] }] }));
    fs.writeFileSync(path.join(dataDir, `${name}-storage.json`), JSON.stringify(settings));
    return directory;
}
function managerClass() {
    const file = path.resolve(__dirname, '../app/software_manager.js');
    const localRequire = createRequire(file);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, __dirname: path.dirname(file), console, process, setTimeout, clearTimeout,
        require(name) {
            if (name === 'electron') return { app: { getPath: () => temp, getAppPath: () => path.resolve(__dirname, '..') } };
            return localRequire(name);
        }
    });
    return module.exports;
}

(async () => {
    const originalRead = fs.promises.readFile;
    try {
        const first = fixture('a', '默认插件');
        fixture('b', '隐藏自启', { showInMainUI: false, autoStartWithMain: true, privateToken: 'test-only-placeholder' });
        fixture('c', '失败自启', { autoStartWithMain: true });
        fixture('d', '后续自启', { autoStartWithMain: true });
        const Manager = managerClass();
        const manager = new Manager(null);
        manager.pluginDir = pluginDir;
        manager.pluginDataDir = dataDir;
        manager.catalog = new PluginCatalog(pluginDir);
        let reads = 0;
        fs.promises.readFile = async function(file, ...args) {
            if (path.basename(file) === 'plugin.json') reads++;
            return originalRead.call(this, file, ...args);
        };
        await Promise.all(Array.from({ length: 10 }, () => manager.getPluginList()));
        assert.strictEqual(reads, 4, '并发请求只能读取一次清单');
        manager.catalog.expiresAt = 0;
        await manager.getPluginList();
        assert.strictEqual(reads, 4, '到期扫描时不重读未变化清单');
        manager.registerDynamicFeatures('默认插件', [{ code: 'dynamic', explain: '动态入口' }]);
        assert((await manager.getPluginList())[0].features.some(f => f.code === 'dynamic'));

        fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ pluginPreferences: { '隐藏自启': { showInMainUI: false } } }));
        let list = await manager.getPluginManagementList();
        assert.strictEqual(list[0].pluginSettings.showInMainUI, true);
        assert.strictEqual(list[0].pluginSettings.autoStartWithMain, false);
        assert.strictEqual(list[1].pluginSettings.showInMainUI, false);
        assert.strictEqual(list[1].pluginSettings.autoStartWithMain, true);
        assert(!JSON.stringify(list).includes('privateToken'), '管理列表只暴露允许的字段');
        fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ pluginPreferences: { '隐藏自启': { showInMainUI: true } } }));
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, '隐藏自启-storage.json'))).autoStartWithMain, true);
        assert.strictEqual((await manager.getPluginManagementList())[1].pluginSettings.showInMainUI, true);
        const restarted = new Manager(null);
        restarted.pluginDir = pluginDir;
        restarted.pluginDataDir = dataDir;
        restarted.catalog = new PluginCatalog(pluginDir);
        assert.strictEqual((await restarted.getPluginManagementList())[1].pluginSettings.showInMainUI, true);

        const called = [];
        manager.runPlugin = async (directory, features) => {
            assert.strictEqual(features.length, 0, '自启动不执行插件业务功能');
            called.push(path.basename(directory));
            return { success: path.basename(directory) !== 'c', error: '模拟启动失败' };
        };
        const results = await manager.startConfiguredPlugins();
        assert.strictEqual(results.length, 3);
        assert.strictEqual(results.filter(r => !r.success).length, 1);
        assert.strictEqual(called.join(','), 'b,c,d');
        await manager.startConfiguredPlugins();
        assert.strictEqual(called.length, 3, '同一实例只自启动一次');
        fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify({ pluginPreferences: {
            '默认插件': { autoStartWithMain: true, showInMainUI: false },
            '隐藏自启': { autoStartWithMain: false, showInMainUI: true }
        } }));
        const restartCalls = [];
        restarted.runPlugin = async directory => { restartCalls.push(path.basename(directory)); return { success: true }; };
        await restarted.startConfiguredPlugins();
        assert.strictEqual(restartCalls.join(','), 'a,c,d', '重启后宿主偏好覆盖旧开关，隐藏也不阻止已选自启动');

        fs.writeFileSync(path.join(first, 'plugin.json'), JSON.stringify({ pluginName: '更新插件', version: '2.0.0' }));
        fixture('e', '新装插件');
        list = await manager.getPluginList({ force: true });
        assert.strictEqual(list.length, 5);
        assert.strictEqual(list[0].name, '更新插件');
        fs.unlinkSync(path.join(first, 'plugin.json'));
        assert.strictEqual((await manager.getPluginList({ force: true })).length, 4);
        fs.writeFileSync(path.join(pluginDir, 'e', 'plugin.json'), '{bad');
        assert.strictEqual((await manager.getPluginList({ force: true })).length, 3, '损坏清单不阻断其他插件');

        const benchmarks = [];
        for (const directory of [path.resolve(__dirname, '../app/software'), process.env.SANRENJZ_PLUGIN_BENCHMARK_DIR].filter(Boolean)) {
            if (!fs.existsSync(directory)) continue;
            const catalog = new PluginCatalog(directory);
            const benchmarkManager = Object.create(Manager.prototype);
            benchmarkManager.catalog = catalog;
            benchmarkManager.dynamicFeatures = new Map();
            reads = 0;
            const times = [];
            for (let index = 0; index < 10; index++) {
                const started = performance.now();
                await benchmarkManager.getPluginList();
                times.push(+(performance.now() - started).toFixed(3));
            }
            benchmarks.push({ directory, count: catalog.entries.length, manifestReads: reads, ms: times });
        }
        console.log('Plugin management passed: defaults, independence, restart, single startup, failure isolation, cache coalescing, refresh, dynamic features, privacy');
        console.log(JSON.stringify(benchmarks));
    } finally {
        fs.promises.readFile = originalRead;
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
