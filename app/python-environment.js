const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { unzipSync } = require('fflate');
const defaultManifest = require('../config/python-runtime.json');

function failure(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

function aborted(signal) {
    if (signal && signal.aborted) throw failure('PYTHON_INSTALL_CANCELLED', '已取消 Python 环境安装');
}

function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isStoreAlias(executable) {
    return /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(executable);
}

function createPythonEnv(runtime, baseEnv = process.env, platform = process.platform) {
    const env = { ...baseEnv };
    let inheritedPath = '';
    // 解释器切换时不能把上一套 Python、Conda 或 Tk 的库路径带给新环境。
    for (const key of Object.keys(env)) {
        const lower = key.toLowerCase();
        if (lower === 'path') { inheritedPath = env[key]; delete env[key]; }
        if (['pythonhome', 'pythonpath', 'tcl_library', 'tk_library', 'virtual_env', 'conda_prefix', 'conda_default_env'].includes(lower)) delete env[key];
    }
    const root = runtime.prefix || path.dirname(runtime.executable);
    const paths = [path.dirname(runtime.executable), root];
    if (platform === 'win32') paths.push(path.join(root, 'Scripts'), path.join(root, 'DLLs'), path.join(root, 'Library', 'bin'));
    else paths.push(path.join(root, 'bin'));
    env.PATH = [...new Set(paths.filter(Boolean)), inheritedPath].filter(Boolean).join(platform === 'win32' ? ';' : ':');
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    return env;
}

function runCommand(executable, args, { env, timeoutMs = 7000, signal, cwd } = {}) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(failure('PYTHON_INSTALL_CANCELLED', '已取消 Python 环境安装')); return; }
        let child;
        let timer;
        let settled = false;
        let stdout = '';
        let stderr = '';
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve(value);
        };
        const onAbort = () => {
            if (child) child.kill();
            finish(failure('PYTHON_INSTALL_CANCELLED', '已取消 Python 环境安装'));
        };
        try { child = spawn(executable, args, { env, cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (error) { finish(error); return; }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { child.kill(); finish(failure('PYTHON_CHECK_TIMEOUT', 'Python 环境检测超时')); }, timeoutMs);
        child.stdout.on('data', data => {
            stdout += data.toString('utf8');
            if (stdout.length > 1024 * 1024) { child.kill(); finish(failure('PYTHON_CHECK_OUTPUT', 'Python 检测输出超过限制')); }
        });
        child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-16000); });
        child.on('error', error => finish(error));
        child.on('close', code => {
            if (code === 0) finish(null, { stdout, stderr });
            else finish(failure('PYTHON_CHECK_FAILED', `Python 检测失败：${stderr.trim() || `退出码 ${code}`}`));
        });
    });
}

async function inspectRuntime(executable, options) {
    const script = [
        'import json, sys, struct, platform, importlib.util',
        'info = {"executable": sys.executable, "version": platform.python_version(), "major": sys.version_info[0], "prefix": sys.prefix, "architecture": platform.machine(), "bitness": struct.calcsize("P") * 8}',
        'info["pip"] = importlib.util.find_spec("pip") is not None',
        'info["venv"] = importlib.util.find_spec("venv") is not None',
        'try:',
        '    import ssl',
        '    info["ssl"] = True',
        'except Exception:',
        '    info["ssl"] = False',
        'try:',
        '    import tkinter as tk',
        '    info["tk"] = True',
        options.hiddenTk ? '    root = tk.Tk(); root.withdraw(); root.update_idletasks(); root.destroy(); info["tkWindow"] = True' : '    info["tkWindow"] = None',
        'except Exception as error:',
        '    info["tk"] = False; info["tkWindow"] = False; info["tkError"] = str(error)',
        'print(json.dumps(info, ensure_ascii=True))'
    ].join('\n');
    const { stdout } = await runCommand(executable, ['-B', '-X', 'utf8', '-c', script], { ...options, cwd: path.dirname(executable) });
    const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    return JSON.parse(lastLine || '');
}

