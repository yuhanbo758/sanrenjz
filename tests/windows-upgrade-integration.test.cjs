'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const repository = path.resolve(__dirname, '..');
const builder = path.join(repository, 'node_modules/electron-builder/out/cli/cli.js');
const compiler = path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const productionInclude = path.join(repository, 'build/installer.nsh');
const backupSuffix = '.sanrenjz-update-backup';
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function legacyCopyInclude(sandbox) {
    // 冻结 0.2.1 的复制后仍调用旧卸载器的行为；不依赖浅克隆中不存在的历史提交。
    return `!ifndef BUILD_UNINSTALLER
Var preservedDataDir
Var copyResult
!endif
!macro fixtureCopy SOURCE DESTINATION NAME
  IfFileExists "\${SOURCE}\\." 0 copy_\${NAME}_done
  CreateDirectory "\${DESTINATION}"
  nsExec::ExecToStack '"$SYSDIR\\robocopy.exe" "\${SOURCE}" "\${DESTINATION}" /E /COPY:DAT /DCOPY:DAT /SL /SJ /R:1 /W:1 /NP /NFL /NDL /NJH /NJS'
  Pop $copyResult
  Pop $0
  StrCmp $copyResult "error" copy_\${NAME}_failed
  IntCmpU $copyResult 8 copy_\${NAME}_failed copy_\${NAME}_done copy_\${NAME}_failed
copy_\${NAME}_failed:
  SetErrorLevel 22
  Abort
copy_\${NAME}_done:
!macroend
!macro customHeader
!ifndef BUILD_UNINSTALLER
Section "-legacyCopy"
  !insertmacro CHECK_APP_RUNNING
  StrCpy $preservedDataDir "$INSTDIR${backupSuffix}"
  !insertmacro fixtureCopy "$INSTDIR\\plugins" "$preservedDataDir\\plugins" plugins
  !insertmacro fixtureCopy "$INSTDIR\\python-plugins" "$preservedDataDir\\python-plugins" python
  !insertmacro fixtureCopy "$INSTDIR\\plugin-configs" "$preservedDataDir\\plugin-configs" configs
  !insertmacro fixtureCopy "$INSTDIR\\runtime" "$preservedDataDir\\runtime" runtime
SectionEnd
!endif
!macroend
!macro customUnInstallCheck
  FileOpen $0 "${quote(path.join(sandbox, 'legacy-uninstall-result.txt'))}" w
  FileWrite $0 "$R0"
  FileClose $0
  StrCmp $R0 0 legacy_uninstall_ok
  SetErrorLevel 23
  Quit
legacy_uninstall_ok:
!macroend
!macro customInstall
  !insertmacro fixtureCopy "$preservedDataDir\\plugins" "$INSTDIR\\plugins" restore_plugins
  !insertmacro fixtureCopy "$preservedDataDir\\python-plugins" "$INSTDIR\\python-plugins" restore_python
  !insertmacro fixtureCopy "$preservedDataDir\\plugin-configs" "$INSTDIR\\plugin-configs" restore_configs
  !insertmacro fixtureCopy "$preservedDataDir\\runtime" "$INSTDIR\\runtime" restore_runtime
  RMDir /r "\\\\?\\$preservedDataDir"
!macroend
`;
}

function command(executable, args, options = {}) {
    const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, ...options });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
}

