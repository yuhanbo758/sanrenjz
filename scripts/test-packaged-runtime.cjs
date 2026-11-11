'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const WebSocket = require('ws');
const { resolvePackageLayout } = require('./package-local');

const TARGETS = { win: 'win32', mac: 'darwin', linux: 'linux' };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function failure(code) { return Object.assign(new Error(code), { code }); }

function runtimeArguments(platform) {
    const args = ['--remote-debugging-port=0', '--disable-gpu'];
    // 仅CI隔离进程绕过沙盒和有限/dev/shm，产品启动参数不改变。
    if (platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
    return args;
}

function sanitizeSystemLine(line, roots = []) {
    let result = String(line);
    const field = '[a-z0-9_-]*(?:authorization|api[_-]?key|access[_-]?token|password|passwd|secret|token|cookie)[a-z0-9_-]*';
    result = result.replace(new RegExp(`(["']?${field}["']?\\s*[:=]\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;]+)`, 'gi'), '$1[REDACTED]');
    result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]{6,}/gi, '$1 [REDACTED]');
    result = result.replace(/(["']?authorization["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
    for (const root of roots.filter(Boolean).sort((left, right) => right.length - left.length)) result = result.split(root).join('[PATH]');
    result = result.replace(/\bfile:\/\/[^\s"'<>|)\]}]+/gi, '[PATH]');
    result = result.replace(/\/dev\/shm\b/g, '[system-shm]');
    result = result.replace(/(?:[a-z]:[\\/]|\\\\)[^\s"'<>|)\]}]+/gi, '[PATH]');
    result = result.replace(/(^|[\s(=:])\/(?!\/)[^\s"'<>|)\]}]+/g, '$1[PATH]');
    result = result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
    return result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 700);
}

function createSystemDiagnostics(roots = []) {
    const decoder = new StringDecoder('utf8');
    const collected = [];
    let pending = '', discardUntilNewline = false;
    const add = line => {
        if (line.length > 16000 || !/\b(?:FATAL|ERROR|SIGBUS|SIGSEGV|SIGABRT)\b|\/dev\/shm|shared[ _-]?memory|\bmmap\b|bus error|received signal|error while loading shared libraries/i.test(line)) return;
        const safe = sanitizeSystemLine(line, roots);
        if (!safe || collected.includes(safe)) return;
        collected.push(safe);
        while (collected.length > 8 || collected.join('\n').length > 5000) collected.shift();
    };
    const consume = text => {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
            if (discardUntilNewline) { discardUntilNewline = false; continue; }
            add(line);
        }
        if (pending.length > 16000) { pending = ''; discardUntilNewline = true; }
    };
    return {
        write(chunk) { consume(decoder.write(chunk)); },
        end() { consume(decoder.end()); if (pending && !discardUntilNewline) add(pending); pending = ''; },
        lines() { return [...collected]; }
    };
}

function linuxCapacity() {
    const result = { freeMemoryBytes: os.freemem() };
    for (const [key, directory] of [['sharedMemoryAvailableBytes', '/dev/shm'], ['temporaryStorageAvailableBytes', os.tmpdir()]]) {
        try { const stat = fs.statfsSync(directory); result[key] = stat.bsize * stat.bavail; } catch {}
    }
    return result;
}

function parseOptions(args = process.argv.slice(2)) {
    const result = {};
    for (let index = 0; index < args.length; index += 2) {
        const option = args[index];
        if (!['--platform', '--arch'].includes(option) || !args[index + 1] || result[option.slice(2)]) throw failure('INVALID_ARGUMENTS');
        result[option.slice(2)] = args[index + 1];
    }
    if (!TARGETS[result.platform] || !['x64', 'arm64'].includes(result.arch) || (result.platform !== 'mac' && result.arch !== 'x64')) throw failure('UNSUPPORTED_TARGET');
    return result;
}

function locatePackage(root, options, pkg) {
    const dist = path.join(root, 'dist');
    const entries = fs.readdirSync(dist, { withFileTypes: true });
    if (entries.some(entry => /^personal-(?:stage|package)-/.test(entry.name))) throw failure('PERSONAL_PACKAGE_PRESENT');
    const packages = entries.filter(entry => /^public-package-\d+-\d+$/.test(entry.name));
    if (packages.length !== 1 || !packages[0].isDirectory() || packages[0].isSymbolicLink()) throw failure('AMBIGUOUS_PACKAGE');
    const layout = resolvePackageLayout(path.join(dist, packages[0].name), options, pkg);
    const binary = layout.executable || layout.binary;
    for (const file of [binary, path.join(layout.resources, 'app.asar')]) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw failure('INVALID_PACKAGED_BINARY');
    }
    return { ...layout, binary };
}

function validateMacDockResources(resources, platform, arch, run = spawnSync) {
    if (platform !== 'mac') return;
    for (const relative of ['app/plugin_runtime/mac-dock.js', 'app/native/mac-dock-helper']) {
        const file = path.join(resources, relative);
        if (!fs.existsSync(file)) throw failure('MAC_DOCK_RESOURCE_MISSING');
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw failure('MAC_DOCK_RESOURCE_INVALID');
    }
    const helper = path.join(resources, 'app/native/mac-dock-helper');
    if (!(fs.statSync(helper).mode & 0o111)) throw failure('MAC_DOCK_HELPER_NOT_EXECUTABLE');
    const inspected = run('/usr/bin/lipo', ['-archs', helper], { encoding: 'utf8' });
    if (inspected.status !== 0 || inspected.stdout.trim() !== (arch === 'x64' ? 'x86_64' : arch)) throw failure('MAC_DOCK_HELPER_ARCHITECTURE');
}

function isolatedEnvironment(base, { platform, profile, pluginRoot }) {
    const env = { ...base, SANRENJZ_ACCEPTANCE: '1', SANRENJZ_USER_DATA: profile, SANRENJZ_TEST_HIDDEN: '1', SANRENJZ_PYTHON_LIVE: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SANRENJZ_REMOTE_ACCEPTANCE;
    if (platform === 'win') env.PORTABLE_EXECUTABLE_DIR = pluginRoot;
    else delete env.PORTABLE_EXECUTABLE_DIR;
    return env;
}

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function waitFor(predicate, timeout = 25000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (await predicate()) return;
        await sleep(80);
    }
    throw failure('WAIT_TIMEOUT');
}

async function settleWithin(promise, milliseconds) {
    let timer;
    try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
    finally { clearTimeout(timer); }
}

async function stopOwnedProcess(child, closed) {
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    } else {
        // Unix独立进程组只包含本次验收及其子进程，避免误杀同名用户应用。
        try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch {} }
        await settleWithin(closed, 1500);
        if (child.exitCode === null && !child.signalCode) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch {} }
        }
    }
    await settleWithin(closed, 5000);
}

function connectCdp(address) {
    const socket = new WebSocket(address);
    const pending = new Map();
    let serial = 0;
    const opened = new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => reject(failure('CDP_CONNECT_FAILED')));
    });
    const rejectPending = code => {
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure(code)); }
        pending.clear();
    };
    socket.on('error', () => rejectPending('CDP_DISCONNECTED'));
    socket.once('close', () => rejectPending('CDP_DISCONNECTED'));
    socket.on('message', bytes => {
        let value;
        try { value = JSON.parse(String(bytes)); } catch { return; }
        if (!value.id || !pending.has(value.id)) return;
        const request = pending.get(value.id);
        pending.delete(value.id);
        clearTimeout(request.timer);
        value.error ? request.reject(failure('CDP_REQUEST_FAILED')) : request.resolve(value.result);
    });
    async function evaluate(expression) {
        await opened;
        if (socket.readyState !== WebSocket.OPEN) throw failure('CDP_DISCONNECTED');
        const id = ++serial;
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(failure('CDP_REQUEST_TIMEOUT')); }, 15000);
            pending.set(id, { resolve, reject, timer });
            socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        });
        if (result.exceptionDetails) throw failure('PACKAGED_SCRIPT_FAILED');
        return result.result?.value;
    }
    function close() {
        rejectPending('CDP_CLOSED');
        socket.close();
    }
    return { opened, evaluate, close };
}

