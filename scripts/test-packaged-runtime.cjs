'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');
const { resolvePackageLayout } = require('./package-local');

const TARGETS = { win: 'win32', mac: 'darwin', linux: 'linux' };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function failure(code) { return Object.assign(new Error(code), { code }); }

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
    socket.on('error', () => {});
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
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure('CDP_CLOSED')); }
        pending.clear();
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
    let stage = 'preflight', child, closed = Promise.resolve(), cdp, sandbox, deadline, cancelled = false;
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
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-native-smoke-'));
        const profile = path.join(sandbox, 'profile');
        const pluginRoot = platform === 'win' ? path.join(sandbox, 'portable') : profile;
        fs.mkdirSync(profile); fs.mkdirSync(pluginRoot, { recursive: true });
        const env = isolatedEnvironment(process.env, { platform, profile, pluginRoot });
        const args = ['--remote-debugging-port=0', '--disable-gpu'];
        // 仅隔离验收进程使用此参数；产品启动选项不改变。
        if (platform === 'linux') args.push('--no-sandbox');
        child = spawn(layout.binary, args, { env, cwd: sandbox, windowsHide: true, detached: platform !== 'win', stdio: ['ignore', 'pipe', 'pipe'] });
        let spawnFailed = false, exited = false;
        child.once('error', () => { spawnFailed = true; });
        closed = new Promise(resolve => child.once('close', (code, signal) => { exited = true; report.exitCode = code; report.signal = signal || null; resolve(); }));
        // 不把宿主或插件原始输出写入产物，报告只保存受控断言和错误代码。
        child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
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
            const settings = await evaluate("(async()=>{const ipc=require('electron').ipcRenderer;await ipc.invoke('save-settings',{rightClickDelay:421});return ipc.invoke('get-settings');})()");
            const diskSettings = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
            record(settings.rightClickDelay === 421 && diskSettings.rightClickDelay === 421 && settings.pythonMode === 'none' && settings.autoStart === false, 'isolated-settings-save-and-readback');
            const logs = await evaluate("require('electron').ipcRenderer.invoke('runtime:logs')");
            record(logs.records.length === 0, 'no-business-runtime-logs');
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
module.exports = { parseOptions, locatePackage, isolatedEnvironment, inside, stopOwnedProcess, runSmoke };