function registryPaths(guid, appId, hive = 'HKCU') {
    assert(/^[a-f0-9-]{36}$/.test(guid));
    assert(appId.startsWith('test.sanrenjz.upgrade.'));
    assert(['HKCU', 'HKLM'].includes(hive));
    return [`${hive}\\Software\\${guid}`, `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
        `${hive}\\Software\\Classes\\AppUserModelId\\${appId}`];
}

function createFixture({ perMachine = false } = {}) {
    const fixtureParent = path.join(repository, 'runtime');
    fs.mkdirSync(fixtureParent, { recursive: true });
    assert(!fs.lstatSync(fixtureParent).isSymbolicLink());
    const sandbox = fs.mkdtempSync(path.join(fixtureParent, 'sanrenjz-full-upgrade-'));
    const id = crypto.randomBytes(6).toString('hex');
    const guid = crypto.randomUUID();
    const appId = `test.sanrenjz.upgrade.${id}`;
    const productName = `聚智测${id}`;
    const payload = path.join(sandbox, 'payload');
    const project = path.join(sandbox, 'project');
    fs.mkdirSync(payload); fs.mkdirSync(project);
    fs.mkdirSync(path.join(payload, 'resources'));
    const application = path.join(payload, `${productName}.exe`);
    const stub = path.join(sandbox, 'application.nsi');
    fs.writeFileSync(stub, `Unicode true\nName "${productName}"\nOutFile "${quote(application)}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nSleep 600000\nSectionEnd\n`, 'utf8');
    command(compiler, ['/V2', '/INPUTCHARSET', 'UTF8', stub]);
    const baseline = path.join(sandbox, '0.2.1-installer.nsh');
    fs.writeFileSync(baseline, legacyCopyInclude(sandbox), 'utf8');
    const registries = registryPaths(guid, appId, perMachine ? 'HKLM' : 'HKCU');
    const cleanupRegistries = ['HKCU', 'HKLM'].flatMap(hive => registryPaths(guid, appId, hive));
    const binaries = new Map();
    let succeeded = false;
    const owned = new Set();
    const installationRoots = new Set();

    function build(name, include, scenario = {}) {
        const version = name === 'old' ? '1.0.0' : '2.0.0';
        const output = path.join(sandbox, 'build-' + name);
        if (!['old', 'baseline'].includes(name)) {
            fs.mkdirSync(path.join(project, 'build'), { recursive: true });
            for (const filename of ['installer.nsh', 'windows-update-transaction.ps1']) {
                const source = path.join(repository, 'build', filename);
                if (fs.existsSync(source)) fs.copyFileSync(source, path.join(project, 'build', filename));
            }
            include = path.join(project, 'build', 'installer.nsh');
            let source = fs.readFileSync(include, 'utf8');
            source = source.replace('  Pop $updateHelperOutput', `  Pop $updateHelperOutput\n  Push $9\n  FileOpen $9 "${quote(path.join(sandbox, 'helper-results.log'))}" a\n  FileSeek $9 0 END\n  FileWrite $9 "$updateHelperPhase exit=$updateHelperExit output=$updateHelperOutput$\\r$\\n"\n  FileClose $9\n  Pop $9`);
            if (scenario.abortAfterPrepare) {
                assert(source.includes('!macro customHeader'));
                source = source.replace('!macro customHeader', '!macro FixtureProductionHeader');
                source += `\n!macro customHeader\n!insertmacro FixtureProductionHeader\n!ifndef BUILD_UNINSTALLER\nSection "-fixtureAbort"\nReadEnvStr $0 TEMP\nFileOpen $1 "${quote(path.join(sandbox, 'prepared-temp.txt'))}" w\nFileWrite $1 "$0"\nFileClose $1\nAbort\nSectionEnd\n!endif\n!macroend\n`;
            }
            if (scenario.cancelBeforePrepare) {
                source = source.replace('!macro customInit', '!macro FixtureProductionInit');
                source += '\n!macro customInit\n!ifmacrodef FixtureProductionInit\n!insertmacro FixtureProductionInit\n!endif\nSetErrorLevel 2\nQuit\n!macroend\n';
            }
            if (scenario.abortAfterUnpack) {
                assert(source.includes('!macro customInstall'));
                source = source.replace('!macro customInstall', '!macro FixtureProductionInstall');
                source += '\n!macro customInstall\nAbort\n!macroend\n';
            }
            fs.writeFileSync(include, source, 'utf8');
        }
        const pkg = { name: `sjz-upgrade-${id}`, version, description: 'Isolated NSIS integration fixture', author: 'test', license: 'UNLICENSED',
            build: { appId, productName, electronVersion: require('electron/package.json').version, compression: 'store', publish: null,
                win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false },
                nsis: { guid, oneClick: false, perMachine: perMachine && name === 'old', allowElevation: false, allowToChangeInstallationDirectory: true,
                    createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false, deleteAppDataOnUninstall: false,
                    artifactName: 'fixture-${version}.exe', ...(include ? { include } : {}) } } };
        fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(pkg, null, 2));
        write(path.join(payload, 'payload-version.txt'), version);
        const result = spawnSync(process.execPath, [builder, '--projectDir', project, '--prepackaged', payload, '--win', '--x64', '--publish', 'never',
            `--config.directories.output=${output}`], { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 120000,
            env: { ...process.env, USE_HARD_LINKS: 'false', CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
        fs.writeFileSync(path.join(sandbox, 'build-' + name + '.log'), result.stdout + result.stderr);
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const executable = path.join(output, `fixture-${version}.exe`);
        assert(fs.existsSync(executable));
        binaries.set(name, executable);
        return executable;
    }

    async function execute(executable, args = [], environment = {}, timeout = 30000) {
        for (const argument of args) {
            if (argument.startsWith('/D=')) {
                const installed = path.resolve(argument.slice(3));
                assert(installed.startsWith(sandbox + path.sep));
                installationRoots.add(installed);
            }
        }
        return new Promise((resolve, reject) => {
            const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, ...environment } });
            owned.add(child);
            const timer = setTimeout(() => {
                spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            }, timeout);
            child.once('error', error => { clearTimeout(timer); owned.delete(child); reject(error); });
            child.once('close', (code, signal) => { clearTimeout(timer); owned.delete(child); resolve({ code, signal }); });
        });
    }

    async function startApplication(installed) {
        const child = spawn(path.join(installed, `${productName}.exe`), ['/S'], { windowsHide: true, stdio: 'ignore' });
        owned.add(child);
        child.once('close', () => owned.delete(child));
        await delay(300);
        assert.equal(child.exitCode, null, '隔离宿主确实在运行');
        return child;
    }

    async function cleanup() {
        // 只处理本次唯一进程和随机 GUID 对应的测试键，不读取或卸载真实产品。
        for (const child of owned) {
            if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }
        const deadline = Date.now() + 10000;
        while ([...owned].some(child => child.exitCode === null) && Date.now() < deadline) await delay(50);
        assert(![...owned].some(child => child.exitCode === null), '清理前所有原生子进程已结束');
        unregister();
        assert.equal(path.dirname(sandbox), fixtureParent);
        assert(path.basename(sandbox).startsWith('sanrenjz-full-upgrade-'));
        if (succeeded) fs.rmSync(sandbox, { recursive: true, force: true });
        else {
            console.error('NSIS integration failure materials: ' + sandbox);
            // 失败时只打印本次 synthetic fixture 的安装事务日志，不读取状态快照或用户文件。
            const logs = [path.join(sandbox, 'helper-results.log'), path.join(sandbox, 'legacy-uninstall-result.txt'),
                ...[...installationRoots].flatMap(installed => ['transaction.log', 'legacy-recovery.log']
                    .map(filename => path.join(installed + backupSuffix, filename)))];
            for (const file of logs) {
                if (!fs.existsSync(file)) continue;
                const bytes = fs.readFileSync(file);
                const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8';
                console.error(`NSIS_DIAGNOSTIC ${file}\n${bytes.toString(encoding).slice(-8000)}`);
            }
        }
    }

    function unregister() {
        for (const key of cleanupRegistries) for (const view of ['32', '64']) {
            spawnSync('reg.exe', ['delete', key, '/f', '/reg:' + view], { windowsHide: true, stdio: 'ignore' });
        }
    }

    return { sandbox, productName, guid, appId, baseline, registries, binaries, build, execute, startApplication, cleanup, unregister,
        pass() { succeeded = true; } };
}

