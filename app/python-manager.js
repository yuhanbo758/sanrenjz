const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { decodeUtf8Stream } = require('./console-encoding');
const { removePluginPath, assertPluginAvailable } = require('./plugin-uninstall');
const { importLocalSoftware } = require('./python-support/software_store');
const { preparePluginConfig, safePluginId } = require('./python-support/plugin_config');
const { createPluginAppId, resolvePluginVisual } = require('./python-support/plugin_visual');

const SUPPORT_DIR = path.join(__dirname, 'python-support');
// 只识别已核实的标准模板，不能把恰好调用同名 helper 的自定义启动器覆盖掉。
const LEGACY_HELPER_HASHES = {
    'VBS运行.vbs': new Set(['d3ec37be1aa7d2122b5ce7ea0e7019cd1ad14d4c0f5aab86afb9e13c681ab6ec', '1584240a02548b1f101c6226a58f2945387575e5b597121ea7f2c59536f1380f', '9338b7da490fb9546b81d250cf4d258b1ad1ec8a4e0c642557eccc0960389a7b', 'e1be5e05f6d470aed2fd8fc1fcef098a5568cacf778eb33ab918d6e41b5ceba3']),
    'standalone_launcher.py': new Set(['de48adef7be52d9b62f458c4cfa9f7882337e898b984d6ced1db74b593fe1a03', '450f4fee41308c01555625979c7a768485ee98b8b462d86fdb7fb66aa7daf0f2']),
    'plugin_config_runtime.py': new Set(['5c4c795b7ce8fdaa63bc62cd847657bba3053ea3e8f342ab2c963f1a8ea94942'])
};

function helperHash(file) {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
    return crypto.createHash('sha256').update(text).digest('hex');
}
const INSPECT_REQUIREMENTS = String.raw`
import importlib.metadata as metadata, json, pathlib, re, sys
try:
    from packaging.requirements import Requirement
except ImportError:
    from pip._vendor.packaging.requirements import Requirement
missing = []
checked = {}
checking = set()

def installed(requirement):
    try:
        distribution = metadata.distribution(requirement.name)
    except metadata.PackageNotFoundError:
        return False
    if requirement.specifier and not requirement.specifier.contains(distribution.version, prereleases=True):
        return False
    key = (re.sub(r'[-_.]+', '-', requirement.name).lower(), tuple(sorted(requirement.extras)))
    if key in checked:
        return checked[key]
    if key in checking:
        return True
    checking.add(key)
    complete = True
    # 已安装基础包不代表 extras 完整；按分发元数据、extra 与环境标记检查实际依赖。
    contexts = [''] + list(requirement.extras)
    for text in distribution.requires or []:
        dependency = Requirement(text)
        if dependency.marker and not any(dependency.marker.evaluate({'extra': extra}) for extra in contexts):
            continue
        if not installed(dependency):
            complete = False
            break
    checking.remove(key)
    checked[key] = complete
    return complete

for raw in pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig').splitlines():
    text = raw.strip()
    if not text or text.startswith('#'):
        continue
    try:
        requirement = Requirement(text.split(' #', 1)[0])
        if requirement.marker and not requirement.marker.evaluate():
            continue
        if not installed(requirement):
            missing.append(str(requirement))
    except Exception:
        raise ValueError('依赖清单仅支持标准包名、版本约束和环境标记；请移除路径、URL及 pip 命令选项')
print(json.dumps(missing, ensure_ascii=False))
`;

function failure(message, code) {
    return Object.assign(new Error(message), { code });
}

function inside(root, target, allowEqual = false) {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return (allowEqual && relative === '') || Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function validateTree(root) {
    // 不跟随链接复制插件，避免清单、资源或替换操作逃出选择的目录。
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) throw failure('插件不能包含符号链接或目录联接', 'PLUGIN_INVALID');
            if (entry.isDirectory()) visit(file);
        }
    };
    visit(root);
}

