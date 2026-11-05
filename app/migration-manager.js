'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { safePluginId } = require('./python-support/plugin_config');

function exists(directory) { try { return fs.statSync(directory).isDirectory(); } catch (_) { return false; } }
function readObject(file) {
    if (!fs.existsSync(file)) return {};
    const result = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('设置文件不是JSON对象');
    return result;
}
function childDirectories(root) {
    if (!exists(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && !item.name.startsWith('.')).map(item => path.join(root, item.name));
}
function contains(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function sourceRoot(directory) {
    const base = path.basename(directory).toLowerCase();
    if (['plugins', 'python-plugins', 'plugin-configs', 'plugin-data'].includes(base)) return path.dirname(directory);
    if (['software', 'python-software'].includes(base) && path.basename(path.dirname(directory)).toLowerCase() === 'app') {
        const parent = path.dirname(path.dirname(directory));
        return path.basename(parent).toLowerCase() === 'resources' ? path.dirname(parent) : parent;
    }
    if (base === 'resources' && exists(path.join(directory, 'app'))) return path.dirname(directory);
    return directory;
}
function isProfile(root, product) {
    if (path.basename(root).toLowerCase() === (product === 'tools' ? 'sanrenjz-tools' : 'yuhanbopy-app')) return true;
    if (!fs.existsSync(path.join(root, 'settings.json'))) return false;
    const settings = readObject(path.join(root, 'settings.json'));
    return product === 'tools'
        ? exists(path.join(root, 'plugin-data')) || ['globalHotkey', 'pinHotkey', 'customPluginDataPath'].some(key => Object.hasOwn(settings, key))
        : ['pythonMode', 'customPythonPath', 'customPluginConfigDir', 'pythonPluginConfigDir'].some(key => Object.hasOwn(settings, key));
}
function mergedApplication(root) {
    try { if (readObject(path.join(root, 'package.json')).name === 'sanrenjz') return true; } catch (_) { }
    return fs.existsSync(path.join(root, 'resources', 'app', 'merged-host.js')) && fs.existsSync(path.join(root, 'resources', 'config', 'public-plugins.json'));
}
function privateEntry(name) {
    return /^(?:\.git|\.downloads|\.venv|node_modules|__pycache__|runtime|python|venv|logs?|Cache|Code Cache|GPUCache|Cookies(?:-journal)?|Login Data(?:-journal)?|Network|Local Storage|Session Storage|account-token\.bin)$/i.test(name) || /\.log$/i.test(name);
}
function environmentDirectory(directory) { return exists(directory) && fs.existsSync(path.join(directory, 'pyvenv.cfg')); }
function assertNoLinks(target) {
    let current = path.resolve(target);
    for (;;) {
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('迁移目录不能经过链接');
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
}
function pythonConfigFile(directory) {
    if (!fs.statSync(directory).isDirectory()) return '';
    const metadata = readObject(path.join(directory, 'settings.json'));
    const name = metadata.config_file === undefined ? 'config.json' : metadata.config_file;
    if (typeof name !== 'string' || !name.trim() || path.isAbsolute(name) || path.win32.isAbsolute(name)) throw new Error('Python配置文件路径无效');
    const normalized = name.replace(/\\/g, '/');
    if (normalized.split('/').some(part => part === '..' || part.includes(':'))) throw new Error('Python配置文件路径无效');
    const resolved = path.resolve(directory, normalized);
    if (!contains(directory, resolved) || resolved === directory || path.extname(resolved).toLowerCase() !== '.json') throw new Error('Python配置文件必须位于插件内');
    if (!fs.existsSync(resolved)) return '';
    assertNoLinks(resolved);
    if (!fs.statSync(resolved).isFile()) throw new Error('Python配置文件无效');
    return resolved;
}
function engineDirectories(root, engine) {
    if (!root) return [];
    const choices = engine === 'tools' ? ['plugins', 'app/software', 'resources/app/software'] : ['python-plugins', 'plugins', 'app/software', 'app/python-software', 'resources/app/software', 'resources/app/python-software'];
    const manifest = engine === 'tools' ? 'plugin.json' : 'settings.json';
    const seen = new Set();
    const candidates = choices.flatMap(name => {
        const base = path.join(root, name);
        if (engine === 'tools') return childDirectories(base);
        if (!exists(base)) return [];
        return fs.readdirSync(base, { withFileTypes: true }).filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || (entry.isFile() && /\.(py|enc)$/i.test(entry.name)))).map(entry => path.join(base, entry.name));
    });
    return candidates.filter(directory => {
        const id = path.basename(directory).toLowerCase();
        if (seen.has(id)) return false;
        const plainFile = engine === 'python' && fs.statSync(directory).isFile();
        const pythonWithoutMetadata = engine === 'python' && !plainFile && !fs.existsSync(path.join(directory, 'plugin.json')) && fs.readdirSync(directory, { withFileTypes: true }).some(entry => entry.isFile() && /\.(py|enc)$/i.test(entry.name) && !['plugin_config_runtime.py', 'standalone_launcher.py'].includes(entry.name));
        if (!plainFile && !pythonWithoutMetadata && !fs.existsSync(path.join(directory, manifest))) return false;
        seen.add(id); return true;
    });
}
function copySafe(source, destination, { exclude = false } = {}) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('迁移源包含链接，已停止复制');
    if (stat.isDirectory()) {
        if (environmentDirectory(source)) return;
        fs.mkdirSync(destination, { recursive: true });
        for (const name of fs.readdirSync(source)) {
            if (privateEntry(name) || environmentDirectory(path.join(source, name))) continue;
            // 用户已选择迁移插件配置：嵌套数据库和加密插件配置同样保留，账号会话仍由上方精确排除。
            copySafe(path.join(source, name), path.join(destination, name), { exclude });
        }
    } else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}