function canaries(installed, longPath) {
    const files = ['plugins/fixture/.runtime/keep.bin', 'python-plugins/fixture/main.py', 'plugin-configs/keep.json', 'runtime/python/keep.bin'];
    if (longPath) {
        const prefix = path.join('plugins', 'fixture', '.runtime', 'CacheStorage', 'a'.repeat(32));
        const padding = 250 - path.join(installed, prefix, 'the-real-index').length - 1;
        assert(padding > 0 && padding <= 220);
        const relative = path.join(prefix, 'b'.repeat(padding), 'the-real-index');
        assert.equal(path.join(installed, relative).length, 250);
        assert(path.join(installed + backupSuffix, relative).length > 260);
        files.push(relative);
    }
    for (const file of files) write(path.join(installed, file), Buffer.from([0, 3, 255, 128, 10, 13, 17]));
    return files;
}

function crossVolumeTemporaryRoot(sandbox) {
    const configured = path.join(process.env.LOCALAPPDATA || '', 'Temp');
    if (!fs.existsSync(configured)) return null;
    const alternate = fs.realpathSync(configured);
    if (path.parse(alternate).root.toLowerCase() === path.parse(sandbox).root.toLowerCase() || fs.statSync(alternate).dev === fs.statSync(sandbox).dev) return null;
    return fs.mkdtempSync(path.join(alternate, 'sanrenjz-cross-temp-'));
}