class PythonManager {
    constructor({ pluginDir, userData, appRoot, loadSettings = () => ({}), saveSettings = () => {}, environment, onChanged = () => {}, onLog = () => {} }) {
        this.pluginDir = path.resolve(pluginDir);
        this.userData = path.resolve(userData);
        this.appRoot = path.resolve(appRoot || path.dirname(__dirname));
        this.loadSettings = loadSettings;
        this.saveSettings = saveSettings;
        this.environment = environment;
        this.onChanged = onChanged;
        this.onLog = onLog;
        this.running = new Map();
        this.pending = new Set();
        this.logs = [];
        this.closing = false;
    }

    _configRoot() {
        const settings = this.loadSettings() || {};
        const root = path.resolve(settings.pythonPluginConfigDir || settings.customPluginConfigDir || path.join(this.userData, 'python-plugin-configs'));
        if (inside(this.pluginDir, root, true) || inside(root, this.pluginDir, true)) {
            throw failure('Python 用户配置目录与插件程序目录不能互相包含', 'PLUGIN_CONFIG_INVALID');
        }
        return root;
    }

    _metadata(folder) {
        const metadataPath = path.join(folder, 'settings.json');
        if (!fs.existsSync(metadataPath)) return {};
        const metadata = readJson(metadataPath);
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw failure('Python 插件 settings.json 必须为对象', 'PLUGIN_INVALID');
        return metadata;
    }

    _entries(folder, { strict = false } = {}) {
        const metadata = this._metadata(folder);
        if (fs.existsSync(path.join(folder, 'plugin.json'))) throw failure('文件夹同时包含效率插件清单，无法作为 Python 插件导入', 'PLUGIN_INVALID');
        if (metadata.config_file !== undefined) {
            const config = typeof metadata.config_file === 'string' ? path.resolve(folder, metadata.config_file) : '';
            if (!config || !inside(folder, config) || path.extname(config).toLowerCase() !== '.json') {
                throw failure('Python 插件默认配置必须是插件目录内的 JSON 文件', 'PLUGIN_INVALID');
            }
        }
        if (metadata.main_file !== undefined) {
            if (typeof metadata.main_file !== 'string') throw failure('插件 main_file 必须为文件名', 'PLUGIN_INVALID');
            const entry = path.resolve(folder, metadata.main_file);
            if (!inside(folder, entry) || !/\.(py|enc)$/i.test(entry) || !fs.existsSync(entry) || !fs.statSync(entry).isFile() || !inside(fs.realpathSync(folder), fs.realpathSync(entry))) {
                throw failure('Python 插件入口必须为插件目录内存在的 .py 或 .enc 文件', 'PLUGIN_INVALID');
            }
            return [{ entry, metadata }];
        }
        const candidates = fs.readdirSync(folder, { withFileTypes: true })
            .filter((entry) => entry.isFile() && /\.(py|enc)$/i.test(entry.name) && !['plugin_config_runtime.py', 'standalone_launcher.py'].includes(entry.name))
            .map((entry) => path.join(folder, entry.name));
        const main = candidates.find((entry) => path.basename(entry) === '__main__.py');
        if (main) return [{ entry: main, metadata }];
        if (!candidates.length || (strict && candidates.length !== 1)) throw failure('请使用 settings.json.main_file 指定唯一 Python 插件入口', 'PLUGIN_INVALID');
        return candidates.map((entry) => ({ entry, metadata }));
    }

