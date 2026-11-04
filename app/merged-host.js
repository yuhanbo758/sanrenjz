const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { PythonEnvironment } = require('./python-environment');
const { PythonManager } = require('./python-manager');
const { MigrationManager } = require('./migration-manager');
const { extractZip, findRoots, importTools, inside } = require('./plugin-import');
const { RunLogStore, validateLogFilter } = require('./run-log-store');

function publicRuntime(runtime) {
    if (!runtime || runtime.canceled) return runtime;
    const { executable, version, prefix, mode, architecture, bitness, pip, tk, tkWindow, ssl, venv } = runtime;
    return { executable, version, prefix, mode, architecture, bitness, pip, tk, tkWindow, ssl, venv };
}

function createMergedHost({ app, ipcMain, dialog, shell, getWindow, getManager, loadSettings, saveSettings, refresh, send, appRoot: suppliedRoot }) {
    const appRoot = suppliedRoot || (app.isPackaged ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)) : path.resolve(__dirname, '..'));
    const userData = app.getPath('userData');
    const pythonDir = app.isPackaged ? path.join(appRoot, 'python-plugins') : path.join(appRoot, 'app', 'python-software');
    fs.mkdirSync(pythonDir, { recursive: true });
    if (app.isPackaged) {
        const bundled = path.join(process.resourcesPath, 'app', 'python-software');
        if (fs.existsSync(bundled)) for (const item of fs.readdirSync(bundled)) {
            const destination = path.join(pythonDir, item);
            if (!item.startsWith('.') && !fs.existsSync(destination)) fs.cpSync(path.join(bundled, item), destination, { recursive: true });
        }
    }
    const changed = async ({ pythonImported = [] } = {}) => {
        const helperUpdates = [];
        for (const directory of pythonImported) if (fs.statSync(directory).isDirectory()) helperUpdates.push(await python.upgradeStandardHelpers(directory));
        await refresh('unified-change'); send('python:changed', {});
        return { helperUpdates };
    };
    const runtimeLogs = new RunLogStore({ onLog: record => send('runtime:log', record) });
    const environment = new PythonEnvironment({ appRoot, userData, loadSettings, saveSettings, onProgress: event => send('python:progress', event) });
    let python;
    python = new PythonManager({ pluginDir: pythonDir, userData, appRoot, loadSettings, saveSettings, environment, onChanged: changed, onLog: event => {
        runtimeLogs.append({ ...event, engine: 'python', name: python.running.get(event.id)?.item.name });
        send('python:log', event);
    } });
    const defaultConfigDirectory = path.join(userData, 'python-plugin-configs');
    function physicalDirectory(directory) {
        let ancestor = path.resolve(directory);
        const missing = [];
        while (!fs.existsSync(ancestor)) {
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            missing.unshift(path.basename(ancestor));
            ancestor = parent;
        }
        return path.join(fs.realpathSync(ancestor), ...missing);
    }
    function validateConfigDirectory(directory) {
        const resolved = path.resolve(directory);
        const physical = physicalDirectory(resolved);
        for (const root of [getManager().pluginDir, pythonDir]) {
            const programRoot = path.resolve(root);
            const physicalRoot = physicalDirectory(programRoot);
            // 同时检查实际路径，避免通过目录联接把私密配置写进插件程序目录。
            if (inside(programRoot, resolved) || inside(resolved, programRoot) || inside(physicalRoot, physical) || inside(physical, physicalRoot)) {
                throw new Error('配置目录不能与插件程序目录互相包含');
            }
        }
        return resolved;
    }
    function configLocation() {
        const directory = validateConfigDirectory(python._configRoot());
        return { path: directory, defaultPath: defaultConfigDirectory, custom: path.relative(defaultConfigDirectory, directory) !== '' };
    }
    async function changeConfigDirectory(directory) {
        if (python.running.size || python.pending.size) throw new Error('请先停止正在运行或启动中的 Python 插件，再更改配置目录');
        const previous = configLocation().path;
        const target = validateConfigDirectory(directory);
        const { copyMissingPluginConfigs } = require('./python-support/plugin_config');
        const copied = copyMissingPluginConfigs(previous, target);
        const customPath = path.relative(defaultConfigDirectory, target) === '' ? '' : target;
        // 两个旧键读取优先级不同，保存时必须同步，防止旧别名覆盖用户的新选择。
        saveSettings({ customPluginConfigDir: customPath, pythonPluginConfigDir: customPath });
        const result = { success: true, path: target, defaultPath: defaultConfigDirectory, custom: Boolean(customPath), copied };
        try { await changed(); }
        catch (error) { result.warning = `配置目录已保存，但插件列表刷新失败：${error.message}`; }
        return result;
    }
    const migration = new MigrationManager({ appRoot, userData, toolsDir: getManager().pluginDir, pythonDir, loadSettings, saveSettings, onChanged: changed, inspectInterpreter: executable => environment.inspect(executable) });
    const toolId = item => `tools:${path.relative(getManager().pluginDir, item.path).replace(/\\/g, '/')}`;
    async function list(includeHidden = false) {
        const settings = loadSettings();
        const tools = (await getManager().getPluginList()).map(p => ({ ...p, id: toolId(p), engine: 'tools', hidden: settings.pluginPreferences?.[p.name]?.showInMainUI === false, autoStart: settings.pluginPreferences?.[p.name]?.autoStartWithMain === true }));
        const programs = await python.list({ includeHidden: true });
        runtimeLogs.registerSources([...tools, ...programs]);
        return [...tools, ...programs].filter(p => includeHidden || !p.hidden);
    }
    async function managementList() {
        // 管理页必须包含隐藏项，并保留效率插件专有的窗口设置；两类插件按稳定 ID 区分。
        const tools = (await getManager().getPluginManagementList()).map(p => ({ ...p, id: toolId(p), engine: 'tools' }));
        const programs = (await python.list({ includeHidden: true })).map(p => ({ ...p,
            pluginSettings: { showInMainUI: !p.hidden, autoStartWithMain: p.autoStart }
        }));
        runtimeLogs.registerSources([...tools, ...programs]);
        return [...tools, ...programs];
    }
    async function run(id, options = {}) {
        if (String(id).startsWith('python:')) {
            const item = (await python.list({ includeHidden: true })).find(program => program.id === id);
            if (item) runtimeLogs.registerSource(item);
            return python.run(id, options);
        }
        const item = (await list(true)).find(p => p.id === id && p.engine === 'tools');
        if (!item) throw new Error('插件未安装');
        const result = await getManager().runPlugin(item.path, options.features || []);
        return result?.success === false ? result : { success: true };
    }
    async function importOne(source, engine, overwrite = false) {
        if (path.extname(source).toLowerCase() === '.zip') return importArchive(source, overwrite);
        if (engine === 'python') return python.importPath(source, { overwrite });
        return importTools(source, { toolsDir: getManager().pluginDir, manager: getManager(), overwrite });
    }
    async function confirmImport(source, engine, overwrite = false) {
        try { return await importOne(source, engine, overwrite); }
        catch (error) {
            if (error.code !== 'PLUGIN_EXISTS' || overwrite) throw error;
            const choice = await dialog.showMessageBox(getWindow(), { type: 'question', title: '替换插件', message: error.message, detail: '仅替换程序文件，已有用户配置会保留。运行中的插件需要先关闭。', buttons: ['取消', '替换'], defaultId: 0, cancelId: 0 });
            return choice.response === 1 ? importOne(source, engine, true) : { canceled: true };
        }
    }
    async function importArchive(archive, overwrite = false) {
        const workspace = fs.mkdtempSync(path.join(userData, 'plugin-import-'));
        try {
            extractZip(archive, workspace);
            const installed = [];
            for (const root of findRoots(workspace)) installed.push(await confirmImport(root.path, root.engine, overwrite));
            await changed();
            return { installed };
        } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
    }
    const handlers = {
        'unified:list': (_e, options = {}) => list(Boolean(options.includeHidden)),
        'unified:run': (_e, id, options) => run(id, options),
        'unified:stop': async (_e, id) => {
            if (String(id).startsWith('python:')) return python.stop(id);
            const item = (await list(true)).find(p => p.id === id);
            if (!item) throw new Error('插件未安装');
            getManager().stopPlugin(item.name); return { success: true };
        },
        'unified:remove': async (_e, id) => {
            if (String(id).startsWith('python:')) return python.remove(id);
            const item = (await list(true)).find(p => p.id === id);
            if (!item) throw new Error('插件未安装');
            const result = await getManager().uninstallPlugin(item.name); await changed(); return result;
        },
        'unified:import': async (_e, kind) => {
            const config = { 'python-file': { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Python 文件', extensions: ['py'] }] }, 'python-folder': { properties: ['openDirectory', 'multiSelections'] }, 'tools-folder': { properties: ['openDirectory', 'multiSelections'] }, 'tools-zip': { properties: ['openFile', 'multiSelections'], filters: [{ name: '插件 ZIP', extensions: ['zip'] }] } }[kind];
            if (!config) throw new Error('未知导入类型');
            const choice = await dialog.showOpenDialog(getWindow(), { title: '打开插件（导入后不会自动运行）', ...config });
            if (choice.canceled) return { canceled: true };
            const results = [], errors = [];
            for (const selected of choice.filePaths) {
                try { results.push(await confirmImport(selected, kind.startsWith('python') ? 'python' : 'tools')); }
                catch (error) { errors.push(`${path.basename(selected)}：${error.message}`); }
            }
            await changed(); return { success: !errors.length, results, errors };
        },
        'unified:preference': async (_e, id, key, value) => {
            if (!['showInMainUI', 'autoStartWithMain'].includes(key) || typeof value !== 'boolean') throw new Error('无效的管理选项');
            const item = (await list(true)).find(p => p.id === id); if (!item) throw new Error('插件未安装');
            const preferenceKey = item.engine === 'python' ? item.id : item.name;
            const previous = loadSettings().pluginPreferences || {};
            saveSettings({ pluginPreferences: { ...previous, [preferenceKey]: { ...previous[preferenceKey], [key]: value } } });
            // 落盘成功后，刷新错误不能再被当成保存失败，否则页面会反转已保存的值。
            try { await changed(); }
            catch (error) { return { success: true, warning: `插件选项已保存，但列表刷新失败：${error.message}。请重新打开插件管理。` }; }
            return { success: true };
        },
        'python:status': () => environment.status(),
        'python:discover': () => environment.discover(),
        'python:select': async () => {
            const choice = await dialog.showOpenDialog(getWindow(), { title: '选择 Python 解释器', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Python 解释器', extensions: ['exe'] }] } : {}) });
            return choice.canceled ? { canceled: true } : publicRuntime(await environment.select(choice.filePaths[0]));
        },
        'python:select-path': async (_e, executable) => publicRuntime(await environment.select(executable)),
        'python:install': async () => publicRuntime(await environment.install()),
        'python:cancel': () => { environment.cancel(); return { success: true }; },
        'python:clear': () => {
            if (environment.status().installing) { const error = new Error('Python 正在安装，请先取消或等待完成'); error.code = 'PYTHON_INSTALL_BUSY'; throw error; }
            saveSettings({ pythonMode: 'none', customPythonPath: '', managedPythonPath: '' }); return environment.status();
        },
        'python:diagnose': async () => publicRuntime(await environment.resolve()),
        'python:logs': (_e, id) => python.getLogs(id),
        'runtime:logs': async () => { await list(true); return runtimeLogs.snapshot(); },
        'runtime:export-logs': async (_e, filter) => {
            const valid = validateLogFilter(filter);
            await list(true);
            const records = runtimeLogs.query(valid);
            const choice = await dialog.showSaveDialog(getWindow(), { title: '导出运行日志', defaultPath: '三人聚智-运行日志.txt' });
            if (choice.canceled) return { canceled: true };
            fs.writeFileSync(choice.filePath, records.map(record => `[${record.timestamp}] [${record.engine === 'tools' ? '效率工具' : 'Python'}] [${record.name}] ${record.stream}: ${record.message}`).join('\n') || '暂无运行日志', 'utf8');
            return { success: true, count: records.length };
        },
        'python:config-location': () => configLocation(),
        'python:config-open': async () => {
            const directory = configLocation().path;
            const { protectConfigDirectory } = require('./python-support/plugin_config');
            protectConfigDirectory(directory);
            if (!shell?.openPath) throw new Error('当前环境无法打开文件夹');
            const error = await shell.openPath(directory);
            if (error) throw new Error(`无法打开配置目录：${error}`);
            return { success: true, path: directory };
        },
        'python:config-reset': () => changeConfigDirectory(defaultConfigDirectory),
        'python:config-directory': async () => {
            const choice = await dialog.showOpenDialog(getWindow(), { title: '选择 Python 插件配置目录', properties: ['openDirectory', 'createDirectory'] });
            if (choice.canceled) return { canceled: true };
            if (!choice.filePaths?.[0]) throw new Error('未选择有效的配置目录');
            return changeConfigDirectory(choice.filePaths[0]);
        },
        'migration:inspect': (_e, options) => migration.inspect(options),
        'migration:choose': async () => {
            const choice = await dialog.showOpenDialog(getWindow(), { title: '选择旧应用安装目录', properties: ['openDirectory'] });
            return choice.canceled ? { canceled: true } : migration.inspect({ installationRoots: choice.filePaths });
        },
        'migration:run': (_e, options) => migration.migrate(options),
        'python:export-logs': async (_e, id) => {
            const choice = await dialog.showSaveDialog(getWindow(), { title: '导出运行日志', defaultPath: '三人聚智-python日志.txt' });
            if (choice.canceled) return { canceled: true };
            const records = await python.getLogs(id);
            fs.writeFileSync(choice.filePath, records.map(r => `[${r.timestamp}] ${r.id} ${r.stream}: ${r.message}`).join('\n'), 'utf8');
            return { success: true };
        }
    };
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (event, ...args) => {
        try { return await handler(event, ...args); }
        catch (error) { return { success: false, error: error.message, code: error.code || '' }; }
    });
    return { list, managementList, run, python, environment, migration, importArchive,
        recordToolLog: event => runtimeLogs.append({ ...event, engine: 'tools' }),
        async searchEntries() { return (await python.list({ includeHidden: true })).map(p => { runtimeLogs.registerSource(p); return { ...p, logoUrl: p.iconPath ? pathToFileURL(p.iconPath).href : '', searchText: `${p.name}\n${p.description}\n${p.category || ''}\n${p.id}`.toLowerCase() }; }); },
        async startConfigured() {
            for (const item of await python.list({ includeHidden: true })) if (item.autoStart) {
                runtimeLogs.registerSource(item);
                try { const result = await python.run(item.id); if (result.requiresDependencies) send('notify', { title: 'Python 插件等待依赖确认', message: item.name, type: 'warning' }); }
                catch (error) { send('notify', { title: 'Python 插件未能自启动', message: `${item.name}：${error.message}`, type: 'warning' }); }
            }
        }
    };
}
module.exports = { createMergedHost, publicRuntime };
