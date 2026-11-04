const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test } = require('node:test');
const { zipSync, strToU8 } = require('fflate');
const { PythonEnvironment, createPythonEnv, inspectArchive } = require('../app/python-environment');

const VERSION = '3.14.10';

function archive(files = { 'python.exe': strToU8('test interpreter'), 'Lib/test.txt': strToU8('runtime') }) {
    return Buffer.from(zipSync(files));
}

function manifest(bytes, overrides = {}) {
    return { platforms: { 'win32-x64': {
        version: VERSION, architecture: 'x64', url: 'https://www.python.org/test-runtime.zip',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        maxDownloadBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxEntryBytes: 512 * 1024, maxEntries: 100,
        ...overrides
    } } };
}

function runtimeInfo(executable, extra = {}) {
    return { executable, version: VERSION, major: 3, prefix: path.dirname(executable), architecture: 'AMD64', bitness: 64, pip: true, tk: true, tkWindow: true, ssl: true, venv: true, ...extra };
}

function fixture(t, options = {}) {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-python-env-'));
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    let settings = { unrelated: 'preserved', ...options.settings };
    let saves = 0;
    const progress = [];
    const bytes = options.bytes || archive();
    const environment = new PythonEnvironment({
        appRoot, userData: path.join(appRoot, 'user-data'), platform: 'win32', arch: 'x64',
        loadSettings: () => ({ ...settings }),
        saveSettings: value => { saves++; settings = value; },
        onProgress: event => progress.push(event),
        inspectRuntime: async executable => runtimeInfo(executable),
        manifest: manifest(bytes),
        download: async (_url, destination, { signal, onProgress }) => {
            assert.equal(signal.aborted, false);
            await fs.promises.writeFile(destination, bytes);
            onProgress({ bytes: bytes.length, total: bytes.length });
        },
        ...options.options
    });
    return { environment, appRoot, progress, bytes, settings: () => settings, change: patch => { settings = { ...settings, ...patch }; }, saves: () => saves };
}

function fakePython(root, name = 'custom') {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, 'python.exe');
    fs.writeFileSync(executable, 'test');
    return executable;
}

test('default state does not inspect Python and unconfigured run is actionable', async t => {
    let checks = 0;
    const f = fixture(t, { options: { inspectRuntime: async () => { checks++; throw new Error('should not run'); } } });
    assert.equal(f.environment.status().mode, 'none');
    assert.equal(f.environment.status().configured, false);
    await assert.rejects(f.environment.resolve(), { code: 'PYTHON_UNCONFIGURED' });
    assert.equal(checks, 0);
    assert.equal(f.saves(), 0);
});

test('custom selection merges latest host settings and resolves selected environment', async t => {
    const f = fixture(t);
    const executable = fakePython(f.appRoot, '中文 空格');
    f.environment._inspectRuntime = async file => {
        f.change({ pluginPreferences: { 'python:test': { hidden: true } } });
        return runtimeInfo(file, { pip: false, tk: false });
    };
    const selected = await f.environment.select(executable);
    assert.equal(selected.mode, 'custom');
    assert.equal(selected.pip, false);
    assert.equal(f.settings().customPythonPath, executable);
    assert.equal(f.settings().unrelated, 'preserved');
    assert.deepEqual(f.settings().pluginPreferences, { 'python:test': { hidden: true } });
    const resolved = await f.environment.resolve();
    assert.equal(resolved.executable, executable);
    assert.equal(resolved.env.PYTHONIOENCODING, 'utf-8');
});

test('invalid explicit Python never falls back or changes settings', async t => {
    const f = fixture(t, { settings: { pythonMode: 'custom', customPythonPath: path.join(os.tmpdir(), 'missing-python.exe') } });
    await assert.rejects(f.environment.resolve(), { code: 'PYTHON_INVALID' });
    await assert.rejects(f.environment.select('python.exe'), { code: 'PYTHON_INVALID' });
    assert.equal(f.saves(), 0);
    assert.equal(f.settings().pythonMode, 'custom');
});