function copyMissing(source, target, record, created, base = source) {
    if (!exists(source)) return;
    if (environmentDirectory(source)) throw new Error('不能把Python环境目录作为插件配置迁移');
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || privateEntry(entry.name) || environmentDirectory(path.join(source, entry.name))) continue;
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (fs.existsSync(to)) {
            if (entry.isDirectory() && fs.lstatSync(to).isDirectory() && !fs.lstatSync(to).isSymbolicLink()) copyMissing(from, to, record, created, base);
            else { record.skipped++; record.conflicts.push({ type: 'config', id: path.relative(base, from), source: from, target: to, reason: '目标已存在，保留现有内容' }); }
            continue;
        }
        created.push(to);
        copySafe(from, to, { exclude: true }); record.copied++;
    }
}
function pythonEntries(directory) {
    const id = path.basename(directory);
    if (fs.statSync(directory).isFile()) return [id];
    const metadata = readObject(path.join(directory, 'settings.json'));
    if (metadata.main_file) {
        const entry = path.resolve(directory, String(metadata.main_file));
        if (!contains(directory, entry) || entry === directory || !/\.(?:py|enc)$/i.test(entry) || !fs.existsSync(entry)) throw new Error('Python入口无效');
        return [`${id}/${path.relative(directory, entry).replace(/\\/g, '/')}`];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(py|enc)$/i.test(entry.name) && !['plugin_config_runtime.py', 'standalone_launcher.py'].includes(entry.name)).map(entry => `${id}/${entry.name}`);
}
function safeId(root, product, profileRoot) {
    return crypto.createHash('sha256').update(`${root || ''}\0${product}\0${profileRoot || ''}`).digest('hex').slice(0, 20);
}
function selected(value, id) { return value === true || (Array.isArray(value) && value.includes(id)); }

