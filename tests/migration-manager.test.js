'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MigrationManager } = require('../app/migration-manager');
// macOS 的 /var 临时别名先规范为真实路径，测试另建的链接仍按生产规则拒绝。
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sanrenjz-migration-'));
const previousAppdata = process.env.APPDATA;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); };
(async () => {
    try {
        process.env.APPDATA = path.join(temporary, 'appdata');
        const oldRoot = path.join(temporary, '旧 程序');
        const userData = path.join(temporary, 'new-profile');
        const toolsDir = path.join(temporary, 'new', 'plugins');
        const pythonDir = path.join(temporary, 'new', 'python-plugins');
        const configs = path.join(temporary, '旧 自定义配置');
        const pythonProfile = path.join(process.env.APPDATA, 'yuhanbopy-app');
        const toolsProfile = path.join(process.env.APPDATA, 'sanrenjz-tools');
        const interpreter = path.join(temporary, 'Python Space', 'python.exe');
        write(interpreter, 'fixture');
        write(path.join(pythonProfile, 'settings.json'), { customPluginConfigDir: configs, pythonMode: 'custom', customPythonPath: interpreter, token: 'never-output-this-token' });
        write(path.join(toolsProfile, 'settings.json'), { customPluginDataPath: path.join(temporary, 'old-tool-data') });
        write(path.join(oldRoot, 'plugins', 'py_fixture', 'settings.json'), { main_file: 'main.py' });
        write(path.join(oldRoot, 'plugins', 'py_fixture', 'main.py'), 'print("fixture")');
        for (const name of ['.venv', 'venv']) write(path.join(oldRoot, 'plugins', 'py_fixture', name, 'python.exe'), 'must-not-copy-runtime');
        write(path.join(oldRoot, 'plugins', 'py_fixture', 'portable-environment', 'pyvenv.cfg'), 'fixture');
        write(path.join(oldRoot, 'plugins', 'py_fixture', 'portable-environment', 'Lib', 'site-packages', 'fixture.py'), 'must-not-copy-runtime');
        write(path.join(oldRoot, 'plugins', 'py_fixture', 'env', 'business-resource.txt'), 'keep-business-resource');
        write(path.join(oldRoot, 'plugins', 'loose.py'), 'print("loose")');
        write(path.join(oldRoot, 'plugins', 'old_without_metadata', 'legacy.py'), 'print("legacy")');
        write(path.join(oldRoot, 'plugins', 'tool_fixture', 'plugin.json'), { pluginName: '测试效率插件' });
        write(path.join(oldRoot, 'plugins', 'tool_fixture', 'index.html'), '<p>fixture</p>');
        write(path.join(configs, 'py_fixture.json'), { private: 'do-not-log-config' });
        write(path.join(configs, 'conflict.json'), { source: true });
        write(path.join(configs, 'account-token.bin'), 'forbidden-account');
        write(path.join(temporary, 'old-tool-data', '测试效率插件-storage.json'), { autoStartWithMain: true });
        write(path.join(userData, 'python-plugin-configs', 'conflict.json'), { target: true });
        let settings = { pluginPreferences: { existing: { autoStartWithMain: true } } };
        write(path.join(userData, 'settings.json'), settings);
        let changed = 0;
        let inspectorCalls = 0;
        const inspectInterpreter = async executable => { inspectorCalls++; return { executable, version: '3.12.8', prefix: path.dirname(executable) }; };
        const manager = new MigrationManager({ appRoot: path.join(temporary, 'source'), userData, toolsDir, pythonDir, loadSettings: () => settings, saveSettings: update => { settings = { ...settings, ...update }; write(path.join(userData, 'settings.json'), settings); }, onChanged: () => { changed++; }, inspectInterpreter });
        manager.detectInstallations = () => [];
        const inspection = await manager.inspect({ installationRoots: [oldRoot] });
        assert(!JSON.stringify(inspection).includes('never-output-this-token'));
        assert(!JSON.stringify(inspection).includes('do-not-log-config'));
        const source = inspection.sources.find(item => item.product === 'python' && item.root === oldRoot);
        assert(source && source.pythonCount === 3 && source.hasConfigs && source.hasInterpreter);
        write(path.join(configs, 'nested', 'personal.db'), 'fixture-db');
        write(path.join(userData, 'python-plugin-configs', 'nested', 'existing.txt'), 'target-value');
        const sourceBefore = fs.readFileSync(path.join(configs, 'py_fixture.json'));
        const first = await manager.migrate({ sourceId: source.id, pythonPlugins: true, configs: true, interpreter: true });
        assert(first.success && first.copied >= 2);
        assert(fs.existsSync(path.join(pythonDir, 'py_fixture', 'main.py')));
        for (const name of ['.venv', 'venv', 'portable-environment']) assert(!fs.existsSync(path.join(pythonDir, 'py_fixture', name)), '不复制整套虚拟环境');
        assert.strictEqual(fs.readFileSync(path.join(pythonDir, 'py_fixture', 'env', 'business-resource.txt'), 'utf8'), 'keep-business-resource');
        assert.strictEqual(settings.pluginPreferences['python:py_fixture/main.py'].autoStartWithMain, false);
        assert.strictEqual(settings.pluginPreferences['python:loose.py'].autoStartWithMain, false);
        assert.strictEqual(settings.pluginPreferences['python:old_without_metadata/legacy.py'].autoStartWithMain, false);
        assert.strictEqual(settings.pluginPreferences.existing.autoStartWithMain, true);
        assert.strictEqual(settings.customPythonPath, interpreter);
        assert.strictEqual(inspectorCalls, 1, '迁移解释器必须进行实际校验');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(userData, 'python-plugin-configs', 'conflict.json'))), { target: true });
        assert(!fs.existsSync(path.join(userData, 'python-plugin-configs', 'account-token.bin')));
        assert.strictEqual(fs.readFileSync(path.join(userData, 'python-plugin-configs', 'nested', 'personal.db'), 'utf8'), 'fixture-db');
        assert.strictEqual(fs.readFileSync(path.join(userData, 'python-plugin-configs', 'nested', 'existing.txt'), 'utf8'), 'target-value');
        assert(fs.readFileSync(path.join(configs, 'py_fixture.json')).equals(sourceBefore));
        const report = fs.readFileSync(path.join(first.backupPath, 'report.json'), 'utf8');
        assert(!report.includes('do-not-log-config') && !report.includes('never-output-this-token'));
        const second = await manager.migrate({ sourceId: source.id, pythonPlugins: true, configs: true });
        assert(second.success && second.copied === 0 && second.skipped >= 3);
        assert.strictEqual(changed, 2);
        const toolSource = inspection.sources.find(item => item.product === 'tools' && item.root === oldRoot);
        await manager.migrate({ sourceId: toolSource.id, toolsPlugins: ['tool_fixture'], configs: true });
        assert.strictEqual(settings.pluginPreferences['测试效率插件'].autoStartWithMain, false);
        assert(!fs.existsSync(path.join(userData, 'account-token.bin')));
        const preferredInterpreter = path.join(temporary, 'new-preferred', 'python.exe');
        settings = { ...settings, pythonMode: 'custom', customPythonPath: preferredInterpreter };
        const sourceSettingsBefore = fs.readFileSync(path.join(pythonProfile, 'settings.json'));
        const callsBeforeKeeping = inspectorCalls;
        const keepInterpreter = await manager.migrate({ sourceId: source.id, interpreter: true });
        assert(keepInterpreter.success && keepInterpreter.conflicts.some(item => item.type === 'interpreter'));
        assert.strictEqual(inspectorCalls, callsBeforeKeeping, '新宿主已有环境选择时不运行旧解释器');
        assert.strictEqual(settings.customPythonPath, preferredInterpreter);
        for (const validator of [undefined, async () => { throw new Error('bad DLL'); }, async executable => ({ executable, version: '2.7.18' })]) {
            settings = { ...settings, pythonMode: 'none', customPythonPath: '' };
            manager.inspectInterpreter = validator;
            const invalidInterpreter = await manager.migrate({ sourceId: source.id, interpreter: true });
            assert(!invalidInterpreter.success && invalidInterpreter.errors.some(item => item.phase === 'interpreter'));
            assert.strictEqual(settings.pythonMode, 'none');
            assert.strictEqual(settings.customPythonPath, '', '错误或未校验解释器不能改变新应用原选择');
            assert(fs.readFileSync(path.join(pythonProfile, 'settings.json')).equals(sourceSettingsBefore));
        }
        manager.inspectInterpreter = inspectInterpreter;
        await assert.rejects(manager.migrate({ sourceId: 'uninspected', configs: true }), /先检查/);
        await assert.rejects(manager.migrate({ sourceId: source.id }), /明确选择/);

        // 同名公开插件无需替换程序，旧插件旁自定义文件仍能迁入独立配置根。
        const alreadyRoot = path.join(temporary, '另一旧安装');
        const alreadyFolder = path.join(alreadyRoot, 'plugins', 'Already There');
        write(path.join(alreadyFolder, 'settings.json'), { main_file: 'main.py', config_file: 'data\\personal.json' });
        write(path.join(alreadyFolder, 'main.py'), 'old-code');
        write(path.join(alreadyFolder, 'data', 'personal.json'), { fixture: 'legacy-private-config' });
        write(path.join(pythonDir, 'Already There', 'settings.json'), { main_file: 'main.py' });
        write(path.join(pythonDir, 'Already There', 'main.py'), 'keep-new-code');
        write(path.join(pythonDir, 'Already There', 'config.json'), '{}');
        const customNewConfigs = path.join(temporary, '新自定义配置');
        settings = { ...settings, pythonPluginConfigDir: customNewConfigs, customPluginConfigDir: path.join(temporary, 'unused-old-alias') };
        const alreadyInspection = await manager.inspect({ installationRoots: [path.join(alreadyRoot, 'plugins')] });
        const alreadySource = alreadyInspection.sources.find(item => item.root === alreadyRoot && item.product === 'python');
        assert(alreadySource && alreadySource.importable.configs && alreadySource.descriptions.length);
        const alreadyResult = await manager.migrate({ sourceId: alreadySource.id, pythonPlugins: true, configs: true });
        assert(alreadyResult.success && alreadyResult.conflicts.some(item => item.type === 'plugin' && item.id === 'Already There'));
        assert.strictEqual(fs.readFileSync(path.join(pythonDir, 'Already There', 'main.py'), 'utf8'), 'keep-new-code');
        assert.strictEqual(fs.readFileSync(path.join(pythonDir, 'Already There', 'config.json'), 'utf8'), '{}');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(customNewConfigs, 'already_there.json'))), { fixture: 'legacy-private-config' });
        assert(!JSON.stringify(alreadyInspection).includes('legacy-private-config'));
        assert(!fs.readFileSync(path.join(alreadyResult.backupPath, 'report.json'), 'utf8').includes('legacy-private-config'));
        write(path.join(customNewConfigs, 'already_there.json'), '{}');
        const preserveTemplate = await manager.migrate({ sourceId: alreadySource.id, configs: true });
        assert(preserveTemplate.success && preserveTemplate.conflicts.some(item => item.type === 'config' && item.id === 'already_there.json'));
        assert.strictEqual(fs.readFileSync(path.join(customNewConfigs, 'already_there.json'), 'utf8'), '{}', '目标已有空配置也不得覆盖');

        // 可手选独立旧 profile；只迁插件显示和关键词，保留所有宿主级偏好。
        const selectedProfile = path.join(temporary, '备份的旧用户资料');
        const selectedData = path.join(temporary, '备份的插件数据');
        write(path.join(selectedProfile, 'settings.json'), {
            customPluginDataPath: selectedData, globalHotkey: 'Ctrl+9', autoStart: true,
            pluginPreferences: { '测试效率插件': { showInMainUI: false, autoStartWithMain: true } },
            pluginSearchSettings: { '测试效率插件': { keywords: ['old-keyword'] } }
        });
        write(path.join(selectedData, '新复制的插件-storage.json'), { autoStartWithMain: true, autoSeparate: true });
        write(path.join(selectedData, 'nested', 'private.enc'), 'encrypted-fixture');
        const profileInspection = await manager.inspect({ installationRoots: [path.join(selectedProfile)] });
        const selectedSource = profileInspection.sources.find(item => item.profileRoot === selectedProfile && item.product === 'tools');
        assert(selectedSource && selectedSource.origin === 'selection' && selectedSource.hasPreferences);
        assert(selectedSource.configLocations.some(item => item.path === selectedData && item.custom));
        settings = { ...settings, globalHotkey: 'Alt+Space', autoStart: false, pluginSearchSettings: { '测试效率插件': { keywords: ['keep-new-keyword'] } } };
        const preferenceResult = await manager.migrate({ sourceId: selectedSource.id, configs: true, preferences: true });
        assert(preferenceResult.success && preferenceResult.preferenceFields === 1);
        assert.strictEqual(settings.pluginPreferences['测试效率插件'].showInMainUI, false);
        assert.strictEqual(settings.pluginPreferences['测试效率插件'].autoStartWithMain, false);
        assert.strictEqual(settings.pluginPreferences['新复制的插件'].autoStartWithMain, false, '旧存储文件不能恢复插件自启动');
        assert.strictEqual(settings.globalHotkey, 'Alt+Space'); assert.strictEqual(settings.autoStart, false);
        assert.deepStrictEqual(settings.pluginSearchSettings['测试效率插件'].keywords, ['keep-new-keyword']);
        assert(preferenceResult.conflicts.some(item => item.type === 'preference'));
        assert.strictEqual(fs.readFileSync(path.join(userData, 'plugin-data', 'nested', 'private.enc'), 'utf8'), 'encrypted-fixture');

        // 旧 Python hidden 使用相对入口 ID，新宿主映射为 python: 稳定 ID，旧自启不迁入。
        const selectedPythonProfile = path.join(temporary, '备份的Python资料');
        write(path.join(selectedPythonProfile, 'settings.json'), { pythonMode: 'embedded', pluginPreferences: { 'py_fixture/main.py': { hidden: true, autoStart: true } } });
        const pythonPreferencesInspection = await manager.inspect({ installationRoots: [selectedPythonProfile] });
        const pythonPreferenceSource = pythonPreferencesInspection.sources.find(item => item.profileRoot === selectedPythonProfile && item.product === 'python');
        assert(pythonPreferenceSource && pythonPreferenceSource.hasPreferences);
        const pythonPreferenceResult = await manager.migrate({ sourceId: pythonPreferenceSource.id, preferences: true });
        assert(pythonPreferenceResult.success);
        assert.strictEqual(settings.pluginPreferences['python:py_fixture/main.py'].showInMainUI, false);
        assert.strictEqual(settings.pluginPreferences['python:py_fixture/main.py'].autoStartWithMain, false);
        const preservedPreference = { autoStartWithMain: true, showInMainUI: true };
        settings.pluginPreferences['python:loose.py'] = preservedPreference;
        fs.unlinkSync(path.join(pythonDir, 'loose.py'));
        const existingPreference = await manager.migrate({ sourceId: source.id, pythonPlugins: ['loose.py'] });
        assert(existingPreference.success);
        assert.deepStrictEqual(settings.pluginPreferences['python:loose.py'], preservedPreference, '补程序不能覆盖新宿主已有插件偏好');

        const sharedProfile = path.join(temporary, '共用配置的旧资料');
        write(path.join(sharedProfile, 'settings.json'), { customPluginConfigDir: customNewConfigs });
        const sharedInspection = await manager.inspect({ installationRoots: [sharedProfile] });
        const shared = sharedInspection.sources.find(item => item.profileRoot === sharedProfile && item.product === 'python');
        const sharedBefore = fs.readFileSync(path.join(customNewConfigs, 'already_there.json'));
        const sharedResult = await manager.migrate({ sourceId: shared.id, configs: true });
        assert(sharedResult.success && sharedResult.conflicts.some(item => item.reason.includes('共用')));
        assert(fs.readFileSync(path.join(customNewConfigs, 'already_there.json')).equals(sharedBefore));

        // 元数据不能把插件外文件作为用户配置导入。
        for (const unsafe of ['../outside.json', '..\\outside.json', 'data/../outside.json', path.join(temporary, 'outside.json'), 'C:\\outside.json']) {
            const unsafeRoot = path.join(temporary, `unsafe-${Math.random().toString(16).slice(2)}`);
            write(path.join(unsafeRoot, 'plugins', 'bad_config', 'settings.json'), { main_file: 'main.py', config_file: unsafe });
            write(path.join(unsafeRoot, 'plugins', 'bad_config', 'main.py'), 'fixture');
            write(path.join(temporary, 'outside.json'), { private: 'outside-not-allowed' });
            const unsafeInspection = await manager.inspect({ installationRoots: [unsafeRoot] });
            const unsafeSource = unsafeInspection.sources.find(item => item.root === unsafeRoot && item.product === 'python');
            const unsafeResult = await manager.migrate({ sourceId: unsafeSource.id, configs: true });
            assert(!unsafeResult.success && unsafeResult.rolledBack);
            assert(!fs.existsSync(path.join(customNewConfigs, 'bad_config.json')));
            assert(!fs.readFileSync(path.join(unsafeResult.backupPath, 'report.json'), 'utf8').includes('outside-not-allowed'));
        }
        const protectedDirectory = path.join(temporary, 'protected-data');
        const linkedDirectory = path.join(temporary, 'linked-target');
        fs.mkdirSync(protectedDirectory);
        try {
            fs.symlinkSync(protectedDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
            settings = { ...settings, pythonPluginConfigDir: path.join(linkedDirectory, 'configs') };
            const linked = await manager.migrate({ sourceId: alreadySource.id, configs: true });
            assert(!linked.success && linked.rolledBack);
            assert.deepStrictEqual(fs.readdirSync(protectedDirectory), [], '不能跟随目标祖先链接写入');
        } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
        settings = { ...settings, pythonPluginConfigDir: customNewConfigs };
        const unrecognized = path.join(temporary, 'not-an-old-application'); fs.mkdirSync(unrecognized);
        const invalidInspection = await manager.inspect({ installationRoots: [unrecognized, manager.appRoot, path.join(temporary, 'missing-directory')] });
        assert(invalidInspection.errors.some(item => item.root === unrecognized && item.error.includes('未识别')));
        assert(invalidInspection.errors.some(item => item.root === manager.appRoot && item.error.includes('当前应用')));
        assert(invalidInspection.errors.some(item => item.error.includes('不存在')));
        const anotherMerged = path.join(temporary, 'another-merged-installation');
        write(path.join(anotherMerged, 'package.json'), { name: 'sanrenjz' });
        write(path.join(anotherMerged, 'plugins', 'tool', 'plugin.json'), { pluginName: 'merged app is not a legacy source' });
        const mergedInspection = await manager.inspect({ installationRoots: [anotherMerged] });
        assert(!mergedInspection.sources.some(item => item.root === anotherMerged), '不能把另一份合并版伪装为旧效率工具');

        const broken = path.join(oldRoot, 'plugins', 'broken');
        write(path.join(broken, 'settings.json'), '{');
        write(path.join(broken, 'main.py'), 'fixture');
        const refreshed = await manager.inspect({ installationRoots: [oldRoot] });
        const freshSource = refreshed.sources.find(item => item.product === 'python' && item.root === oldRoot);
        const failure = await manager.migrate({ sourceId: freshSource.id, pythonPlugins: ['broken'] });
        assert(!failure.success && !fs.existsSync(path.join(pythonDir, 'broken')));
        assert.strictEqual(fs.readFileSync(path.join(broken, 'settings.json'), 'utf8'), '{');
        write(path.join(oldRoot, 'plugins', 'helper_fixture', 'settings.json'), { main_file: 'main.py' });
        write(path.join(oldRoot, 'plugins', 'helper_fixture', 'main.py'), 'fixture');
        await manager.inspect({ installationRoots: [oldRoot] });
        manager.onChanged = async ({ pythonImported }) => ({ helperUpdates: pythonImported.map(folder => ({ folder, updated: false, reason: 'custom-launcher' })) });
        const custom = await manager.migrate({ sourceId: freshSource.id, pythonPlugins: ['helper_fixture'] });
        assert(custom.success && custom.helperUpdates[0].message.includes('未自动兼容'));
        assert(JSON.parse(fs.readFileSync(path.join(custom.backupPath, 'report.json'))).helperUpdates.length === 1);
        write(path.join(oldRoot, 'plugins', 'helper_failure', 'settings.json'), { main_file: 'main.py' });
        write(path.join(oldRoot, 'plugins', 'helper_failure', 'main.py'), 'fixture');
        await manager.inspect({ installationRoots: [oldRoot] });
        manager.onChanged = async () => { throw Object.assign(new Error('fixture'), { phase: 'helpers' }); };
        const helperFailure = await manager.migrate({ sourceId: freshSource.id, pythonPlugins: ['helper_failure'] });
        assert(!helperFailure.success && helperFailure.errors.some(item => item.phase === 'helpers'));
        assert(!fs.existsSync(path.join(pythonDir, 'helper_failure')));
        assert(JSON.parse(fs.readFileSync(path.join(helperFailure.backupPath, 'report.json'))).success === false);
        console.log('Migration manager passed: explicit sources, privacy, custom paths, no overwrites, disabled startup, idempotence, source preservation and failed copy isolation');
    } finally {
        if (previousAppdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = previousAppdata;
        fs.rmSync(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