test('selected interpreter rejects Python 2 and malformed runtime metadata', async t => {
    const f = fixture(t, { options: { inspectRuntime: async executable => runtimeInfo(executable, { version: '2.7.18', major: 2 }) } });
    await assert.rejects(f.environment.select(fakePython(f.appRoot)), { code: 'PYTHON_INVALID' });
    assert.equal(f.saves(), 0);
    f.environment._inspectRuntime = async executable => runtimeInfo(executable, { version: '3.8.20', major: 3 });
    await assert.rejects(f.environment.select(fakePython(f.appRoot)), { code: 'PYTHON_INVALID' });
});

test('process environment removes inherited Python and Conda pollution case insensitively', () => {
    const executable = path.join(os.tmpdir(), 'selected', 'python.exe');
    const prefix = path.dirname(executable);
    const env = createPythonEnv({ executable, prefix }, {
        Path: 'C:\\system-bin', pythonhome: 'old-home', PYTHONPATH: 'old-packages', TCL_LIBRARY: 'old-tcl',
        TK_LIBRARY: 'old-tk', VIRTUAL_ENV: 'old-venv', CONDA_PREFIX: 'old-conda', KEEP: 'yes'
    }, 'win32');
    assert.equal(env.KEEP, 'yes');
    for (const key of ['Path', 'pythonhome', 'PYTHONPATH', 'TCL_LIBRARY', 'TK_LIBRARY', 'VIRTUAL_ENV', 'CONDA_PREFIX']) assert.equal(Object.hasOwn(env, key), false);
    assert.ok(env.PATH.startsWith(prefix));
    assert.ok(env.PATH.endsWith('C:\\system-bin'));
});

test('discovery skips aliases, duplicates, missing paths and failing probes with bounded concurrency', async t => {
    const f = fixture(t);
    const paths = Array.from({ length: 7 }, (_, i) => fakePython(f.appRoot, `candidate-${i}`));
    const alias = fakePython(f.appRoot, path.join('Microsoft', 'WindowsApps'));
    let running = 0;
    let peak = 0;
    f.environment._discoverCandidates = async () => [paths[0], ...paths, alias, path.join(f.appRoot, 'missing.exe')];
    f.environment._inspectRuntime = async executable => {
        running++; peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 5));
        running--;
        if (executable === paths[2]) throw new Error('broken install');
        return runtimeInfo(executable);
    };
    const found = await f.environment.discover();
    assert.equal(found.length, 6);
    assert.ok(peak <= 3 && peak >= 2);
    assert.ok(found.every(item => item.executable !== alias));
    assert.equal(f.saves(), 0);
});

test('Windows pythonw selection probes its matching console interpreter', async t => {
    const f = fixture(t);
    const executable = fakePython(f.appRoot);
    const windowed = path.join(path.dirname(executable), 'pythonw.exe');
    fs.writeFileSync(windowed, 'test');
    assert.equal((await f.environment.select(windowed)).executable, executable);
});

test('one-click installation validates staging, publishes atomically and preserves host settings', async t => {
    const f = fixture(t);
    const probes = [];
    f.environment._inspectRuntime = async (executable, options) => {
        probes.push(executable);
        assert.equal(options.hiddenTk, true);
        assert.equal(f.settings().pythonMode, undefined);
        return runtimeInfo(executable);
    };
    const result = await f.environment.install();
    const destination = path.join(f.appRoot, 'runtime', 'python', `cpython-${VERSION}-x64`, 'python.exe');
    assert.equal(result.executable, destination);
    assert.equal(result.mode, 'managed');
    assert.equal(f.settings().managedPythonPath, destination);
    assert.equal(f.settings().unrelated, 'preserved');
    assert.equal(probes.length, 2);
    assert.ok(probes[0].includes('.staging-'));
    assert.equal(fs.readFileSync(destination, 'utf8'), 'test interpreter');
    assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(destination))), [`cpython-${VERSION}-x64`]);
    assert.equal(f.environment.status().installing, false);
    assert.equal(f.progress.at(-1).phase, 'complete');
});

test('verified existing managed environment is reused without downloading or overwriting', async t => {
    const f = fixture(t);
    const destination = path.join(f.appRoot, 'runtime', 'python', `cpython-${VERSION}-x64`);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'python.exe'), 'existing');
    f.environment._download = () => { throw new Error('must not download'); };
    const result = await f.environment.install();
    assert.equal(result.mode, 'managed');
    assert.equal(fs.readFileSync(path.join(destination, 'python.exe'), 'utf8'), 'existing');
});