async function runSmoke({ root = path.resolve(__dirname, '..'), platform, arch, timeout = 120000 } = {}) {
    const report = {
        schemaVersion: 1, target: `${platform}-${arch}`, platform: TARGETS[platform], arch,
        version: null, sourceCommit: /^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null,
        isolation: 'temporary-profile-and-plugin-root', assertions: [], errors: [], bundledPython: false, success: false
    };
    let stage = 'preflight', child, closed = Promise.resolve(), cdp, sandbox, deadline, cancelled = false, diagnostics;
    const record = (condition, label) => {
        if (cancelled) throw failure('SMOKE_CANCELLED');
        if (!condition) throw failure('ASSERTION_FAILED');
        report.assertions.push(label);
    };
    try {
        if (!TARGETS[platform] || !['x64', 'arm64'].includes(arch) || (platform !== 'mac' && arch !== 'x64')) throw failure('UNSUPPORTED_TARGET');
        if (process.platform !== TARGETS[platform] || process.arch !== arch) throw failure('NATIVE_RUNNER_REQUIRED');
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        report.version = pkg.version;
        const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config/public-plugins.json'), 'utf8'));
        const layout = locatePackage(root, { platform, arch }, pkg);
        validateMacDockResources(layout.resources, platform, arch);
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-native-smoke-'));
        const profile = path.join(sandbox, 'profile');
        const pluginRoot = platform === 'win' ? path.join(sandbox, 'portable') : profile;
        fs.mkdirSync(profile); fs.mkdirSync(pluginRoot, { recursive: true });
        fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ migrationPrompted: true }));
        const env = isolatedEnvironment(process.env, { platform, profile, pluginRoot });
        const args = runtimeArguments(platform);
        if (platform === 'linux') env.ELECTRON_ENABLE_STACK_DUMPING = '1';
        child = spawn(layout.binary, args, { env, cwd: sandbox, windowsHide: true, detached: platform !== 'win', stdio: ['ignore', 'pipe', 'pipe'] });
        let spawnFailed = false, exited = false;
        child.once('error', () => { spawnFailed = true; });
        closed = new Promise(resolve => child.once('close', (code, signal) => { exited = true; report.exitCode = code; report.signal = signal || null; resolve(); }));
        diagnostics = createSystemDiagnostics([sandbox, root, layout.binary, layout.resources, os.homedir(), os.tmpdir()]);
        // 原始输出不落盘、不进产物；失败时仅向CI控制台输出脱敏且限长的系统诊断。
        child.stdout.on('data', () => {});
        child.stderr.on('data', chunk => diagnostics.write(chunk));
        child.stderr.once('end', () => diagnostics.end());
        const validation = async () => {
            stage = 'startup';
            let page;
            await waitFor(async () => {
                if (spawnFailed || exited) throw failure('PACKAGED_START_FAILED');
                const active = path.join(profile, 'DevToolsActivePort');
                if (!fs.existsSync(active)) return false;
                const port = Number(fs.readFileSync(active, 'utf8').split(/\r?\n/)[0]);
                if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
                try {
                    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
                    page = (await response.json()).find(item => item.type === 'page' && /index\.html(?:[?#]|$)/.test(item.url));
                    return Boolean(page);
                } catch { return false; }
            });
            cdp = connectCdp(page.webSocketDebuggerUrl); await cdp.opened;
            const evaluate = cdp.evaluate;
            await waitFor(() => evaluate("Boolean(document.getElementById('python-quick-logs') && typeof window.showRuntimeLogs === 'function')"));
            await evaluate("document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());document.getElementById('settings-modal').classList.remove('show');true");
            stage = 'native-runtime';
            const runtime = await evaluate("(()=>{const remote=require('@electron/remote');return {version:remote.app.getVersion(),platform:process.platform,arch:process.arch,packaged:remote.app.isPackaged,profile:remote.app.getPath('userData')};})()");
            record(runtime.packaged && runtime.version === pkg.version, 'packaged-version');
            record(runtime.platform === TARGETS[platform] && runtime.arch === arch, 'native-platform-and-architecture');
            const actualProfile = fs.statSync(runtime.profile, { bigint: true });
            const expectedProfile = fs.statSync(profile, { bigint: true });
            record(actualProfile.dev === expectedProfile.dev && actualProfile.ino === expectedProfile.ino, 'temporary-profile-isolation');
            const sqlite = await evaluate("(()=>{const Database=require('better-sqlite3');const db=new Database(':memory:');try{return db.prepare('select 1 as ok').get().ok;}finally{db.close();}})()");
            record(sqlite === 1, 'sqlite-native-module');
            stage = 'default-avatar';
            await waitFor(() => evaluate("(()=>{const image=document.getElementById('account-avatar');return Boolean(image && image.complete && image.naturalWidth>0 && !image.hidden);})()"));
            const logo = `data:image/png;base64,${fs.readFileSync(path.join(layout.resources, 'build', 'icon.png')).toString('base64')}`;
            record(await evaluate("document.getElementById('account-avatar').src") === logo, 'packaged-default-avatar-logo');
            const avatar = await evaluate("require('electron').ipcRenderer.invoke('account-avatar:get')");
            record(avatar.custom === false && avatar.dataUrl === null && !fs.existsSync(path.join(profile, 'account-avatar')), 'avatar-default-no-data-write');
            stage = 'public-catalog';
            const initial = await evaluate("(async()=>{const ipc=require('electron').ipcRenderer;return {list:await ipc.invoke('unified:list',{includeHidden:true}),python:await ipc.invoke('python:status')};})()");
            const expected = new Set([...catalog.tools.map(id => `tools:${id}`), ...catalog.python.map(id => `python:${id}`)]);
            const actual = initial.list.map(item => item.engine === 'python' ? `python:${item.id.slice(7).split('/')[0]}` : item.id);
            record(initial.list.length === expected.size && new Set(actual).size === expected.size && actual.every(id => expected.has(id)), 'public-plugin-catalog');
            record(catalog.tools.length === 40 && catalog.python.length === 4, 'forty-tools-and-four-python-plugins');
            record(initial.list.every(item => typeof item.path === 'string' && inside(pluginRoot, item.path)), 'writable-plugin-root-isolation');
            record(initial.python.mode === 'none' && !initial.python.configured, 'python-default-unconfigured');
            record(initial.list.every(item => !item.isRunning && !item.autoStart), 'no-business-autostart');
            stage = 'engine-navigation';
            record(await evaluate("Boolean(document.querySelector('[data-engine=tools]') && document.querySelector('[data-engine=python]'))"), 'both-engine-menus');
            await evaluate("document.querySelector('[data-engine=python]').click();true");
            await waitFor(() => evaluate("[...document.querySelectorAll('.plugin-card')].filter(card=>card.style.display!=='none').length===4"));
            record(await evaluate("!document.getElementById('python-quick-logs').hidden"), 'python-log-entry');
            await evaluate("document.querySelector('[data-engine=tools]').click();true");
            record(await evaluate("!document.getElementById('python-quick-logs').hidden"), 'tools-log-entry');
            stage = 'log-dialog';
            await evaluate("document.getElementById('python-quick-logs').click();true");
            await waitFor(() => evaluate("document.getElementById('python-logs-dialog').open && document.getElementById('runtime-log-plugin').options.length>=45"));
            record(await evaluate("['all','tools','python'].every(value=>[...document.getElementById('runtime-log-engine').options].some(option=>option.value===value))"), 'unified-log-type-filters');
            await evaluate("document.getElementById('python-logs-dialog').close();true");
            record(!(await evaluate("document.getElementById('python-logs-dialog').open")), 'unified-log-close');
            stage = 'settings';
            record(await evaluate("Boolean(document.getElementById('migration-settings-tab') && document.getElementById('merge-migration') && document.getElementById('update-release-btn'))"), 'migration-and-stable-update-settings-entries');
            record(await evaluate("Boolean(document.getElementById('migration-settings-plugin-choose'))"), 'plugin-program-import-controls');
            const settings = await evaluate("(async()=>{const ipc=require('electron').ipcRenderer;await ipc.invoke('save-settings',{rightClickDelay:421});return ipc.invoke('get-settings');})()");
            const diskSettings = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
            record(settings.rightClickDelay === 421 && diskSettings.rightClickDelay === 421 && settings.pythonMode === 'none' && settings.autoStart === false, 'isolated-settings-save-and-readback');
            const logs = await evaluate("require('electron').ipcRenderer.invoke('runtime:logs')");
            record(logs.records.length === 0, 'no-business-runtime-logs');
            if (platform === 'mac') {
                stage = 'mac-plugin-dock';
                const fixture = path.join(pluginRoot, 'plugins', 'dock-acceptance-safe');
                fs.mkdirSync(fixture);
                fs.writeFileSync(path.join(fixture, 'plugin.json'), JSON.stringify({ pluginName: 'Dock 隔离验收', main: 'index.html' }));
                fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><body>无业务测试插件</body>');
                fs.copyFileSync(path.join(layout.resources, 'build/icon.png'), path.join(fixture, 'logo.png'));
                await evaluate("require('electron').ipcRenderer.invoke('refresh-plugins')");
                const launched = await evaluate("require('electron').ipcRenderer.invoke('unified:run','tools:dock-acceptance-safe')");
                record(launched.success === true, 'packaged-dock-plugin-launch');
                record(await evaluate("require('electron').ipcRenderer.invoke('toggle-plugin-pin-window','Dock 隔离验收')") === true, 'packaged-dock-pin');
                let dockPid;
                await waitFor(() => {
                    const processes = spawnSync('/bin/ps', ['-axo', 'pid,ppid,comm'], { encoding: 'utf8' });
                    if (processes.status !== 0) return false;
                    const owned = processes.stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).find(row => row && Number(row[2]) === child.pid && row[3].endsWith('/mac-dock-helper'));
                    if (owned) dockPid = Number(owned[1]);
                    return Boolean(owned);
                });
                record(Number.isInteger(dockPid), 'packaged-dock-native-child');
                record(await evaluate("require('electron').ipcRenderer.invoke('toggle-plugin-pin-window','Dock 隔离验收')") === false, 'packaged-dock-unpin');
                await waitFor(() => { try { process.kill(dockPid, 0); return false; } catch { return true; } });
                record(true, 'packaged-dock-native-cleanup');
                await evaluate("require('electron').ipcRenderer.invoke('unified:stop','tools:dock-acceptance-safe')");
            }
            stage = 'shutdown';
            await evaluate("setTimeout(()=>require('@electron/remote').app.quit(),20);true").catch(() => {});
            await settleWithin(closed, 12000);
            record(exited && report.exitCode === 0, 'clean-application-exit');
            report.success = true;
        };
        await Promise.race([validation(), new Promise((_, reject) => { deadline = setTimeout(() => reject(failure('SMOKE_TIMEOUT')), timeout); })]);
    } catch (error) {
        report.errors.push({ stage, code: typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'SMOKE_FAILED' });
    } finally {
        cancelled = true;
        clearTimeout(deadline);
        cdp?.close();
        await stopOwnedProcess(child, closed);
        if (!report.success && diagnostics) {
            const lines = diagnostics.lines();
            if (lines.length) console.error(`PACKAGED_RUNTIME_SYSTEM_DIAGNOSTICS ${JSON.stringify(lines)}`);
            if (platform === 'linux') console.error(`PACKAGED_RUNTIME_SYSTEM_CAPACITY ${JSON.stringify(linuxCapacity())}`);
        }
        if (sandbox) try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { report.cleanupPending = true; }
        const output = path.join(root, 'dist', `packaged-runtime-${platform}-${arch}.json`);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    return report;
}

if (require.main === module) {
    let options;
    try { options = parseOptions(); } catch (error) { console.error(error.code || 'INVALID_ARGUMENTS'); process.exitCode = 1; }
    if (options) runSmoke(options).then(report => { console.log(JSON.stringify(report)); process.exitCode = report.success ? 0 : 1; }).catch(() => { console.error('SMOKE_REPORT_FAILED'); process.exitCode = 1; });
}
module.exports = { parseOptions, locatePackage, validateMacDockResources, isolatedEnvironment, inside, stopOwnedProcess, runSmoke, runtimeArguments, sanitizeSystemLine, createSystemDiagnostics, connectCdp };