function downloadArchive(url, destination, { signal, onProgress, maxBytes }, redirects = 0) {
    return new Promise((resolve, reject) => {
        aborted(signal);
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.python.org' || redirects > 4) {
            reject(failure('PYTHON_DOWNLOAD_URL', 'Python 下载地址必须为官方 HTTPS 地址')); return;
        }
        let settled = false;
        let output;
        let bytes = 0;
        const finish = error => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            if (error) { request.destroy(); if (output) output.destroy(); reject(error); }
            else resolve({ bytes });
        };
        const onAbort = () => finish(failure('PYTHON_INSTALL_CANCELLED', '已取消 Python 环境安装'));
        const request = https.get(parsed, { timeout: 30000, headers: { 'User-Agent': 'sanrenjz-python-runtime/1' } }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                signal.removeEventListener('abort', onAbort);
                settled = true;
                let next;
                try { next = new URL(response.headers.location, parsed).href; }
                catch (error) { reject(error); return; }
                downloadArchive(next, destination, { signal, onProgress, maxBytes }, redirects + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) { response.resume(); finish(failure('PYTHON_DOWNLOAD_HTTP', `Python 下载失败（HTTP ${response.statusCode}）`)); return; }
            const total = Number(response.headers['content-length']) || 0;
            if (total > maxBytes) { response.resume(); finish(failure('PYTHON_ARCHIVE_LIMIT', 'Python 安装包超过大小限制')); return; }
            output = fs.createWriteStream(destination, { flags: 'wx' });
            output.on('error', finish);
            output.on('finish', () => {
                if (total && total !== bytes) finish(failure('PYTHON_DOWNLOAD_INCOMPLETE', 'Python 安装包下载不完整'));
                else finish();
            });
            response.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > maxBytes) { finish(failure('PYTHON_ARCHIVE_LIMIT', 'Python 安装包超过大小限制')); return; }
                onProgress({ bytes, total });
            });
            response.on('error', finish);
            response.pipe(output);
        });
        request.on('error', finish);
        request.on('timeout', () => finish(failure('PYTHON_DOWNLOAD_TIMEOUT', 'Python 下载超时，请检查网络后重试')));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}

