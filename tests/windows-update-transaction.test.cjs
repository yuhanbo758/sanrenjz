'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const helper = path.join(repository, 'build/windows-update-transaction.ps1');
const powershell = path.join(process.env.WINDIR || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const backupSuffix = '.sanrenjz-update-backup';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'";
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function fixture(t, { registered = true, validApplication = true } = {}) {
    // 与 .NET GetFullPath 使用同一目录身份，展开 CI TEMP 的 RUNNER~1 等 8.3 别名。
    const temporaryParent = fs.realpathSync.native(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporaryParent, 'sanrenjz-transaction-test-'));
    const install = path.join(root, '应用 程序');
    const backup = install + backupSuffix;
    const active = path.join(backup, 'active');
    const old = path.join(active, 'app');
    const stateFile = path.join(active, 'state.json');
    const guid = crypto.randomUUID();
    const appId = 'test.sanrenjz.transaction.' + guid;
    const registryKey = 'Software\\' + guid;
    const uninstallKey = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + guid;
    const uninstaller = 'Uninstall Fixture.exe';
    const locks = new Set();
    const data = Buffer.from([0, 3, 255, 128, 10, 13, 17]);
    write(path.join(install, 'personal.txt'), 'original personal');
    if (validApplication) {
        write(path.join(install, 'Fixture.exe'), 'old executable marker, never executed');
        write(path.join(install, uninstaller), 'old uninstaller marker, never executed');
        write(path.join(install, 'resources/old.bin'), 'old resource');
        write(path.join(install, 'plugins/fixture/.runtime/keep.bin'), data);
        write(path.join(install, 'python-plugins/fixture/main.py'), data);
    }

    function ps(code) {
        code = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ProgressPreference='SilentlyContinue';" + code;
        const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
            windowsHide: true, encoding: 'utf8', timeout: 30000, cwd: root
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        return result.stdout.replace(/^\uFEFF/, '').trim();
    }
    const registryBase = "$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);";
    function register(version = '0.1.9', rich = true) {
        ps(`$ErrorActionPreference='Stop';${registryBase}
foreach($name in @(${psQuote(registryKey)},${psQuote(uninstallKey)})){$base.DeleteSubKeyTree($name,$false)}
$key=$base.CreateSubKey(${psQuote(registryKey)});$key.SetValue('InstallLocation',${psQuote(install)});
${rich ? "$key.SetValue('FixtureDword',[int]42,[Microsoft.Win32.RegistryValueKind]::DWord);$key.SetValue('FixtureMulti',[string[]]@('first','second'),[Microsoft.Win32.RegistryValueKind]::MultiString);$key.SetValue('FixtureBinary',[byte[]]@(0,1,254,255),[Microsoft.Win32.RegistryValueKind]::Binary);" : "$key.SetValue('NewOnly','new value');"}
$key.Dispose();$key=$base.CreateSubKey(${psQuote(uninstallKey)});$key.SetValue('DisplayVersion',${psQuote(version)});$key.SetValue('UninstallString',${psQuote('"' + path.join(install, uninstaller) + '"')});$key.Dispose();$base.Dispose();`);
    }
    function registry() {
        const raw = ps(`$ErrorActionPreference='Stop';${registryBase}
$result=@()
foreach($name in @(${psQuote(registryKey)},${psQuote(uninstallKey)})) {
  $key=$base.OpenSubKey($name,$false);$values=@()
  if($null -ne $key) {
    foreach($value in ($key.GetValueNames()|Sort-Object)) {
      $values += [pscustomobject]@{Name=$value;Kind=$key.GetValueKind($value).ToString();Value=$key.GetValue($value)}
    }
  }
  $result += [pscustomobject]@{Key=$name;Exists=($null -ne $key);Values=$values}
  if($null -ne $key){$key.Dispose()}
}
$base.Dispose();ConvertTo-Json -InputObject @($result) -Depth 8 -Compress`);
        return JSON.parse(raw);
    }
    function run(phase, expected = 0, version = '0.2.2') {
        const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
            '-Phase', phase, '-InstallDir', install, '-UninstallerName', uninstaller, '-Version', version, '-AppId', appId,
            '-RegistryKey', registryKey, '-UninstallRegistryKey', uninstallKey, '-RegistryHive', 'CurrentUser', '-RegistryView', 'Registry64'];
        if (registered) args.push('-RegisteredInstallDir', install);
        const result = spawnSync(powershell, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000 });
        assert.ifError(result.error);
        const details = fs.existsSync(path.join(backup, 'transaction.log')) ? fs.readFileSync(path.join(backup, 'transaction.log'), 'utf8') : '';
        assert.equal(result.status, expected, `${phase}: ${result.stdout}\n${result.stderr}\n${details}`);
        return result;
    }
    function payload(label = 'new') {
        write(path.join(install, 'Fixture.exe'), label + ' executable marker, never executed');
        write(path.join(install, uninstaller), label + ' uninstaller marker, never executed');
        write(path.join(install, 'resources/new.bin'), label + ' resource');
    }
    function saveState(state) { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
    function assertData(base = install) {
        assert.deepEqual(fs.readFileSync(path.join(base, 'plugins/fixture/.runtime/keep.bin')), data);
        assert.deepEqual(fs.readFileSync(path.join(base, 'python-plugins/fixture/main.py')), data);
        assert.equal(fs.readFileSync(path.join(base, 'personal.txt'), 'utf8'), 'original personal');
    }
    function noScatteredBackup() {
        assert(!fs.readdirSync(root).some(name => name.startsWith(path.basename(backup) + '.previous-')));
        assert(fs.readdirSync(root).filter(name => name.endsWith(backupSuffix)).length <= 1);
    }
    async function lock(file) {
        const ready = path.join(root, 'lock-ready-' + crypto.randomUUID());
        const release = ready + '.release';
        const script = `$ErrorActionPreference='Stop';$stream=[IO.File]::Open(${psQuote(file)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{[IO.File]::WriteAllText(${psQuote(ready)},'ready');while(![IO.File]::Exists(${psQuote(release)})){Start-Sleep -Milliseconds 30}}finally{$stream.Dispose()}`;
        const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', cwd: root });
        const close = new Promise(resolve => child.once('close', resolve));
        const item = { child, release, close };
        locks.add(item);
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(ready) && child.exitCode === null && Date.now() < deadline) await delay(20);
        assert(fs.existsSync(ready), '独占文件锁已建立');
        return async () => { write(release, 'release'); await close; locks.delete(item); };
    }
    t.after(async () => {
        for (const item of locks) { write(item.release, 'release'); await item.close; }
        assert(/^[a-f0-9-]{36}$/.test(guid) && appId.startsWith('test.sanrenjz.transaction.'));
        for (const key of [registryKey, uninstallKey]) spawnSync('reg.exe', ['delete', 'HKCU\\' + key, '/f', '/reg:64'], { windowsHide: true, stdio: 'ignore' });
        assert.equal(path.dirname(root), temporaryParent);
        assert(path.basename(root).startsWith('sanrenjz-transaction-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    if (registered) register();
    return { root, install, backup, active, old, stateFile, appId, uninstaller, data, run, payload, register, registry, saveState, assertData, noScatteredBackup, lock };
}

const options = { skip: process.platform !== 'win32', timeout: 90000 };

test('Windows helper：prepare → rollback 恢复文件与原注册表类型', options, t => {
    const f = fixture(t); const original = f.registry();
    f.run('prepare');
    f.assertData(f.old);
    f.payload(); f.register('0.2.2', false);
    f.run('rollback');
    f.assertData();
    assert.equal(fs.readFileSync(path.join(f.install, 'Fixture.exe'), 'utf8'), 'old executable marker, never executed');
    assert.deepEqual(f.registry(), original, '回滚必须恢复 DWORD、MultiString、Binary 和原有键值集合');
    f.noScatteredBackup();
});

test('Windows helper：部分恢复移动后崩溃，按同一日志继续恢复', options, t => {
    const f = fixture(t); f.run('prepare'); f.payload();
    const state = readJSON(f.stateFile);
    state.Stage = 'restoring'; state.Moves = ['plugins', 'python-plugins', 'personal.txt'];
    fs.renameSync(path.join(f.old, 'plugins'), path.join(f.install, 'plugins'));
    f.saveState(state);
    f.run('restore'); f.assertData();
    assert.equal(fs.readFileSync(path.join(f.install, 'Fixture.exe'), 'utf8'), 'new executable marker, never executed');
    assert(!fs.existsSync(f.active));
    f.noScatteredBackup();
});

test('Windows helper：原目录已恢复但标记未更新，可继续回滚并恢复注册表', options, t => {
    const f = fixture(t); const original = f.registry(); f.run('prepare'); f.payload(); f.register('0.2.2', false);
    const recovery = path.join(f.backup, 'recovery/interrupted-manual');
    fs.mkdirSync(path.dirname(recovery), { recursive: true }); fs.renameSync(f.install, recovery); fs.renameSync(f.old, f.install);
    const state = readJSON(f.stateFile); state.Stage = 'originalRestoring'; state.RecoveryTarget = ''; f.saveState(state);
    f.run('rollback'); f.assertData();
    assert.equal(readJSON(f.stateFile).Stage, 'rolledBack');
    assert.deepEqual(f.registry(), original);
    assert.equal(fs.readFileSync(path.join(recovery, 'Fixture.exe'), 'utf8'), 'new executable marker, never executed');
    f.noScatteredBackup();
});

test('Windows helper：committed 清理中断保留标记，下次 prepare 真正暂存当前版本', options, async t => {
    const f = fixture(t); f.run('prepare'); f.payload(); f.register('0.2.2', false);
    const unlock = await f.lock(path.join(f.old, 'resources/old.bin'));
    try {
        f.run('restore', 1);
        assert.equal(readJSON(f.stateFile).Stage, 'committed', '失败清理不能先删除提交标记');
        f.assertData();
    } finally { await unlock(); }
    f.run('prepare');
    assert.equal(readJSON(f.stateFile).Stage, 'staged');
    assert.equal(fs.readFileSync(path.join(f.old, 'Fixture.exe'), 'utf8'), 'new executable marker, never executed');
    assert(!fs.existsSync(path.join(f.install, 'Fixture.exe')));
    f.assertData(f.old); f.noScatteredBackup(); f.run('rollback');
});

test('Windows helper：两次失败的 partial 分别收纳，不覆盖或删除旧恢复材料', options, t => {
    const f = fixture(t);
    for (const label of ['first-failed', 'second-failed']) {
        f.run('prepare'); f.payload(label); write(path.join(f.install, 'unique.txt'), label); f.run('rollback'); f.assertData();
    }
    const recovery = path.join(f.backup, 'recovery');
    const labels = fs.readdirSync(recovery).map(name => fs.readFileSync(path.join(recovery, name, 'unique.txt'), 'utf8')).sort();
    assert.deepEqual(labels, ['first-failed', 'second-failed']);
    f.noScatteredBackup();
});

test('Windows helper：旧 legacy 仅本次补缺，后续不会复活已删除插件', options, t => {
    const f = fixture(t);
    write(path.join(f.backup, 'plugins/recovered/keep.txt'), 'legacy data');
    f.run('prepare');
    assert.equal(fs.readFileSync(path.join(f.old, 'plugins/recovered/keep.txt'), 'utf8'), 'legacy data');
    f.payload(); f.register('0.2.2', false); f.run('restore');
    fs.rmSync(path.join(f.install, 'plugins/recovered'), { recursive: true });
    f.run('prepare');
    assert(!fs.existsSync(path.join(f.old, 'plugins/recovered')), '历史备份不能在后续普通升级时补回用户删除的插件');
    f.payload('next'); f.run('restore');
    assert(!fs.existsSync(path.join(f.install, 'plugins/recovered')));
    assert.equal(fs.readFileSync(path.join(f.backup, 'legacy/from-fixed-backup/plugins/recovered/keep.txt'), 'utf8'), 'legacy data');
    f.noScatteredBackup();
});

test('Windows helper：未注册的非应用非空目录必须保持原样并拒绝暂存', options, t => {
    const f = fixture(t, { registered: false, validApplication: false });
    f.run('prepare', 1);
    assert.match(fs.readFileSync(path.join(f.backup, 'transaction.log'), 'utf8'), /Non-empty installation directory does not identify this application/);
    assert.equal(fs.readFileSync(path.join(f.install, 'personal.txt'), 'utf8'), 'original personal');
    assert(!fs.existsSync(f.stateFile));
    assert(!fs.existsSync(f.old));
    assert(f.registry().every(item => item.Exists === false));
    f.noScatteredBackup();
});

test('Windows helper：跨版本恢复 created 事务和按原事务版本回滚新注册表', options, t => {
    const f = fixture(t);
    const original = f.registry();
    fs.mkdirSync(f.active, { recursive: true });
    // 模拟已落盘 created 日志、尚未移动原目录就退出的现场。
    f.saveState({ Protocol: 1, InstallDir: f.install, AppId: f.appId, Version: '0.2.2', Stage: 'created', Moves: [],
        Registry: original.map(item => ({ ...item, Hive: 'CurrentUser', View: 'Registry64' })),
        RecoveryTarget: '', RecoverySource: '', LegacyRecovered: false });
    f.run('rollback', 0, '0.2.3');
    assert.equal(readJSON(f.stateFile).Stage, 'rolledBack');
    f.assertData(); assert.deepEqual(f.registry(), original);
    f.run('prepare', 0, '0.2.3');
    assert.equal(readJSON(f.stateFile).Version, '0.2.3');
    assert.equal(readJSON(f.stateFile).Stage, 'staged');
    f.assertData(f.old); f.run('rollback', 0, '0.2.3'); f.noScatteredBackup();

    const unregistered = fixture(t, { registered: false });
    assert(unregistered.registry().every(item => item.Exists === false));
    unregistered.run('prepare', 0, '0.2.2');
    unregistered.payload('new-0.2.2'); unregistered.register('0.2.2', false);
    assert(unregistered.registry().every(item => item.Exists === true));
    // 0.2.3 的恢复器必须按 state.Version=0.2.2 识别上一事务新建的键。
    unregistered.run('rollback', 0, '0.2.3');
    assert(unregistered.registry().every(item => item.Exists === false));
    unregistered.assertData();
    assert.equal(fs.readFileSync(path.join(unregistered.install, 'Fixture.exe'), 'utf8'), 'old executable marker, never executed');
    unregistered.run('prepare', 0, '0.2.3');
    assert.equal(readJSON(unregistered.stateFile).Version, '0.2.3');
    unregistered.run('rollback', 0, '0.2.3'); unregistered.noScatteredBackup();
});

test('Windows helper：legacy 收纳中断继续同一 import 批次并恢复两类缺少项', options, t => {
    const f = fixture(t);
    write(path.join(f.backup, 'plugins/legacy-tool/keep.txt'), 'tool recovery');
    write(path.join(f.backup, 'plugins/fixture/.runtime/keep.bin'), 'stale copy must not overwrite current data');
    write(path.join(f.backup, 'python-plugins/legacy-python/keep.txt'), 'python recovery');
    const legacy = path.join(f.backup, 'legacy');
    const batch = path.join(legacy, 'from-fixed-backup');
    fs.mkdirSync(batch, { recursive: true });
    write(path.join(legacy, 'import.json'), JSON.stringify({ InstallDir: f.install, AppId: f.appId, Batch: batch,
        Names: ['plugins', 'python-plugins'], Previous: [] }));
    fs.renameSync(path.join(f.backup, 'plugins'), path.join(batch, 'plugins'));
    assert(fs.existsSync(path.join(f.backup, 'python-plugins')));
    f.run('prepare');
    const state = readJSON(f.stateFile);
    assert.equal(state.RecoverySource, batch, '第一批已移走的目录仍被事务引用');
    assert.equal(state.LegacyRecovered, true);
    assert.deepEqual(fs.readdirSync(legacy).filter(name => name.startsWith('from-fixed-backup')), ['from-fixed-backup']);
    assert(!fs.existsSync(path.join(legacy, 'import.json')));
    assert(!fs.existsSync(path.join(f.backup, 'python-plugins')));
    assert.equal(fs.readFileSync(path.join(f.old, 'plugins/legacy-tool/keep.txt'), 'utf8'), 'tool recovery');
    assert.equal(fs.readFileSync(path.join(f.old, 'python-plugins/legacy-python/keep.txt'), 'utf8'), 'python recovery');
    f.assertData(f.old);
    f.payload(); f.run('restore'); f.assertData();
    assert.equal(fs.readFileSync(path.join(f.install, 'plugins/legacy-tool/keep.txt'), 'utf8'), 'tool recovery');
    assert.equal(fs.readFileSync(path.join(f.install, 'python-plugins/legacy-python/keep.txt'), 'utf8'), 'python recovery');
    assert.equal(fs.readFileSync(path.join(batch, 'plugins/legacy-tool/keep.txt'), 'utf8'), 'tool recovery');
    assert.equal(fs.readFileSync(path.join(batch, 'python-plugins/legacy-python/keep.txt'), 'utf8'), 'python recovery');
    f.noScatteredBackup();
});
