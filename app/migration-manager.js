'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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
        fs.mkdirSync(destination, { recursive: true });
        for (const name of fs.readdirSync(source)) {
            if (/^(?:\.git|node_modules|__pycache__|\.downloads|runtime|python|logs?|Cache|Code Cache|GPUCache|Cookies|Network|Local Storage|Session Storage)$/i.test(name)) continue;
            if (/^(?:account-token\.bin|Cookies|Login Data|.*\.log)$/i.test(name)) continue;
            // 用户已选择迁移插件配置：嵌套数据库和加密插件配置同样保留，账号会话仍由上方精确排除。
            copySafe(path.join(source, name), path.join(destination, name), { exclude });
        }
    } else fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}
function copyMissing(source, target, record, created) {
    if (!exists(source)) return;
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || /^(?:account-token\.bin|Cookies|Login Data|logs?|Cache|Code Cache|GPUCache|Network|Local Storage|Session Storage|runtime|python)$/i.test(entry.name) || /\.log$/i.test(entry.name)) continue;
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (fs.existsSync(to)) {
            if (entry.isDirectory() && fs.lstatSync(to).isDirectory() && !fs.lstatSync(to).isSymbolicLink()) copyMissing(from, to, record, created);
            else record.skipped++;
            continue;
        }
        created.push(to);
        copySafe(from, to, { exclude: true }); record.copied++;
    }
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
            const script = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $items=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue; @($items | Where-Object { $_.DisplayName -match '三人聚智|yuhanbopy|sanrenjz-tools' -and $_.InstallLocation } | ForEach-Object { $_.InstallLocation }) | ConvertTo-Json -Compress";
            const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 7000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            const value = output ? JSON.parse(output) : [];
            return (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string');
        } catch (_) { return []; }
    }
    async inspect({ installationRoots = [] } = {}) {
        const appdata = process.env.APPDATA || path.dirname(this.userData);
        const profiles = { tools: path.join(appdata, 'sanrenjz-tools'), python: path.join(appdata, 'yuhanbopy-app') };
        const roots = [...new Set([...this.detectInstallations(), ...this.legacyRoots, ...installationRoots].filter(item => typeof item === 'string').map(item => path.resolve(item)))];
        const candidates = [];
        const add = (root, product) => {
            if (root && [this.appRoot, path.dirname(this.toolsDir), path.dirname(this.pythonDir)].some(current => path.resolve(root).toLowerCase() === path.resolve(current).toLowerCase())) return;
            const profileRoot = profiles[product];
            const settings = readObject(path.join(profileRoot, 'settings.json'));
            const toolsPlugins = product === 'tools' ? engineDirectories(root, 'tools') : [];
            const pythonPlugins = product === 'python' ? engineDirectories(root, 'python') : [];
            const toolsData = product === 'tools' ? path.resolve(settings.customPluginDataPath || path.join(profileRoot, 'plugin-data')) : '';
            const pythonConfigs = product === 'python' ? (settings.customPluginConfigDir || (root ? path.join(root, 'plugin-configs') : '')) : '';
            if (!root && !exists(profileRoot)) return;
            const source = { id: safeId(root, product, profileRoot), product, root: root || '', profileRoot, toolsPlugins, pythonPlugins, toolsData, pythonConfigs, settings };
            this.sources.set(source.id, source);
            candidates.push({ id: source.id, product, label: product === 'tools' ? '原效率工具' : '原Python程序管理', root: source.root, profileRoot, toolsCount: toolsPlugins.length, pythonCount: pythonPlugins.length, hasConfigs: exists(toolsData) || exists(pythonConfigs), hasInterpreter: product === 'python' && settings.pythonMode === 'custom' && typeof settings.customPythonPath === 'string' && fs.existsSync(settings.customPythonPath) });
        };
        const errors = [];
        for (const product of ['tools', 'python']) {
            try { add('', product); } catch (_) { errors.push({ product, error: '旧设置文件无法读取，请先检查JSON格式' }); }
        }
        for (const root of roots.filter(exists)) {
            for (const product of ['tools', 'python']) {
                if (!engineDirectories(root, product).length) continue;
                try { add(root, product); } catch (_) { errors.push({ product, error: '旧设置文件无法读取，请先检查JSON格式' }); }
            }
        }
        return { sources: candidates, errors };
    }
    async migrate({ sourceId, toolsPlugins = false, pythonPlugins = false, configs = false, interpreter = false } = {}) {
        if (this.busy) throw new Error('迁移正在进行，请稍候');
        const source = this.sources.get(sourceId);
        if (!source) throw new Error('请先检查并选择有效的迁移来源');
        if (![toolsPlugins, pythonPlugins, configs, interpreter].some(value => value === true || (Array.isArray(value) && value.length))) throw new Error('请明确选择要迁移的内容');
        this.busy = true;
        const result = { success: true, copied: 0, skipped: 0, errors: [], sourceId, restartRequired: false };
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
            const preferences = { ...(settings.pluginPreferences || {}) };
            phase = 'plugins';
            for (const [engine, selection] of [['tools', toolsPlugins], ['python', pythonPlugins]]) {
                const directories = engine === 'tools' ? source.toolsPlugins : source.pythonPlugins;
                for (const directory of directories) {
                    const id = path.basename(directory);
                    if (!selected(selection, id)) continue;
                    const target = path.join(targets[engine], id);
                    if (fs.existsSync(target)) { result.skipped++; continue; }
                    const staging = `${target}.migration-${stamp}`;
                    try {
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        copySafe(directory, staging);
                        if (engine === 'tools') {
                            const metadata = readObject(path.join(staging, 'plugin.json'));
                            preferences[metadata.pluginName || id] = { ...preferences[metadata.pluginName || id], autoStartWithMain: false };
                        } else {
                            const plain = fs.statSync(staging).isFile();
                            const metadata = plain ? {} : readObject(path.join(staging, 'settings.json'));
                            const entries = plain ? [id] : metadata.main_file ? [`${id}/${String(metadata.main_file).replace(/\\/g, '/')}`] : fs.readdirSync(staging, { withFileTypes: true }).filter(entry => entry.isFile() && /\.(py|enc)$/i.test(entry.name) && !['plugin_config_runtime.py', 'standalone_launcher.py'].includes(entry.name)).map(entry => `${id}/${entry.name}`);
                            for (const entry of entries) {
                                const key = `python:${entry}`;
                                preferences[key] = { ...preferences[key], autoStartWithMain: false };
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
                const pythonTarget = path.resolve(settings.customPluginConfigDir || path.join(this.userData, 'python-plugin-configs'));
                for (const [from, to, name] of [[source.toolsData, toolTarget, 'tools-data'], [source.pythonConfigs, pythonTarget, 'python-configs']]) {
                    if (!from || !exists(from)) continue;
                    const relative = path.relative(path.resolve(from), to);
                    if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('迁移目标不能位于来源目录中');
                    if (exists(to)) copySafe(to, path.join(backup, name));
                    copyMissing(path.resolve(from), to, result, created);
                }
            }
            const update = { pluginPreferences: preferences };
            phase = 'interpreter';
            if (interpreter === true) {
                const executable = source.settings.customPythonPath;
                if (source.settings.pythonMode === 'custom' && typeof executable === 'string' && path.isAbsolute(executable) && fs.existsSync(executable)) {
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