function safeArchiveName(name) {
    const normalized = name.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (!parts.length || normalized.startsWith('/') || parts.some(part => part === '.' || part === '..' || /[\0<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw failure('PYTHON_ARCHIVE_PATH', `Python 安装包含不安全路径：${name}`);
    }
    return parts.join('/');
}

function inspectArchive(bytes, limits) {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw failure('PYTHON_ARCHIVE_INVALID', 'Python 安装包不是受支持的 ZIP 文件');
    const count = bytes.readUInt16LE(end + 10);
    let offset = bytes.readUInt32LE(end + 16);
    if (count > limits.maxEntries || count === 65535 || bytes.readUInt16LE(end + 8) !== count || offset + bytes.readUInt32LE(end + 12) !== end) throw failure('PYTHON_ARCHIVE_LIMIT', 'Python 安装包目录超过限制');
    const entries = [];
    const seen = new Set();
    let total = 0;
    // 解压前检查中央目录，拒绝链接、大小炸弹和 Windows 大小写路径冲突。
    for (let index = 0; index < count; index++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw failure('PYTHON_ARCHIVE_INVALID', 'Python ZIP 目录损坏');
        const length = bytes.readUInt16LE(offset + 28);
        const next = offset + 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
        if (next > end || bytes.readUInt16LE(offset + 8) & 1) throw failure('PYTHON_ARCHIVE_INVALID', 'Python ZIP 目录损坏或已加密');
        const mode = bytes.readUInt32LE(offset + 38) >>> 16;
        if ((mode & 0o170000) === 0o120000) throw failure('PYTHON_ARCHIVE_PATH', 'Python 安装包不能包含符号链接');
        const original = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
        if (original.includes('\uFFFD')) throw failure('PYTHON_ARCHIVE_PATH', 'Python 安装包包含无效文件名');
        const name = safeArchiveName(original);
        const key = name.toLowerCase();
        if (seen.has(key)) throw failure('PYTHON_ARCHIVE_PATH', `Python 安装包含重复路径：${name}`);
        seen.add(key);
        const size = bytes.readUInt32LE(offset + 24);
        total += size;
        if (size > limits.maxEntryBytes || total > limits.maxExtractedBytes) throw failure('PYTHON_ARCHIVE_LIMIT', 'Python 解压后大小超过限制');
        entries.push({ original, name, size, directory: /[\\/]$/.test(original) });
        offset = next;
    }
    if (offset !== end || !seen.has('python.exe')) throw failure('PYTHON_ARCHIVE_INVALID', 'Python 安装包缺少解释器或目录损坏');
    return entries;
}

async function extractRuntimeArchive(bytes, directory, limits, { signal, onProgress = () => {} } = {}) {
    aborted(signal);
    const entries = inspectArchive(bytes, limits);
    const unpacked = unzipSync(new Uint8Array(bytes));
    let total = 0;
    for (let index = 0; index < entries.length; index++) {
        aborted(signal);
        const entry = entries[index];
        const target = path.resolve(directory, ...entry.name.split('/'));
        if (!isInside(directory, target)) throw failure('PYTHON_ARCHIVE_PATH', 'Python 解压路径越界');
        if (entry.directory) { await fs.promises.mkdir(target, { recursive: true }); continue; }
        const data = unpacked[entry.original];
        if (!data || data.length !== entry.size || (total += data.length) > limits.maxExtractedBytes) throw failure('PYTHON_ARCHIVE_INVALID', 'Python 安装包解压内容损坏');
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, data, { flag: 'wx' });
        delete unpacked[entry.original];
        if (index % 50 === 0 || index === entries.length - 1) onProgress(Math.round((index + 1) / entries.length * 100));
    }
}

class PythonEnvironment {
    constructor(options = {}) {
        this.appRoot = path.resolve(options.appRoot || path.join(__dirname, '..'));
        this.userData = options.userData || '';
        this.loadSettings = options.loadSettings || (() => ({}));
        this.saveSettings = options.saveSettings || (() => { throw new Error('未配置设置保存接口'); });
        this.onProgress = options.onProgress || (() => {});
        this.platform = options.platform || process.platform;
        this.arch = options.arch || process.arch;
        this.baseEnv = options.baseEnv || process.env;
        this.manifest = options.manifest || defaultManifest;
        this._inspectRuntime = options.inspectRuntime || inspectRuntime;
        this._download = options.download || downloadArchive;
        this._discoverCandidates = options.discoverCandidates;
        this._runCommand = options.runCommand || runCommand;
        this._ensureWritable = options.ensureWritable;
        this._controller = null;
        this._installPromise = null;
        this._progress = null;
        this._lastSettings = {};
        this._committing = false;
        this._closing = false;
    }

    _emit(phase, message, details = {}) {
        this._progress = { phase, message, ...details };
        try { this.onProgress({ ...this._progress }); } catch (_) { /* 界面通知异常不能中断环境安装。 */ }
    }

    async _settings() {
        const settings = await this.loadSettings();
        this._lastSettings = settings && typeof settings === 'object' ? settings : {};
        return this._lastSettings;
    }

    async _saveSelection(patch) {
        // 每次保存前重新合并宿主设置，避免覆盖插件管理等模块刚保存的字段。
        const settings = await this._settings();
        const merged = { ...settings, ...patch };
        await this.saveSettings(merged);
        this._lastSettings = merged;
    }

    status() {
        let settings = this._lastSettings;
        try {
            const latest = this.loadSettings();
            if (latest && typeof latest.then !== 'function') settings = this._lastSettings = latest;
        } catch (_) { /* 设置读取失败由实际运行入口报告。 */ }
        const mode = ['custom', 'managed'].includes(settings.pythonMode) ? settings.pythonMode : 'none';
        return {
            mode, configured: mode !== 'none',
            executable: mode === 'custom' ? (settings.customPythonPath || '') : mode === 'managed' ? (settings.managedPythonPath || '') : '',
            installing: Boolean(this._installPromise), progress: this._progress,
            supportedInstall: this.platform === 'win32' && Boolean(this.manifest.platforms[`${this.platform}-${this.arch}`])
        };
    }

    async inspect(executable, { hiddenTk = false, signal, timeoutMs = 7000 } = {}) {
        const input = String(executable || '').trim();
        if (!input || !path.isAbsolute(input) || isStoreAlias(input)) throw failure('PYTHON_INVALID', '请选择可运行的 Python 解释器绝对路径，不能使用商店占位别名');
        let selected = path.resolve(input);
        if (this.platform === 'win32' && /pythonw\.exe$/i.test(selected)) selected = selected.replace(/pythonw\.exe$/i, 'python.exe');
        try {
            if (!(await fs.promises.stat(selected)).isFile()) throw new Error('路径不是文件');
            const env = createPythonEnv({ executable: selected }, this.baseEnv, this.platform);
            const info = await this._inspectRuntime(selected, { env, timeoutMs, hiddenTk, signal });
            if ((info.major || Number(String(info.version).split('.')[0])) !== 3 || !/^3\.\d+\.\d+/.test(info.version || '') || Number(info.version.split('.')[1]) < 9) throw new Error('需要 Python 3.9 或更新的 Python 3 解释器');
            if (!info.prefix || !path.isAbsolute(info.prefix)) throw new Error('无法识别 Python 安装目录');
            return { ...info, executable: selected, prefix: path.resolve(info.prefix), bitness: Number(info.bitness) || 0, pip: Boolean(info.pip), tk: Boolean(info.tk) };
        } catch (error) {
            if (signal && signal.aborted) throw failure('PYTHON_INSTALL_CANCELLED', '已取消 Python 环境安装', error);
            throw failure('PYTHON_INVALID', `Python 环境不可用：${error.message}`, error);
        }
    }

    async resolve() {
        const settings = await this._settings();
        const mode = settings.pythonMode || 'none';
        if (!['custom', 'managed'].includes(mode)) throw failure('PYTHON_UNCONFIGURED', '尚未选择 Python 环境，请在设置中添加、检查或一键安装');
        const executable = mode === 'managed' ? settings.managedPythonPath : settings.customPythonPath;
        if (!executable) throw failure('PYTHON_INVALID', '已选 Python 环境路径为空，请重新选择');
        const info = await this.inspect(executable);
        return { ...info, mode, env: createPythonEnv(info, this.baseEnv, this.platform) };
    }

    async select(executable) {
        if (this._closing) throw failure('APP_CLOSING', '程序正在退出');
        if (this._installPromise) throw failure('PYTHON_INSTALL_BUSY', 'Python 环境正在安装，请完成或取消安装后再切换解释器');
        const info = await this.inspect(executable);
        if (this._closing) throw failure('APP_CLOSING', '程序正在退出');
        if (this._installPromise) throw failure('PYTHON_INSTALL_BUSY', 'Python 环境正在安装，请完成或取消安装后再切换解释器');
        await this._saveSelection({ pythonMode: 'custom', customPythonPath: info.executable });
        return { ...info, mode: 'custom', env: createPythonEnv(info, this.baseEnv, this.platform) };
    }

    async _candidates() {
        if (this._discoverCandidates) return this._discoverCandidates();
        const candidates = [];
        const add = value => { if (value && candidates.length < 160 && !isStoreAlias(value)) candidates.push(path.resolve(value)); };
        const scan = async (directory, match, name) => {
            if (!directory || isStoreAlias(directory)) return;
            try {
                const entries = await fs.promises.readdir(directory, { withFileTypes: true });
                for (const entry of entries.filter(item => match.test(item.name)).slice(0, 40)) add(name ? path.join(directory, entry.name, name) : path.join(directory, entry.name));
            } catch (_) { /* 某个失效目录不能中断整批环境发现。 */ }
        };
        const pathValue = Object.entries(this.baseEnv).find(([key]) => key.toLowerCase() === 'path');
        const directories = [...new Set(String(pathValue ? pathValue[1] : '').split(this.platform === 'win32' ? ';' : ':').filter(Boolean))].slice(0, 80);
        for (const directory of directories) await scan(directory, this.platform === 'win32' ? /^python(?:3(?:\.\d+)?)?\.exe$/i : /^python(?:3(?:\.\d+)?)?$/);
        const settings = await this._settings();
        add(settings.customPythonPath); add(settings.managedPythonPath);
        await scan(path.join(this.appRoot, 'runtime', 'python'), /^cpython-/, this.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
        if (this.platform === 'win32') {
            const env = this.baseEnv;
            const launchers = [...directories.map(dir => path.join(dir, 'py.exe')), env.WINDIR && path.join(env.WINDIR, 'py.exe'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', 'py.exe')];
            const launcher = launchers.find(file => file && !isStoreAlias(file) && fs.existsSync(file));
            if (launcher) {
                try {
                    const result = await this._runCommand(launcher, ['-0p'], { env, timeoutMs: 5000 });
                    for (const line of result.stdout.split(/\r?\n/)) {
                        const match = line.match(/([A-Za-z]:\\.*?python(?:w|3(?:\.\d+)?)?\.exe)\s*"?\s*$/i);
                        if (match) add(match[1]);
                    }
                } catch (_) { /* 旧 launcher 失败时继续检查注册表与常见目录。 */ }
            }
            const reg = env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'reg.exe') : 'reg.exe';
            for (const [hive, view] of [['HKCU', '64'], ['HKLM', '64'], ['HKLM', '32']]) {
                try {
                    const result = await this._runCommand(reg, ['query', `${hive}\\Software\\Python\\PythonCore`, '/s', `/reg:${view}`], { env, timeoutMs: 4000 });
                    for (const line of result.stdout.split(/\r?\n/)) {
                        const match = line.match(/\sREG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/);
                        if (!match) continue;
                        const value = match[1].replace(/%([^%]+)%/g, (_, key) => env[key] || `%${key}%`);
                        if (/python(?:w)?\.exe$/i.test(value)) add(value);
                        else if (/^[A-Za-z]:\\/.test(value) && /[\\/]$/.test(value)) add(path.join(value, 'python.exe'));
                    }
                } catch (_) { /* 非管理员或空注册表属于正常发现结果。 */ }
            }
            for (const directory of [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Python'), env.ProgramFiles, env['ProgramFiles(x86)'], env.SystemDrive && `${env.SystemDrive}\\`]) await scan(directory, /^Python[\d.-]*/i, 'python.exe');
            if (env.USERPROFILE) {
                add(path.join(env.USERPROFILE, 'anaconda3', 'python.exe')); add(path.join(env.USERPROFILE, 'miniconda3', 'python.exe'));
                await scan(path.join(env.USERPROFILE, '.pyenv', 'pyenv-win', 'versions'), /^\d+\./, 'python.exe');
            }
        } else {
            for (const directory of ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) await scan(directory, /^python3(?:\.\d+)?$/);
            if (this.platform === 'darwin') await scan('/Library/Frameworks/Python.framework/Versions', /^3\.\d+$/, path.join('bin', 'python3'));
        }
        return candidates;
    }

    async discover() {
        this._emit('discovering', '正在检查电脑中已安装的 Python 环境');
        const paths = await this._candidates();
        const unique = new Map();
        for (const item of paths.slice(0, 160)) {
            const executable = typeof item === 'string' ? item : item.executable;
            if (!executable || isStoreAlias(executable)) continue;
            try {
                const real = await fs.promises.realpath(executable);
                const key = this.platform === 'win32' ? real.toLowerCase() : real;
                if (!unique.has(key)) unique.set(key, executable);
            } catch (_) { /* 忽略失效候选。 */ }
        }
        const queue = [...unique.values()];
        const found = [];
        const worker = async () => {
            while (queue.length) {
                const executable = queue.shift();
                try { found.push(await this.inspect(executable, { timeoutMs: 4000 })); } catch (_) { /* 一个坏版本不能丢掉其余可用环境。 */ }
            }
        };
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
        found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }) || a.executable.localeCompare(b.executable));
        this._emit('discovered', `找到 ${found.length} 个可用 Python 环境`);
        return found;
    }

    async _prepareDirectory(root) {
        if (this._ensureWritable) await this._ensureWritable(root);
        await fs.promises.mkdir(this.appRoot, { recursive: true });
        const actualApp = await fs.promises.realpath(this.appRoot);
        let current = this.appRoot;
        for (const part of ['runtime', 'python']) {
            current = path.join(current, part);
            try {
                const stat = await fs.promises.lstat(current);
                if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('PYTHON_INSTALL_PATH', 'Python 安装目录不能是链接或普通文件');
            } catch (error) {
                if (error.code === 'ENOENT') await fs.promises.mkdir(current);
                else throw error;
            }
        }
        if (!isInside(actualApp, await fs.promises.realpath(root))) throw failure('PYTHON_INSTALL_PATH', 'Python 安装目录必须位于程序安装目录内');
        await fs.promises.access(root, fs.constants.W_OK);
    }

    async _verifyManaged(executable, entry, signal) {
        const info = await this.inspect(executable, { hiddenTk: true, signal, timeoutMs: 15000 });
        if (info.version !== entry.version || info.bitness !== 64 || !['amd64', 'x86_64', 'x64'].includes(String(info.architecture).toLowerCase()) || !info.pip || !info.tk || !info.tkWindow || !info.ssl || !info.venv) {
            throw failure('PYTHON_MANAGED_INVALID', 'Python 安装验证失败：需要正确版本和架构，以及可用的 pip、SSL、venv 和 Tk 图形环境');
        }
        return info;
    }

    install() {
        if (this._closing) return Promise.reject(failure('APP_CLOSING', '程序正在退出'));
        if (this._installPromise) return Promise.reject(failure('PYTHON_INSTALL_BUSY', 'Python 环境正在安装中'));
        const entry = this.manifest.platforms[`${this.platform}-${this.arch}`];
        if (this.platform !== 'win32' || !entry) return Promise.reject(failure('PYTHON_INSTALL_UNSUPPORTED', '当前平台请手动选择或检查已安装的 Python 环境；一键安装支持 Windows x64'));
        if (!/^3\.\d+\.\d+$/.test(entry.version) || !/^[a-f0-9]{64}$/i.test(entry.sha256) || !String(entry.url).startsWith('https://www.python.org/')) return Promise.reject(failure('PYTHON_MANIFEST_INVALID', 'Python 运行时清单无效'));
        this._controller = new AbortController();
        this._committing = false;
        this._installPromise = Promise.resolve().then(() => this._install(entry, this._controller.signal)).finally(() => {
            this._controller = null; this._installPromise = null; this._committing = false;
        });
        return this._installPromise;
    }

    async _install(entry, signal) {
        const root = path.join(this.appRoot, 'runtime', 'python');
        const destination = path.join(root, `cpython-${entry.version}-${this.arch}`);
        let staging;
        let created = false;
        try {
            this._emit('preparing', '正在检查 Python 安装目录');
            await this._prepareDirectory(root);
            aborted(signal);
            let exists = false;
            try {
                const stat = await fs.promises.lstat(destination);
                if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('PYTHON_INSTALL_PATH', '现有 Python 路径不是安全的环境目录');
                exists = true;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            let info;
            if (exists) {
                this._emit('verifying', '正在验证已有的应用专用 Python 环境');
                info = await this._verifyManaged(path.join(destination, 'python.exe'), entry, signal);
            } else {
                staging = await fs.promises.mkdtemp(path.join(root, '.staging-'));
                const archive = path.join(staging, 'runtime.zip.part');
                this._emit('downloading', '正在下载 Python 官方完整运行环境', { percent: 0 });
                await this._download(entry.url, archive, {
                    signal, maxBytes: entry.maxDownloadBytes,
                    onProgress: ({ bytes, total }) => this._emit('downloading', '正在下载 Python 官方完整运行环境', { bytes, total, percent: total ? Math.floor(bytes / total * 100) : undefined })
                });
                aborted(signal);
                if ((await fs.promises.stat(archive)).size > entry.maxDownloadBytes) throw failure('PYTHON_ARCHIVE_LIMIT', 'Python 安装包超过大小限制');
                this._emit('checking', '正在校验 Python 安装包');
                const bytes = await fs.promises.readFile(archive);
                if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw failure('PYTHON_HASH_MISMATCH', 'Python 安装包校验失败，请重新下载');
                aborted(signal);
                const payload = path.join(staging, 'payload');
                await fs.promises.mkdir(payload);
                this._emit('extracting', '正在解压 Python 环境', { percent: 0 });
                await extractRuntimeArchive(bytes, payload, entry, { signal, onProgress: percent => this._emit('extracting', '正在解压 Python 环境', { percent }) });
                this._emit('verifying', '正在验证 Python、pip 和 Tk 图形环境');
                await this._verifyManaged(path.join(payload, 'python.exe'), entry, signal);
                aborted(signal);
                // 所有验证完成后才发布新目录；从不覆盖已有环境。
                if (fs.existsSync(destination)) throw failure('PYTHON_INSTALL_BUSY', '另一操作已创建同版本环境，请重试以复用该环境');
                await fs.promises.rename(payload, destination);
                created = true;
                info = await this._verifyManaged(path.join(destination, 'python.exe'), entry, signal);
            }
            aborted(signal);
            this._committing = true;
            await this._saveSelection({ pythonMode: 'managed', managedPythonPath: path.join(destination, 'python.exe') });
            this._emit('complete', 'Python 环境安装完成，已选为当前环境', { percent: 100 });
            return { ...info, mode: 'managed', env: createPythonEnv(info, this.baseEnv, this.platform) };
        } catch (error) {
            if (created) await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => {});
            const reported = signal.aborted ? failure('PYTHON_INSTALL_CANCELLED', '已取消 Python 环境安装') : ['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? failure('PYTHON_INSTALL_PERMISSION', `无法写入程序安装目录：${root}。请使用可写的安装目录，或选择已有 Python 环境`, error) : error;
            this._emit(reported.code === 'PYTHON_INSTALL_CANCELLED' ? 'cancelled' : 'error', reported.message);
            throw reported;
        } finally {
            if (staging) await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
        }
    }

    cancel() {
        if (!this._controller || this._committing) return { cancelled: false };
        this._controller.abort();
        return { cancelled: true };
    }

    async shutdown() {
        this._closing = true;
        const pending = this._installPromise;
        this.cancel();
        if (!pending) return { success: true, cancelled: false };
        // 等待 finally 清理暂存目录后再允许宿主退出，避免留下半个运行时。
        try { await pending; return { success: true, cancelled: false }; }
        catch (error) {
            const cancelled = error.code === 'PYTHON_INSTALL_CANCELLED';
            return { success: cancelled, cancelled, ...(cancelled ? {} : { error: error.message, code: error.code || '' }) };
        }
    }
}

module.exports = { PythonEnvironment, createPythonEnv, inspectArchive, extractRuntimeArchive };