test('corrupt existing managed environment is retained and not selected', async t => {
    const f = fixture(t, { settings: { pythonMode: 'custom', customPythonPath: 'old-python' } });
    const destination = path.join(f.appRoot, 'runtime', 'python', `cpython-${VERSION}-x64`);
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'python.exe'), 'existing');
    f.environment._inspectRuntime = async executable => runtimeInfo(executable, { tkWindow: false });
    await assert.rejects(f.environment.install(), { code: 'PYTHON_MANAGED_INVALID' });
    assert.equal(fs.readFileSync(path.join(destination, 'python.exe'), 'utf8'), 'existing');
    assert.equal(f.saves(), 0);
    assert.equal(f.settings().pythonMode, 'custom');
});

test('checksum mismatch never extracts or alters selected interpreter', async t => {
    const f = fixture(t, { options: { manifest: manifest(archive(), { sha256: '0'.repeat(64) }) } });
    await assert.rejects(f.environment.install(), { code: 'PYTHON_HASH_MISMATCH' });
    assert.equal(f.saves(), 0);
    assert.deepEqual(fs.readdirSync(path.join(f.appRoot, 'runtime', 'python')), []);
});

test('cancelled download clears staging and leaves existing settings intact; parallel install is rejected', async t => {
    const f = fixture(t, { settings: { pythonMode: 'custom', customPythonPath: 'kept' } });
    let began;
    const started = new Promise(resolve => { began = resolve; });
    f.environment._download = (_url, _destination, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('network aborted')), { once: true });
        began();
    });
    const installing = f.environment.install();
    await started;
    assert.equal(f.environment.status().installing, true);
    await assert.rejects(f.environment.install(), { code: 'PYTHON_INSTALL_BUSY' });
    assert.deepEqual(f.environment.cancel(), { cancelled: true });
    await assert.rejects(installing, { code: 'PYTHON_INSTALL_CANCELLED' });
    assert.equal(f.settings().customPythonPath, 'kept');
    assert.equal(f.saves(), 0);
    assert.deepEqual(fs.readdirSync(path.join(f.appRoot, 'runtime', 'python')), []);
});

test('interpreter selection cannot overwrite an in-flight installation', async t => {
    const f = fixture(t);
    const executable = fakePython(f.appRoot);
    let began;
    const started = new Promise(resolve => { began = resolve; });
    f.environment._download = (_url, _destination, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        began();
    });
    const installing = f.environment.install();
    await started;
    await assert.rejects(f.environment.select(executable), { code: 'PYTHON_INSTALL_BUSY' });
    assert.equal(f.saves(), 0);
    f.environment.cancel();
    await assert.rejects(installing, { code: 'PYTHON_INSTALL_CANCELLED' });
});

test('selection started before installation rechecks busy state after its probe', async t => {
    const f = fixture(t);
    const executable = fakePython(f.appRoot);
    let probed, releaseProbe, downloading;
    const probeStarted = new Promise(resolve => { probed = resolve; });
    const downloadStarted = new Promise(resolve => { downloading = resolve; });
    f.environment._inspectRuntime = file => new Promise(resolve => { releaseProbe = () => resolve(runtimeInfo(file)); probed(); });
    f.environment._download = (_url, _destination, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        downloading();
    });
    const selecting = f.environment.select(executable);
    await probeStarted;
    const installing = f.environment.install();
    await downloadStarted;
    releaseProbe();
    await assert.rejects(selecting, { code: 'PYTHON_INSTALL_BUSY' });
    assert.equal(f.saves(), 0);
    f.environment.cancel();
    await assert.rejects(installing, { code: 'PYTHON_INSTALL_CANCELLED' });
});

test('shutdown waits for cancellation and staging cleanup, then rejects new installs and selections', async t => {
    const f = fixture(t);
    const executable = fakePython(f.appRoot);
    let began;
    let abortDelivered = false;
    const started = new Promise(resolve => { began = resolve; });
    f.environment._download = (_url, destination, { signal }) => new Promise((_resolve, reject) => {
        fs.writeFileSync(destination, 'incomplete');
        signal.addEventListener('abort', () => setTimeout(() => { abortDelivered = true; reject(new Error('download stopped')); }, 15), { once: true });
        began();
    });
    const installing = f.environment.install();
    await started;
    const stopped = await f.environment.shutdown();
    assert.equal(abortDelivered, true);
    assert.deepEqual(stopped, { success: true, cancelled: true });
    await assert.rejects(installing, { code: 'PYTHON_INSTALL_CANCELLED' });
    assert.equal(f.environment.status().installing, false);
    assert.equal(f.saves(), 0);
    assert.deepEqual(fs.readdirSync(path.join(f.appRoot, 'runtime', 'python')), []);
    await assert.rejects(f.environment.install(), { code: 'APP_CLOSING' });
    await assert.rejects(f.environment.select(executable), { code: 'APP_CLOSING' });
});