    _item(entry, folder, metadata = {}, standalone = false) {
        const relative = path.relative(this.pluginDir, entry).split(path.sep).join('/');
        const id = `python:${relative}`;
        const preferences = (this.loadSettings() || {}).pluginPreferences || {};
        const preference = preferences[id] || {};
        const visual = resolvePluginVisual({ folderPath: folder, settings: metadata,
            defaultLogoPath: path.join(path.dirname(__dirname), 'build', 'icon.png'),
            defaultIconPath: path.join(path.dirname(__dirname), 'build', 'icon.ico') });
        const configId = standalone ? safePluginId(path.parse(entry).name) : safePluginId(folder);
        const config = preparePluginConfig({ folderPath: folder, settings: standalone ? { config_file: `${path.basename(entry)}.config.json` } : metadata, configRoot: this._configRoot(), pluginId: configId, initialize: false });
        const details = ['README.md', 'FEATURES.md', '使用说明.md', '说明.md'].map((name) => path.join(folder, name)).find((file) => fs.existsSync(file));
        const requirements = standalone ? '' : path.join(folder, 'requirements.txt');
        return {
            id, engine: 'python', name: metadata.name || path.parse(entry).name,
            description: metadata.description || 'Python 程序', path: entry, folderPath: folder,
            iconPath: visual.macIconPath || visual.logoPath, logoPath: visual.logoPath,
            taskbarIconPath: visual.taskbarIconPath, macIconPath: visual.macIconPath,
            pluginAppId: createPluginAppId(standalone ? path.parse(entry).name : folder),
            category: metadata.category || '', version: metadata.version || '', author: metadata.author || '',
            mainFile: path.basename(entry), requirementsPath: requirements && fs.existsSync(requirements) ? requirements : '',
            configPath: config.configPath, detailFilePath: details || '',
            isRunning: this.running.has(id), hidden: preference.showInMainUI === false, autoStart: preference.autoStartWithMain === true,
            standalone, _metadata: metadata, _configId: configId
        };
    }