class MigrationManager {
    constructor({ appRoot, userData, toolsDir, pythonDir, loadSettings, saveSettings, onChanged, inspectInterpreter, legacyRoots = [] }) {
        Object.assign(this, { appRoot, userData, toolsDir, pythonDir, loadSettings, saveSettings, onChanged, inspectInterpreter, legacyRoots });
        this.sources = new Map();
        this.busy = false;
    }
    detectInstallations() {
        if (process.platform !== 'win32') return [];
        try {
            // 仅解析卸载信息中的路径，绝不执行卸载命令；部分 NSIS 安装未填写 InstallLocation。
            const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $items=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue; @($items | Where-Object { $_.PSChildName -ne 'com.sanrenjz.app' -and $_.DisplayName -match '三人聚智|yuhanbopy|sanrenjz-tools' } | ForEach-Object { if ($_.InstallLocation) { [string]$_.InstallLocation } else { foreach ($candidate in @($_.DisplayIcon,$_.UninstallString,$_.QuietUninstallString)) { $match=[regex]::Match([string]$candidate,'^\\s*(?:\"([^\"]+\\.exe)\"|(.+?\\.exe))(?:,[-0-9]+)?(?:\\s|$)'); if ($match.Success) { $file=if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }; [System.IO.Path]::GetDirectoryName($file); break } } } }) | ConvertTo-Json -Compress";
            const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 7000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            const value = output ? JSON.parse(output) : [];
            return (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string');
        } catch (_) { return []; }
    }
    async inspect({ installationRoots = [] } = {}) {
        const appdata = process.env.APPDATA || path.dirname(this.userData);
        const profiles = { tools: path.join(appdata, 'sanrenjz-tools'), python: path.join(appdata, 'yuhanbopy-app') };
        const detected = this.detectInstallations();
        const roots = [...new Set([...detected, ...this.legacyRoots, ...installationRoots].filter(item => typeof item === 'string' && item.trim()).map(item => sourceRoot(path.resolve(item))))];
        const candidates = [];
        const currentRoots = [this.appRoot, this.userData, path.dirname(this.toolsDir), path.dirname(this.pythonDir)].map(current => path.resolve(current));
        const forbiddenSource = root => root && currentRoots.some(current => contains(current, root));
        const add = (root, product, profileRoot = profiles[product], origin = root ? 'installation' : 'profile') => {
            if (forbiddenSource(root) || forbiddenSource(profileRoot)) return;
            const settings = readObject(path.join(profileRoot, 'settings.json'));
            const toolsPlugins = product === 'tools' ? engineDirectories(root, 'tools') : [];
            const pythonPlugins = product === 'python' ? engineDirectories(root, 'python') : [];
            const toolsData = product === 'tools' ? path.resolve(settings.customPluginDataPath || path.join(profileRoot, 'plugin-data')) : '';
            const pythonConfigs = product === 'python' ? String(settings.pythonPluginConfigDir || settings.customPluginConfigDir || (root ? path.join(root, 'plugin-configs') : '')).trim() : '';
            if (!root && !exists(profileRoot)) return;
            const source = { id: safeId(root, product, profileRoot), product, root: root || '', profileRoot, toolsPlugins, pythonPlugins, toolsData, pythonConfigs, settings };
            this.sources.set(source.id, source);
            if (candidates.some(item => item.id === source.id)) return;
            const hasConfigs = exists(toolsData) || exists(pythonConfigs) || pythonPlugins.some(directory => { try { return Boolean(pythonConfigFile(directory)); } catch (_) { return false; } });
            const hasInterpreter = product === 'python' && settings.pythonMode === 'custom' && typeof settings.customPythonPath === 'string' && fs.existsSync(settings.customPythonPath);
            const hasPreferences = Object.keys(settings.pluginPreferences || {}).length > 0 || (product === 'tools' && Object.keys(settings.pluginSearchSettings || {}).length > 0);
            const configLocations = [[toolsData, 'tools-data', Boolean(settings.customPluginDataPath)], [pythonConfigs, 'python-configs', Boolean(settings.pythonPluginConfigDir || settings.customPluginConfigDir)]].filter(([directory]) => directory && exists(directory)).map(([directory, kind, custom]) => ({ kind, path: path.resolve(directory), custom }));
            candidates.push({ id: source.id, product, label: product === 'tools' ? '原效率工具' : '原Python程序管理', root: source.root, profileRoot, origin, toolsCount: toolsPlugins.length, pythonCount: pythonPlugins.length, hasConfigs, hasPreferences, hasInterpreter, importable: { toolsPlugins: toolsPlugins.length, pythonPlugins: pythonPlugins.length, configs: hasConfigs, preferences: hasPreferences, interpreter: hasInterpreter }, configLocations, descriptions: [root ? '从旧安装目录读取插件，结合原用户设置定位配置' : '从旧用户数据目录读取设置与配置；如需插件程序，可再选择旧安装目录', '只补充新应用缺少的内容；同名文件保留现有值并列入报告', '窗口选项随插件配置/数据迁入；不复制登录会话或 Python 环境，不启用旧自启动和全局快捷键'] });
        };
        const errors = [];
        for (const product of ['tools', 'python']) {
            try { add('', product); } catch (_) { errors.push({ product, error: '旧设置文件无法读取，请先检查JSON格式' }); }
        }
        const manualRoots = new Set(installationRoots.filter(item => typeof item === 'string' && item.trim()).map(item => sourceRoot(path.resolve(item))));
        for (const root of roots) {
            if (forbiddenSource(root) || mergedApplication(root)) {
                if (manualRoots.has(root)) errors.push({ root, error: '所选目录属于当前应用，不能作为旧应用迁移来源' });
                continue;
            }
            if (!exists(root)) {
                if (manualRoots.has(root)) errors.push({ root, error: '所选目录不存在或无法访问' });
                continue;
            }
            let recognized = false;
            for (const product of ['tools', 'python']) {
                try {
                    if (isProfile(root, product)) { recognized = true; add('', product, root, 'selection'); }
                    else if (engineDirectories(root, product).length || (product === 'python' && exists(path.join(root, 'plugin-configs')))) { recognized = true; add(root, product); }
                } catch (_) { errors.push({ product, root, error: '旧设置文件无法读取，请先检查JSON格式' }); }
            }
            if (!recognized && manualRoots.has(root)) errors.push({ root, error: '未识别到旧应用插件或用户数据，请选择旧安装目录或旧用户数据目录' });
        }
        return { sources: candidates, errors };
    }
    async migrate({ sourceId, toolsPlugins = false, pythonPlugins = false, configs = false, preferences: importPreferences = false, interpreter = false } = {}) {
        if (this.busy) throw new Error('迁移正在进行，请稍候');
        const source = this.sources.get(sourceId);
        if (!source) throw new Error('请先检查并选择有效的迁移来源');
        if (![toolsPlugins, pythonPlugins, configs, importPreferences, interpreter].some(value => value === true || (Array.isArray(value) && value.length))) throw new Error('请明确选择要迁移的内容');
        this.busy = true;
        const result = { success: true, copied: 0, skipped: 0, preferenceFields: 0, conflicts: [], errors: [], sourceId, restartRequired: false };
        const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const backup = path.join(this.userData, 'migration-backups', stamp);
        const settingsFile = path.join(this.userData, 'settings.json');
        const hadSettings = fs.existsSync(settingsFile);
        const created = [];
        const pythonImported = [];
        let phase = 'backup';
        const report = () => fs.writeFileSync(path.join(backup, 'report.json'), `${JSON.stringify({ ...result, timestamp: new Date().toISOString() }, null, 2)}\n`, 'utf8');
        try {
            fs.mkdirSync(backup, { recursive: true });
            if (fs.existsSync(settingsFile)) fs.copyFileSync(settingsFile, path.join(backup, 'settings.json'));
            const settings = this.loadSettings();
            const targets = { tools: this.toolsDir, python: this.pythonDir };
            const preferences = Object.assign(Object.create(null), settings.pluginPreferences || {});
            const keepStartupDisabled = id => {
                if (typeof preferences[id]?.autoStartWithMain !== 'boolean') preferences[id] = { ...preferences[id], autoStartWithMain: false };
            };
            phase = 'plugins';
            for (const [engine, selection] of [['tools', toolsPlugins], ['python', pythonPlugins]]) {
                assertNoLinks(targets[engine]);
                const directories = engine === 'tools' ? source.toolsPlugins : source.pythonPlugins;
                for (const directory of directories) {
                    const id = path.basename(directory);
                    if (!selected(selection, id)) continue;
                    const target = path.join(targets[engine], id);
                    if (fs.existsSync(target)) { result.skipped++; result.conflicts.push({ type: 'plugin', id, source: directory, target, reason: '同名插件已存在，保留程序文件；配置仍按独立选项补充' }); continue; }
                    const staging = `${target}.migration-${stamp}`;
                    try {
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        assertNoLinks(directory);
                        copySafe(directory, staging);
                        if (engine === 'tools') {
                            const metadata = readObject(path.join(staging, 'plugin.json'));
                            keepStartupDisabled(metadata.pluginName || id);
                        } else {
                            const entries = pythonEntries(directory);
                            for (const entry of entries) {
                                const key = `python:${entry}`;
                                keepStartupDisabled(key);
                            }
                        }
                        fs.renameSync(staging, target); created.push(target); result.copied++;
                        if (engine === 'python' && fs.statSync(target).isDirectory()) pythonImported.push(target);
                    } catch (_) {
                        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
                        result.errors.push({ engine, id, error: '复制失败，原项目及现有目标文件保持不变' });
                    }
                }
            }
            if (configs === true) {
                phase = 'configs';
                const toolTarget = path.resolve(settings.customPluginDataPath || path.join(this.userData, 'plugin-data'));
                const pythonTarget = path.resolve(settings.pythonPluginConfigDir || settings.customPluginConfigDir || path.join(this.userData, 'python-plugin-configs'));
                for (const [from, to, name] of [[source.toolsData, toolTarget, 'tools-data'], [source.pythonConfigs, pythonTarget, 'python-configs']]) {
                    if (!from || !exists(from)) continue;
                    if (path.resolve(from).toLowerCase() === to.toLowerCase()) {
                        result.skipped++; result.conflicts.push({ type: 'config', id: name, source: from, target: to, reason: '新旧应用已共用此配置目录，无需复制，保持原样' }); continue;
                    }
                    if (contains(from, to) || contains(to, from)) throw new Error('迁移来源与目标目录不能互相包含');
                    if (contains(from, source.profileRoot)) throw new Error('配置来源不能包含旧应用宿主用户目录');
                    if ([this.toolsDir, this.pythonDir, this.appRoot].some(root => contains(root, to))) throw new Error('配置迁移目标不能位于程序源码或插件目录');
                    assertNoLinks(from); assertNoLinks(to);
                    if (exists(to)) copySafe(to, path.join(backup, name));
                    const newToolNames = name === 'tools-data' ? fs.readdirSync(from).filter(file => file.endsWith('-storage.json') && !fs.existsSync(path.join(to, file))).map(file => file.slice(0, -'-storage.json'.length)) : [];
                    copyMissing(path.resolve(from), to, result, created);
                    for (const pluginName of newToolNames) if (fs.existsSync(path.join(to, `${pluginName}-storage.json`))) keepStartupDisabled(pluginName);
                }
                if (source.pythonPlugins.length) {
                    if ([this.toolsDir, this.pythonDir, this.appRoot].some(root => contains(root, pythonTarget))) throw new Error('配置迁移目标不能位于程序源码或插件目录');
                    assertNoLinks(pythonTarget);
                    if (exists(pythonTarget) && !fs.existsSync(path.join(backup, 'python-configs'))) copySafe(pythonTarget, path.join(backup, 'python-configs'));
                    for (const directory of source.pythonPlugins) {
                        const from = pythonConfigFile(directory);
                        if (!from) continue;
                        if (contains(directory, pythonTarget) || contains(pythonTarget, directory)) throw new Error('插件旁配置迁移来源与目标不能互相包含');
                        const to = path.join(pythonTarget, `${safePluginId(directory)}.json`);
                        if (fs.existsSync(to)) { result.skipped++; result.conflicts.push({ type: 'config', id: path.basename(to), source: from, target: to, reason: '统一用户配置已存在，保留现有内容' }); continue; }
                        fs.mkdirSync(pythonTarget, { recursive: true }); created.push(to);
                        copySafe(from, to); result.copied++;
                    }
                }
            }
            const update = { pluginPreferences: preferences };
            if (importPreferences === true) {
                phase = 'preferences';
                const addPreference = (id, key, value) => {
                    const current = preferences[id] || {};
                    if (Object.hasOwn(current, key)) {
                        if (current[key] !== value) { result.skipped++; result.conflicts.push({ type: 'preference', id: `${id}.${key}`, reason: '新应用已有该插件偏好，保留现有值' }); }
                        return;
                    }
                    preferences[id] = { ...current, [key]: value }; result.preferenceFields++;
                };
                if (source.product === 'tools') {
                    const names = new Set(childDirectories(this.toolsDir).flatMap(directory => { try { return [readObject(path.join(directory, 'plugin.json')).pluginName || path.basename(directory)]; } catch (_) { return []; } }));
                    for (const [id, value] of Object.entries(source.settings.pluginPreferences || {})) {
                        if (!names.has(id) || !value || typeof value !== 'object') continue;
                        if (typeof value.showInMainUI === 'boolean') addPreference(id, 'showInMainUI', value.showInMainUI);
                        keepStartupDisabled(id);
                    }
                    const searchSettings = Object.assign(Object.create(null), settings.pluginSearchSettings || {});
                    for (const [id, value] of Object.entries(source.settings.pluginSearchSettings || {})) {
                        if (!names.has(id) || !value || !Array.isArray(value.keywords) || !value.keywords.every(item => typeof item === 'string')) continue;
                        if (Object.hasOwn(searchSettings[id] || {}, 'keywords')) { result.skipped++; result.conflicts.push({ type: 'preference', id: `${id}.keywords`, reason: '新应用已有搜索关键词，保留现有值' }); continue; }
                        searchSettings[id] = { ...searchSettings[id], keywords: [...value.keywords] }; result.preferenceFields++;
                    }
                    update.pluginSearchSettings = searchSettings;
                } else {
                    for (const [oldId, value] of Object.entries(source.settings.pluginPreferences || {})) {
                        if (!value || typeof value !== 'object') continue;
                        const relative = oldId.replace(/^python:/, '').replace(/\\/g, '/');
                        const entry = path.resolve(this.pythonDir, relative);
                        if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || !contains(this.pythonDir, entry) || !/\.(py|enc)$/i.test(entry) || !fs.existsSync(entry)) continue;
                        const id = `python:${path.relative(this.pythonDir, entry).replace(/\\/g, '/')}`;
                        if (typeof value.hidden === 'boolean') addPreference(id, 'showInMainUI', !value.hidden);
                        else if (typeof value.showInMainUI === 'boolean') addPreference(id, 'showInMainUI', value.showInMainUI);
                        keepStartupDisabled(id);
                    }
                }
            }
            phase = 'interpreter';
            if (interpreter === true) {
                const executable = source.settings.customPythonPath;
                if (settings.pythonMode && settings.pythonMode !== 'none') {
                    result.skipped++; result.conflicts.push({ type: 'interpreter', id: 'pythonMode', reason: '新应用已有明确环境选择，保持原样；可在 Python 环境设置中手动更换' });
                } else if (source.settings.pythonMode === 'custom' && typeof executable === 'string' && path.isAbsolute(executable) && fs.existsSync(executable)) {
                    try {
                        if (typeof this.inspectInterpreter !== 'function') throw new Error('缺少解释器校验服务');
                        // 路径存在不代表Python可运行；只保存通过实际进程校验的解释器。
                        const runtime = await this.inspectInterpreter(executable);
                        if (!runtime || typeof runtime.executable !== 'string' || !path.isAbsolute(runtime.executable) || !/^3\.\d+\.\d+/.test(runtime.version || '') || Number(runtime.version.split('.')[1]) < 9) throw new Error('校验结果无效');
                        update.pythonMode = 'custom'; update.customPythonPath = runtime.executable;
                    } catch (_) {
                        result.errors.push({ phase: 'interpreter', error: '旧Python解释器未通过实际运行校验（需要Python 3.9或更新版本），已保留新应用原有环境选择；请在设置中重新检测或安装' });
                    }
                } else result.errors.push({ phase: 'interpreter', error: '来源没有可复用的自定义解释器，已保留新应用原有环境选择；请在设置中检测或安装Python' });
            }
            phase = 'settings';
            this.saveSettings(update);
            phase = 'helpers-and-refresh';
            if (this.onChanged) {
                const changed = await this.onChanged({ pythonImported });
                result.helperUpdates = (changed?.helperUpdates || []).map(item => ({
                    folder: item.folder, updated: item.updated === true, reason: String(item.reason || '').slice(0, 100),
                    ...(String(item.reason || '').startsWith('custom') ? { message: '自定义启动器已保留，未自动兼容新宿主' } : {})
                }));
                if (changed?.helperUpdates?.some(item => item.error || item.success === false)) result.errors.push({ phase: 'helpers', error: '标准启动辅助文件更新失败，请检查保留的备份与诊断日志' });
            }
            result.success = result.errors.length === 0;
            result.backupPath = backup;
            report();
            return result;
        } catch (error) {
            let rollbackComplete = true;
            for (const target of created) { try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { rollbackComplete = false; } }
            const previous = path.join(backup, 'settings.json');
            if (fs.existsSync(previous)) { try { fs.copyFileSync(previous, settingsFile); } catch (_) { rollbackComplete = false; } }
            else if (!hadSettings && fs.existsSync(settingsFile)) { try { fs.unlinkSync(settingsFile); } catch (_) { rollbackComplete = false; } }
            result.success = false;
            result.backupPath = backup;
            result.rolledBack = rollbackComplete;
            if (rollbackComplete) result.copied = 0;
            result.errors.push({ phase: error.phase || phase, error: rollbackComplete ? '迁移未完成，已撤回本次新增文件；原项目保持不变，备份已保留' : '迁移未完成，部分新增文件无法撤回；原项目保持不变，请检查保留的备份' });
            try { report(); } catch (_) { result.errors.push({ phase: 'report', error: '迁移报告无法写入，请检查新应用数据目录权限' }); }
            return result;
        } finally { this.busy = false; }
    }
}
module.exports = { MigrationManager };