test('post-move runtime failure rolls back only this installation', async t => {
    const f = fixture(t);
    const unrelated = path.join(f.appRoot, 'runtime', 'python', 'my-existing-runtime');
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
    f.environment._inspectRuntime = async executable => runtimeInfo(executable, { pip: executable.includes('.staging-') });
    await assert.rejects(f.environment.install(), { code: 'PYTHON_MANAGED_INVALID' });
    assert.equal(f.saves(), 0);
    assert.deepEqual(fs.readdirSync(path.dirname(unrelated)), ['my-existing-runtime']);
    assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});

test('unwritable installation directory reports permission error without changing settings', async t => {
    const f = fixture(t, { options: { ensureWritable: () => { const error = new Error('permission denied'); error.code = 'EACCES'; throw error; } } });
    await assert.rejects(f.environment.install(), { code: 'PYTHON_INSTALL_PERMISSION' });
    assert.equal(f.saves(), 0);
});

test('linked runtime directory cannot redirect install outside application', async t => {
    const f = fixture(t);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-external-'));
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    fs.symlinkSync(external, path.join(f.appRoot, 'runtime'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.environment.install(), { code: 'PYTHON_INSTALL_PATH' });
    assert.deepEqual(fs.readdirSync(external), []);
});

test('unsupported platforms allow external Python but never perform managed installation', async t => {
    const f = fixture(t, { options: { platform: 'darwin', arch: 'arm64' } });
    assert.equal(f.environment.status().supportedInstall, false);
    await assert.rejects(f.environment.install(), { code: 'PYTHON_INSTALL_UNSUPPORTED' });
    assert.equal((await f.environment.select(fakePython(f.appRoot))).mode, 'custom');
});

test('ZIP path traversal, case collisions, symlinks and size overflow are rejected before extraction', () => {
    const normal = archive();
    const limits = manifest(normal).platforms['win32-x64'];
    for (const name of ['../escape', 'C:/escape', '/absolute', 'safe/../../escape', 'safe/CON.txt', 'safe/a:stream', 'safe./a']) {
        const bytes = archive({ 'python.exe': strToU8('x'), [name]: strToU8('bad') });
        assert.throws(() => inspectArchive(bytes, limits), { code: 'PYTHON_ARCHIVE_PATH' });
    }
    assert.throws(() => inspectArchive(archive({ 'python.exe': strToU8('x'), 'A.txt': strToU8('x'), 'a.txt': strToU8('x') }), limits), { code: 'PYTHON_ARCHIVE_PATH' });
    const linked = Buffer.from(normal);
    const central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    linked.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    assert.throws(() => inspectArchive(linked, limits), { code: 'PYTHON_ARCHIVE_PATH' });
    assert.throws(() => inspectArchive(normal, { ...limits, maxExtractedBytes: 1 }), { code: 'PYTHON_ARCHIVE_LIMIT' });
    assert.throws(() => inspectArchive(normal, { ...limits, maxEntries: 1 }), { code: 'PYTHON_ARCHIVE_LIMIT' });
});

test('managed verification requires GUI initialization, SSL, pip and matching version/architecture', async t => {
    for (const extra of [{ tkWindow: false }, { ssl: false }, { pip: false }, { version: '3.12.8' }, { bitness: 32 }, { architecture: 'ARM64' }]) {
        const f = fixture(t, { options: { inspectRuntime: async executable => runtimeInfo(executable, extra) } });
        await assert.rejects(f.environment.install(), { code: 'PYTHON_MANAGED_INVALID' });
        assert.equal(f.saves(), 0);
        assert.deepEqual(fs.readdirSync(path.join(f.appRoot, 'runtime', 'python')), []);
    }
});