test('真实 NSIS 长路径覆盖升级：旧卸载器、中文宿主关闭及准备失败重试', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
    assert(fs.existsSync(compiler));
    const fixture = createFixture();
    t.after(() => fixture.cleanup());
    const old = fixture.build('old');
    const baseline = fixture.build('baseline', fixture.baseline);
    const current = fixture.build('current', productionInclude);
    const aborted = fixture.build('aborted', productionInclude, { abortAfterPrepare: true });
    const installed = path.join(fixture.sandbox, '安装 目录', fixture.productName);
    const originalTemp = path.join(path.dirname(installed), 'temporary-runtime-path');
    const originalEnvironment = { TEMP: originalTemp, TMP: originalTemp };
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.mkdirSync(originalTemp, { recursive: true });
    assert.equal((await fixture.execute(old, ['/S', `/D=${installed}`], originalEnvironment)).code, 0, '真实旧安装器安装成功');
    const files = canaries(installed, true);
    assert(fs.existsSync(path.join(installed, `Uninstall ${fixture.productName}.exe`)), '保留实际旧版原生卸载器');

    // 旧版本复制备份后仍让旧卸载器搬运深层文件，必须在无宿主运行时也能复现失败。
    const failed = await fixture.execute(baseline, ['/S', `/D=${installed}`], originalEnvironment);
    assert.notEqual(failed.code, 0, '0.2.1 真实覆盖升级基线应暴露旧卸载器长路径缺陷');
    assert.equal(fs.readFileSync(path.join(fixture.sandbox, 'legacy-uninstall-result.txt'), 'utf8'), '2', '真实旧卸载器报告卸载失败，并非宿主进程占用');
    t.diagnostic('旧版长路径卸载返回 2；复制备份完整，失败基线已复现');
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed + backupSuffix, file)), Buffer.from([0, 3, 255, 128, 10, 13, 17]), '失败仍有完整复制备份');
    for (const file of ['plugin_runtime/library/keep.bin', 'host-deploy-backups/local.js', 'custom-root-data/keep.bin']) {
        write(path.join(installed, file), Buffer.from([0, 3, 255, 128, 10, 13, 17]));
        files.push(file);
    }

    const completed = await fixture.execute(current, ['/S', `/D=${installed}`], originalEnvironment, 120000);
    assert.equal(completed.code, 0, '新安装器真实调用旧卸载器并恢复数据');
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed, file)), Buffer.from([0, 3, 255, 128, 10, 13, 17]), file);
    assert.equal(fs.readFileSync(path.join(installed, 'payload-version.txt'), 'utf8'), '2.0.0');
    t.diagnostic('生产事务已真实调用旧卸载器，长路径资料与新版载荷均已验证');

    const host = await fixture.startApplication(installed);
    const interrupted = await fixture.execute(aborted, ['/S', `/D=${installed}`], originalEnvironment, 120000);
    assert.notEqual(interrupted.code, 0, 'prepare 后的失败必须返回失败');
    assert.notEqual(host.exitCode, null, '真实 CHECK_APP_RUNNING 已关闭本次中文名隔离宿主');
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed, file)), Buffer.from([0, 3, 255, 128, 10, 13, 17]), '失败回滚保留资料');
    assert.equal((await fixture.execute(current, ['/S', `/D=${installed}`], originalEnvironment, 120000)).code, 0, '同一固定事务目录可以失败后重试');
    const siblingNames = fs.readdirSync(path.dirname(installed));
    assert(!siblingNames.some(name => name.startsWith(fixture.productName + backupSuffix + '.previous-')), '不产生新散落备份');
    assert(fs.readFileSync(path.join(fixture.sandbox, 'prepared-temp.txt'), 'utf8').endsWith('\\active\\temp'), '旧卸载器的 TEMP 使用同盘固定事务目录');
    t.diagnostic('prepare 后失败已回滚；同一固定备份目录重试成功');

    fixture.pass();
});