    list({ includeHidden = true } = {}) {
        if (!fs.existsSync(this.pluginDir)) return [];
        const items = [];
        for (const entry of fs.readdirSync(this.pluginDir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
            const target = path.join(this.pluginDir, entry.name);
            try {
                if (entry.isDirectory()) {
                    for (const candidate of this._entries(target)) items.push(this._item(candidate.entry, target, candidate.metadata));
                } else if (entry.isFile() && /\.(py|enc)$/i.test(entry.name)) {
                    items.push(this._item(target, this.pluginDir, {}, true));
                }
            } catch (error) {
                this._log(`python:${entry.name}`, 'system', `无法识别插件 ${entry.name}：${error.message}`);
            }
        }
        return items.filter((item) => includeHidden || !item.hidden).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    _find(id) {
        const item = this.list().find((candidate) => candidate.id === id);
        if (!item) throw failure('未找到 Python 程序，请刷新列表后重试', 'PLUGIN_NOT_FOUND');
        return item;
    }

    async importPath(sourcePath, { overwrite = false } = {}) {
        if (this.closing) throw failure('程序正在退出', 'APP_CLOSING');
        const source = path.resolve(sourcePath);
        if (fs.lstatSync(source).isSymbolicLink()) throw failure('不能导入符号链接', 'PLUGIN_INVALID');
        const stat = fs.statSync(source);
        if (stat.isDirectory()) {
            validateTree(source);
            this._entries(source, { strict: true });
        } else if (!stat.isFile() || !/\.(py|enc)$/i.test(source)) {
            throw failure('请选择 Python 文件或 Python 插件文件夹', 'PLUGIN_INVALID');
        }
        fs.mkdirSync(this.pluginDir, { recursive: true });
        const destination = path.join(this.pluginDir, path.basename(source));
        if (fs.existsSync(destination) && fs.realpathSync(source) !== fs.realpathSync(destination) && !overwrite) {
            throw failure('同名 Python 插件已存在，请确认替换', 'PLUGIN_EXISTS');
        }
        const activePaths = [...this.running.values()].map((record) => record.item.path);
        for (const id of this.pending) activePaths.push(this._find(id).path);
        let prepared = source;
        let workspace = '';
        let result;
        try {
            if (stat.isDirectory() && path.resolve(source) !== path.resolve(destination)) {
                workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-import-'));
                prepared = path.join(workspace, path.basename(source));
                // Node22在Windows复制中文目录的原生快路径可能崩溃；保留过滤回调以逐项复制。
                fs.cpSync(source, prepared, { recursive: true, filter: () => true });
                const candidate = this._entries(prepared, { strict: true })[0];
                if (!fs.existsSync(path.join(prepared, 'settings.json'))) {
                    fs.writeFileSync(path.join(prepared, 'settings.json'), JSON.stringify({ name: path.basename(source), main_file: path.relative(prepared, candidate.entry) }, null, 2), 'utf8');
                }
                if (/\.py$/i.test(candidate.entry)) this._installStandardHelpers(prepared);
            }
            result = importLocalSoftware(prepared, this.pluginDir, activePaths.map(file => fs.realpathSync(file)), this._configRoot());
        } finally {
            if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
        }
        // macOS 的 /var 与 /private/var 等别名指向同一目录，导入器返回物理路径。
        const importedPath = fs.realpathSync(result.path);
        const item = this.list().find((candidate) => fs.realpathSync(candidate.path) === importedPath || fs.realpathSync(candidate.folderPath) === importedPath);
        this._notifyChanged(item?.id);
        return { ...item, action: result.action };
    }

    _installStandardHelpers(folder) {
        const files = [
            { name: 'standalone_launcher.py', source: path.join(SUPPORT_DIR, 'standalone_launcher.py') },
            { name: 'VBS运行.vbs', source: path.join(SUPPORT_DIR, '插件启动.vbs') },
            { name: 'plugin_config_runtime.py', source: path.join(SUPPORT_DIR, 'plugin_config_runtime.py') }
        ];
        let current = true;
        for (const file of files) {
            const destination = path.join(folder, file.name);
            if (!fs.existsSync(destination)) { current = false; continue; }
            if (!fs.lstatSync(destination).isFile()) return { updated: false, reason: 'custom-helper', files: [] };
            const existing = helperHash(destination);
            const latest = helperHash(file.source);
            if (existing === latest) continue;
            current = false;
            if (!LEGACY_HELPER_HASHES[file.name].has(existing)) return { updated: false, reason: 'custom-helper', files: [] };
        }
        if (current) return { updated: false, reason: 'current', files: [] };
        // 先准备三个辅助文件，失败逐个恢复，避免迁移中断留下半组启动器。
        const workspace = fs.mkdtempSync(path.join(folder, '.standard-helpers-'));
        const installed = [];
        let preserveBackup = false;
        try {
            for (const file of files) fs.copyFileSync(file.source, path.join(workspace, file.name));
            for (const file of files) {
                const destination = path.join(folder, file.name);
                const backup = path.join(workspace, file.name + '.old');
                if (fs.existsSync(destination)) fs.copyFileSync(destination, backup);
                fs.renameSync(path.join(workspace, file.name), destination);
                installed.push({ destination, backup });
            }
        } catch (error) {
            const restoreErrors = [];
            for (const file of installed.reverse()) {
                try {
                    if (fs.existsSync(file.backup)) fs.copyFileSync(file.backup, file.destination);
                    else fs.rmSync(file.destination, { force: true });
                } catch (restoreError) { restoreErrors.push(restoreError); }
            }
            if (restoreErrors.length) {
                preserveBackup = true;
                throw failure(`启动器更新失败且部分文件无法恢复，原始辅助文件保留于 ${workspace}`, 'PLUGIN_HELPER_ROLLBACK_FAILED');
            }
            throw error;
        } finally {
            if (!preserveBackup) fs.rmSync(workspace, { recursive: true, force: true });
        }
        return { updated: true, reason: 'upgraded', files: files.map((file) => file.name) };
    }

    async upgradeStandardHelpers(folderPath) {
        const folder = path.resolve(folderPath);
        if (!inside(this.pluginDir, folder) || !fs.existsSync(folder) || !fs.lstatSync(folder).isDirectory()
            || !inside(fs.realpathSync(this.pluginDir), fs.realpathSync(folder))) {
            throw failure('只能更新新应用 Python 插件目录内的标准启动器', 'PLUGIN_INVALID');
        }
        const metadata = this._metadata(folder);
        const candidates = this._entries(folder);
        if (metadata.main_file === undefined && candidates.length !== 1) {
            return { folder, updated: false, reason: 'ambiguous-entry', files: [] };
        }
        if (!/\.py$/i.test(candidates[0].entry)) return { folder, updated: false, reason: 'encrypted-entry', files: [] };
        const candidateIds = candidates.map((candidate) => 'python:' + path.relative(this.pluginDir, candidate.entry).split(path.sep).join('/'));
        if ([...this.running.values()].some((record) => inside(folder, record.item.path, true)) || candidateIds.some((id) => this.pending.has(id))) throw failure('请先停止插件再更新启动器', 'PLUGIN_RUNNING');
        const result = this._installStandardHelpers(folder);
        if (result.updated) this._notifyChanged();
        return { folder, ...result };
    }

    _log(id, stream, message) {
        // 解释器环境和用户配置绝不写入日志；限制内存，避免长驻程序输出拖垮界面。
        const text = String(message).replace(/(["']?(?:authorization|token|password|secret|api[_-]?key|cookie)["']?\s*[:=]\s*)["']?[^\s,;}"']+["']?/gi, '$1[已隐藏]');
        const output = text.length > 16000 ? text.slice(0, 15970).replace(/[\uD800-\uDBFF]$/, '') + ' [输出过长，已截断]' : text;
        const entry = { id, stream, message: output, timestamp: new Date().toISOString() };
        this.logs.push(entry);
        if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
        try { Promise.resolve(this.onLog(entry)).catch(() => {}); } catch (_) { /* 页面通知失败不能中断插件进程。 */ }
    }

    _notifyChanged(id = '') {
        const failed = () => this._log(id, 'system', '插件状态刷新失败，请重新打开管理页。');
        // 刷新是异步通知，不能因目录暂时不可读而让已启动的子进程失去管理。
        try { Promise.resolve(this.onChanged()).catch(failed); } catch (_) { failed(); }
    }

    _pipeLogs(child, id) {
        for (const [stream, channel] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
            let buffered = '', truncated = false;
            decodeUtf8Stream(stream, text => {
                buffered += text;
                let boundary;
                while ((boundary = buffered.search(/[\r\n]/)) >= 0) {
                    const line = buffered.slice(0, boundary);
                    buffered = buffered.slice(boundary + 1);
                    if (!truncated && line) this._log(id, channel, line);
                    truncated = false;
                }
                // 按完整行脱敏，避免键名和值被拆成多块后漏记；超长行丢弃后续部分，限制内存。
                if (buffered.length > 65536) {
                    if (!truncated) this._log(id, channel, buffered);
                    buffered = ''; truncated = true;
                }
            });
            const flush = () => { if (buffered && !truncated) this._log(id, channel, buffered); buffered = ''; };
            stream.once('end', flush);
            stream.once('close', flush);
        }
    }

    getLogs(id) {
        return this.logs.filter((entry) => !id || entry.id === id).map((entry) => ({ ...entry }));
    }

    _env(runtime, item, config) {
        const environment = {
            ...(runtime.env || process.env), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONUNBUFFERED: '1',
            SANRENJZ_SETTINGS_FILE: path.join(this.userData, 'settings.json'),
            SANRENJZ_PYTHON_PLUGIN_DIR: this.pluginDir,
            SANRENJZ_PYTHON_SUPPORT_DIR: SUPPORT_DIR,
            SANRENJZ_PLUGIN_DIRECTORY: item.folderPath
        };
        if (config) {
            environment.YUHANBOPY_PLUGIN_CONFIG_FILE = config.configPath;
            environment.YUHANBOPY_PLUGIN_CONFIG_DIR = config.configRoot;
        }
        return environment;
    }

    async _capture(item, runtime, args) {
        return new Promise((resolve, reject) => {
            const child = spawn(runtime.executable, args, { cwd: item.folderPath, env: this._env(runtime, item), windowsHide: true });
            const record = { child, item, stage: 'dependencies' };
            this.running.set(item.id, record);
            let stdout = '', stderr = '';
            decodeUtf8Stream(child.stdout, text => { stdout = (stdout + text).slice(-65536); });
            decodeUtf8Stream(child.stderr, text => { stderr = (stderr + text).slice(-65536); });
            child.once('error', reject);
            child.once('close', (code, signal) => {
                if (this.running.get(item.id) === record) this.running.delete(item.id);
                if (record.cancelled || signal) reject(failure('操作已取消', 'PYTHON_CANCELLED'));
                else if (code !== 0) reject(failure(stderr.trim() || `Python 检查失败（退出码 ${code}）`, 'PYTHON_DEPENDENCY_CHECK_FAILED'));
                else resolve(stdout);
            });
        });
    }

    async dependencyPlan(id, resolvedRuntime) {
        const item = this._find(id);
        const runtime = resolvedRuntime || await this.environment.resolve();
        if (!item.requirementsPath || !fs.readFileSync(item.requirementsPath, 'utf8').split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith('#'))) {
            return { id, requiresDependencies: false, packages: [], requirementsPath: item.requirementsPath, executable: runtime.executable };
        }
        if (this.running.has(id)) throw failure('该程序正在运行或检查依赖', 'PLUGIN_RUNNING');
        if (runtime.pip === false) throw failure('所选 Python 未安装 pip，请在环境设置中修复或选择其他解释器', 'PYTHON_PIP_MISSING');
        const output = await this._capture(item, runtime, ['-c', INSPECT_REQUIREMENTS, item.requirementsPath]);
        let packages;
        try { packages = JSON.parse(output.trim().split(/\r?\n/).pop()); } catch (_) { throw failure('无法解析 Python 依赖检查结果', 'PYTHON_DEPENDENCY_CHECK_FAILED'); }
        return { id, requiresDependencies: packages.length > 0, packages, requirementsPath: item.requirementsPath, executable: runtime.executable };
    }

    async _installDependencies(item, runtime) {
        await new Promise((resolve, reject) => {
            const child = spawn(runtime.executable, ['-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple/', '-r', item.requirementsPath], {
                cwd: item.folderPath, env: this._env(runtime, item), windowsHide: true
            });
            const record = { child, item, stage: 'install' };
            this.running.set(item.id, record);
            this._notifyChanged(item.id);
            this._pipeLogs(child, item.id);
            child.once('error', reject);
            child.once('close', (code, signal) => {
                if (this.running.get(item.id) === record) this.running.delete(item.id);
                this._notifyChanged(item.id);
                if (record.cancelled || signal) reject(failure('依赖安装已取消', 'PYTHON_CANCELLED'));
                else if (code !== 0) reject(failure(`依赖安装失败（退出码 ${code}），请查看运行日志`, 'PYTHON_DEPENDENCY_INSTALL_FAILED'));
                else resolve();
            });
        });
    }

    async run(id, { installDependencies = false } = {}) {
        if (this.closing) throw failure('程序正在退出', 'APP_CLOSING');
        if (this.running.has(id) || this.pending.has(id)) throw failure('该 Python 程序已在运行', 'PLUGIN_RUNNING');
        this.pending.add(id);
        let temporary = '';
        try {
            const item = this._find(id);
            assertPluginAvailable(item.path);
            const runtime = await this.environment.resolve();
            if (!this.pending.has(id) || this.closing) throw failure('启动已取消', 'PYTHON_CANCELLED');
            const plan = await this.dependencyPlan(id, runtime);
            if (plan.requiresDependencies && !installDependencies) return plan;
            if (plan.requiresDependencies) await this._installDependencies(item, runtime);
            if (this.closing || !this.pending.has(id)) throw failure('启动已取消', 'PYTHON_CANCELLED');
            const config = preparePluginConfig({ folderPath: item.folderPath, settings: item.standalone ? { config_file: `${path.basename(item.path)}.config.json` } : item._metadata, configRoot: this._configRoot(), pluginId: item._configId });
            let entry = item.path;
            if (/\.enc$/i.test(entry)) {
                const content = fs.readFileSync(entry);
                try {
                    const key = Buffer.from(process.env.YUHANBOPY_ENC_KEY || '12345678901234567890123456789012');
                    const decipher = crypto.createDecipheriv('aes-256-cbc', key, content.subarray(0, 16));
                    const clear = Buffer.concat([decipher.update(content.subarray(16)), decipher.final()]);
                    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-python-'));
                    entry = path.join(temporary, path.basename(item.path, '.enc') + '.py');
                    fs.writeFileSync(entry, clear, { mode: 0o600 });
                } catch (_) { throw failure('加密插件无法解密，请检查授权或环境配置', 'PYTHON_DECRYPT_FAILED'); }
            }
            const args = [path.join(SUPPORT_DIR, 'plugin_bootstrap.py'), '--script', entry,
                '--plugin-dir', item.folderPath, '--logo', item.logoPath || '', '--icon', item.taskbarIconPath || '',
                '--mac-icon', item.macIconPath || '',
                '--config', config.configPath, '--config-dir', config.configRoot, '--app-id', item.pluginAppId];
            return await new Promise((resolve, reject) => {
                const child = spawn(runtime.executable, args, { cwd: item.folderPath, env: this._env(runtime, item, config), windowsHide: true });
                const record = { child, item, temporary, stage: 'run' };
                this.running.set(id, record);
                this._notifyChanged(id);
                const clean = () => {
                    if (this.running.get(id) === record) this.running.delete(id);
                    if (record.temporary) fs.rmSync(record.temporary, { recursive: true, force: true });
                    this._notifyChanged(id);
                };
                this._pipeLogs(child, id);
                child.once('spawn', () => { this._log(id, 'system', 'Python 程序已启动'); resolve({ success: true, id, pid: child.pid }); });
                child.once('error', () => { clean(); reject(failure('Python 程序启动失败，请检查所选解释器', 'PYTHON_START_FAILED')); });
                child.once('close', (code) => { clean(); this._log(id, 'system', record.cancelled ? 'Python 程序已停止' : `Python 程序已退出（${code}）`); });
            });
        } catch (error) {
            if (temporary && !this.running.has(id)) fs.rmSync(temporary, { recursive: true, force: true });
            throw error;
        } finally {
            this.pending.delete(id);
        }
    }

    async stop(id) {
        this.pending.delete(id);
        const record = this.running.get(id);
        if (!record) return { success: true, id };
        record.cancelled = true;
        await new Promise((resolve) => {
            let timer;
            const finish = () => { clearTimeout(timer); resolve(); };
            record.child.once('close', finish);
            timer = setTimeout(() => { try { record.child.kill('SIGKILL'); } catch (_) {} finish(); }, 4000);
            if (process.platform === 'win32') {
                const killer = spawn('taskkill', ['/PID', String(record.child.pid), '/T', '/F'], { windowsHide: true });
                killer.once('error', () => { try { record.child.kill(); } catch (_) {} });
            } else {
                try { record.child.kill('SIGTERM'); } catch (_) { finish(); }
            }
        });
        return { success: true, id };
    }

    async remove(id) {
        const item = this._find(id);
        const target = item.standalone ? item.path : item.folderPath;
        // 同一目录可能包含多个入口，任一入口运行或启动中均不能删除整目录。
        const affected = this.list().filter(candidate => candidate.path === target || (!item.standalone && candidate.folderPath === target));
        if (affected.some(candidate => this.running.has(candidate.id) || this.pending.has(candidate.id))) {
            throw failure('请先停止 Python 程序再卸载', 'PLUGIN_RUNNING');
        }
        await removePluginPath(this.pluginDir, target, `python:${path.basename(target)}`, { recursive: !item.standalone });
        this._notifyChanged(id);
        return { success: true, id, configPreserved: true };
    }

    async shutdown() {
        this.closing = true;
        this.pending.clear();
        await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
    }
}

module.exports = { PythonManager, inside };