test('真实解包后失败回滚：旧程序、HKCU 注册表和未知顶层资料', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
    const fixture = createFixture(); t.after(() => fixture.cleanup());
    const old = fixture.build('old');
    const current = fixture.build('current', productionInclude);
    const failure = fixture.build('unpacked-failure', productionInclude, { abortAfterUnpack: true });
    const installed = path.join(fixture.sandbox, 'rollback', fixture.productName);
    const temp = path.join(fixture.sandbox, 'temporary-runtime-path'); fs.mkdirSync(temp);
    const environment = { TEMP: temp, TMP: temp };
    assert.equal((await fixture.execute(old, ['/S', `/D=${installed}`], environment)).code, 0);
    const files = canaries(installed, true);
    for (const file of ['plugin_runtime/library/keep.bin', 'custom-root-data/keep.bin']) {
        write(path.join(installed, file), Buffer.from([0, 3, 255, 128, 10, 13, 17])); files.push(file);
    }
    assert.notEqual((await fixture.execute(failure, ['/S', `/D=${installed}`], environment, 120000)).code, 0);
    assert.equal(fs.readFileSync(path.join(installed, 'payload-version.txt'), 'utf8'), '1.0.0', '新版解包后的失败回滚旧程序');
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed, file)), Buffer.from([0, 3, 255, 128, 10, 13, 17]));
    assert(command('reg.exe', ['query', fixture.registries[1], '/v', 'DisplayVersion', '/reg:64']).includes('1.0.0'));
    assert.equal((await fixture.execute(current, ['/S', `/D=${installed}`], environment, 120000)).code, 0);
    assert.equal(fs.readFileSync(path.join(installed, 'payload-version.txt'), 'utf8'), '2.0.0');
    t.diagnostic('新版解包/写注册表后失败已回滚旧载荷及注册信息，并可重新升级');
    fixture.pass();
});

test('真实初始化退出与全新安装：不预先创建备份', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
    const fixture = createFixture(); t.after(() => fixture.cleanup());
    const current = fixture.build('current', productionInclude);
    const cancelled = fixture.build('cancelled', productionInclude, { cancelBeforePrepare: true });
    const installed = path.join(fixture.sandbox, 'fresh', fixture.productName);
    assert.notEqual((await fixture.execute(cancelled, ['/S', `/D=${installed}`])).code, 0);
    assert(!fs.existsSync(installed + backupSuffix), '初始化退出不产生升级事务，不宣称 UI 手动取消');
    assert.equal((await fixture.execute(current, ['/S', `/D=${installed}`], {}, 120000)).code, 0);
    assert.equal(fs.readFileSync(path.join(installed, 'payload-version.txt'), 'utf8'), '2.0.0');
    fixture.pass();
});

test('真实跨盘 TEMP 覆盖升级：旧卸载器与固定同盘事务', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
    const fixture = createFixture(); t.after(() => fixture.cleanup());
    const crossTemp = crossVolumeTemporaryRoot(fixture.sandbox);
    if (!crossTemp) { fixture.pass(); t.skip('没有可写的跨盘 TEMP'); return; }
    try {
        const old = fixture.build('old');
        const baseline = fixture.build('baseline', fixture.baseline);
        const current = fixture.build('current', productionInclude);
        const installed = path.join(fixture.sandbox, 'cross-volume', fixture.productName);
        const environment = { TEMP: crossTemp, TMP: crossTemp };
        assert.notEqual(path.parse(installed).root.toLowerCase(), path.parse(crossTemp).root.toLowerCase());
        assert.equal((await fixture.execute(old, ['/S', `/D=${installed}`], environment)).code, 0);
        const files = canaries(installed, false);
        const before = await fixture.execute(baseline, ['/S', `/D=${installed}`], environment);
        assert.equal(before.code, 0, '原生 NSIS 逐文件跨盘移动本身可成功，不能误当必现根因');
        assert.equal((await fixture.execute(current, ['/S', `/D=${installed}`], environment, 120000)).code, 0);
        for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed, file)), Buffer.from([0, 3, 255, 128, 10, 13, 17]));
        t.diagnostic('TEMP 跨盘下原生旧链路实际可完成；生产固定同盘事务也已成功升级');
    } finally {
        assert.equal(path.dirname(crossTemp), fs.realpathSync(path.join(process.env.LOCALAPPDATA, 'Temp')));
        assert(path.basename(crossTemp).startsWith('sanrenjz-cross-temp-'));
        fs.rmSync(crossTemp, { recursive: true, force: true });
    }
    fixture.pass();
});

test('真实 all-users 升级及回滚：独立 HKLM GUID、长路径资料和重试', { skip: process.platform !== 'win32', timeout: 180000 }, async t => {
    const check = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { encoding: 'utf8', windowsHide: true });
    if (check.status !== 0 || check.stdout.trim() !== 'True') { t.skip('需要管理员 token 才能验证独立 HKLM all-users 事务'); return; }
    const fixture = createFixture({ perMachine: true });
    t.after(() => fixture.cleanup());
    const old = fixture.build('old');
    const current = fixture.build('current', productionInclude);
    const failure = fixture.build('unpacked-failure', productionInclude, { abortAfterUnpack: true });
    const installed = path.join(fixture.sandbox, 'all-users', fixture.productName);
    const temp = path.join(fixture.sandbox, 'temporary-runtime-path'); fs.mkdirSync(temp);
    const environment = { TEMP: temp, TMP: temp };
    assert.equal((await fixture.execute(old, ['/S', `/D=${installed}`], environment)).code, 0);
    assert(command('reg.exe', ['query', fixture.registries[1], '/v', 'DisplayVersion', '/reg:64']).includes('1.0.0'));
    const files = canaries(installed, true);
    write(path.join(installed, 'custom-data/keep.bin'), Buffer.from([0, 3, 255, 128, 10, 13, 17])); files.push('custom-data/keep.bin');
    assert.notEqual((await fixture.execute(failure, ['/S', `/D=${installed}`], environment, 120000)).code, 0);
    assert.equal(fs.readFileSync(path.join(installed, 'payload-version.txt'), 'utf8'), '1.0.0');
    assert(command('reg.exe', ['query', fixture.registries[1], '/v', 'DisplayVersion', '/reg:64']).includes('1.0.0'), '失败后恢复旧 HKLM 注册信息');
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed, file)), Buffer.from([0, 3, 255, 128, 10, 13, 17]));
    assert.equal((await fixture.execute(current, ['/S', `/D=${installed}`], environment, 120000)).code, 0);
    assert.equal(fs.readFileSync(path.join(installed, 'payload-version.txt'), 'utf8'), '2.0.0');
    assert(command('reg.exe', ['query', fixture.registries[1], '/v', 'DisplayVersion', '/reg:64']).includes('2.0.0'));
    for (const file of files) assert.deepEqual(fs.readFileSync(path.join(installed, file)), Buffer.from([0, 3, 255, 128, 10, 13, 17]));
    t.diagnostic('真实 HKLM all-users 旧安装、解包后回滚及重试升级均通过，所有资料字节一致');
    fixture.pass();
});
