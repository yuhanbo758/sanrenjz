'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const nsis = path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache/nsis/nsis-3.0.4.1/Bin/makensis.exe');
const include = path.join(root, 'build/installer.nsh');
const suffix = '.sanrenjz-update-backup';
const quote = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

test('构建平台隔离：Windows 只选择 NSIS，Mac 原生编译及签名钩子不介入', async () => {
    const pkg = require('../package.json');
    const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory');
    const { Platform } = require('app-builder-lib/out/core');
    const { Arch } = require('builder-util');
    const targets = computeArchToTargetNamesMap(new Map([[Arch.x64, []]]), {
        platformSpecificBuildOptions: pkg.build.win, defaultTarget: ['nsis']
    }, Platform.WINDOWS);
    assert.deepEqual([...targets.keys()], [Arch.x64]);
    assert.deepEqual(targets.get(Arch.x64), ['nsis']);
    assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
    const context = { electronPlatformName: 'win32', get packager() { throw new Error('Windows 不得进入 Mac 构建步骤'); } };
    await require('../build/prepare-native.cjs')(context);
    await require('../build/preview-sign.cjs')(context);
});

test('Windows 原生 NSIS：取消、最终目录、残留备份、完整恢复和失败重试', { skip: process.platform !== 'win32', timeout: 120000 }, () => {
    assert(fs.existsSync(nsis), '需要 electron-builder 缓存中的 NSIS 编译器');
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-nsis-'));
    const executable = path.join(sandbox, 'fixture.exe');
    const script = path.join(sandbox, 'fixture.nsi');
    // 直接编译生产宏，只替换宿主关闭检查和安装载荷；不接触注册表、快捷方式及真实安装。
    fs.writeFileSync(script, `Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${quote(executable)}"
!include "LogicLib.nsh"
!include "${quote(include)}"
Var lockHandle
!macro CHECK_APP_RUNNING
!macroend
Function .onInit
  ReadEnvStr $INSTDIR SANRENJZ_FIXTURE_INITIAL
  !ifmacrodef customInit
    !insertmacro customInit
  !endif
  ReadEnvStr $0 SANRENJZ_FIXTURE_CANCEL
  StrCmp $0 "1" 0 +2
  Quit
  ReadEnvStr $INSTDIR SANRENJZ_FIXTURE_TARGET
  ReadEnvStr $0 SANRENJZ_FIXTURE_FAIL_BACKUP
  StrCmp $0 "1" 0 +2
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\\plugins\\locked.bin", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .s'
  StrCmp $0 "1" 0 +2
  Pop $lockHandle
FunctionEnd
!insertmacro customHeader
Section "install"
  CreateDirectory "$INSTDIR"
  FileOpen $0 "$INSTDIR\\install-started.txt" w
  FileClose $0
  RMDir /r "$INSTDIR\\plugins"
  RMDir /r "$INSTDIR\\python-plugins"
  RMDir /r "$INSTDIR\\plugin-configs"
  RMDir /r "$INSTDIR\\runtime"
  CreateDirectory "$INSTDIR\\plugins"
  FileOpen $0 "$INSTDIR\\plugins\\only-new.txt" w
  FileWrite $0 "new payload"
  FileClose $0
  ReadEnvStr $0 SANRENJZ_FIXTURE_FAIL_RESTORE
  StrCmp $0 "1" 0 restore_ready
  CreateDirectory "$INSTDIR\\plugins"
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\\plugins\\locked.bin", i 0x40000000, i 0, p 0, i 2, i 0, p 0) p .s'
  Pop $lockHandle
restore_ready:
  !insertmacro customInstall
SectionEnd
`, 'utf8');
    const compile = spawnSync(nsis, ['/V2', '/INPUTCHARSET', 'UTF8', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    function run(name, options = {}) {
        const target = path.join(sandbox, name, '应用 程序');
        const result = spawnSync(executable, ['/S'], { timeout: 20000, windowsHide: true, env: {
            ...process.env, SANRENJZ_FIXTURE_TARGET: target, SANRENJZ_FIXTURE_INITIAL: options.initial || target,
            SANRENJZ_FIXTURE_CANCEL: options.cancel ? '1' : '',
            SANRENJZ_FIXTURE_FAIL_BACKUP: options.failBackup ? '1' : '',
            SANRENJZ_FIXTURE_FAIL_RESTORE: options.failRestore ? '1' : ''
        } });
        assert.ifError(result.error);
        return { target, status: result.status };
    }
    try {
        const cancelled = path.join(sandbox, 'cancel', '应用 程序');
        write(path.join(cancelled, 'plugins/keep.txt'), 'original');
        run('cancel', { cancel: true });
        assert(!fs.existsSync(cancelled + suffix), '取消安装不得创建升级备份');

        const target = path.join(sandbox, 'upgrade', '应用 程序');
        const canaries = ['plugins/插件/.runtime/会话.bin', 'plugins/.hidden', 'python-plugins/程序/main.py', 'plugin-configs/keep.json', 'runtime/python/deep/keep.bin'];
        const longPrefix = path.join('plugins', '长路径插件', '.runtime', 'CacheStorage', 'a'.repeat(48));
        const padding = 250 - path.join(target, longPrefix, 'the-real-index').length - 1;
        assert(padding > 0 && padding < 200);
        const longCanary = path.join(longPrefix, 'b'.repeat(padding), 'the-real-index');
        assert.equal(path.join(target, longCanary).length, 250);
        assert(path.join(target + suffix, longCanary).length > 260, '备份后才越过 Shell 复制的长路径限制');
        canaries.push(longCanary);
        for (const name of canaries) write(path.join(target, name), Buffer.from([0, 1, 255, 2, 128]));
        fs.mkdirSync(path.join(target, 'plugins/空目录'), { recursive: true });
        write(path.join(target, 'plugins/hidden-windows.bin'), 'hidden attribute');
        assert.equal(spawnSync('attrib.exe', ['+H', path.join(target, 'plugins/hidden-windows.bin')], { windowsHide: true }).status, 0);
        write(path.join(target + suffix, 'plugins/stale.txt'), 'old recovery');
        write(path.join(target + suffix, 'plugins/插件/.runtime/会话.bin'), 'stale recovery');
        const result = run('upgrade', { initial: cancelled });
        assert.equal(result.status, 0);
        for (const name of canaries) assert.deepEqual(fs.readFileSync(path.join(target, name)), Buffer.from([0, 1, 255, 2, 128]), name);
        assert(fs.existsSync(path.join(target, 'plugins/空目录')), '保留空目录');
        assert.equal(fs.readFileSync(path.join(target, 'plugins/hidden-windows.bin'), 'utf8'), 'hidden attribute');
        assert(!fs.existsSync(path.join(target, 'plugins/stale.txt')), '旧恢复材料不得覆盖当前插件');
        assert.equal(fs.readFileSync(path.join(target, 'plugins/only-new.txt'), 'utf8'), 'new payload', '恢复不删除新载荷文件');
        const previous = fs.readdirSync(path.dirname(target)).filter(name => name.startsWith(path.basename(target) + suffix + '.previous-'));
        assert.equal(previous.length, 1);
        assert.equal(fs.readFileSync(path.join(path.dirname(target), previous[0], 'plugins/stale.txt'), 'utf8'), 'old recovery');
        assert(!fs.existsSync(target + suffix));
        assert.equal(fs.readFileSync(path.join(cancelled, 'plugins/keep.txt'), 'utf8'), 'original', '最终目录改变不触碰初始目录');

        for (const failure of ['Backup', 'Restore']) {
            const name = 'fail-' + failure;
            const failedTarget = path.join(sandbox, name, '应用 程序');
            write(path.join(failedTarget, 'plugins/locked.bin'), 'recover me');
            const failed = run(name, { ['fail' + failure]: true });
            assert.notEqual(failed.status, 0, failure + '失败必须报告非零退出');
            if (failure === 'Backup') {
                assert(!fs.existsSync(path.join(failedTarget, 'install-started.txt')), '备份失败不得进入卸载安装');
                assert.equal(fs.readFileSync(path.join(failedTarget, 'plugins/locked.bin'), 'utf8'), 'recover me');
            } else {
                assert.equal(fs.readFileSync(path.join(failedTarget + suffix, 'plugins/locked.bin'), 'utf8'), 'recover me', '恢复失败保留完整备份');
            }
            assert.equal(run(name).status, 0, failure + '失败后可以重试');
        }
        assert.equal(run('fresh').status, 0, '全新安装');
        assert.equal(run('fresh').status, 0, '没有保留目录也可再次安装');
        fs.mkdirSync(path.join(sandbox, 'empty', '应用 程序', 'plugins'), { recursive: true });
        assert.equal(run('empty').status, 0, 'Robocopy 的 0 返回值也是成功');
        const linkedTarget = path.join(sandbox, 'linked', '应用 程序');
        const external = path.join(sandbox, 'junction-target');
        write(path.join(external, 'keep.txt'), 'external target');
        fs.mkdirSync(path.join(linkedTarget, 'plugins'), { recursive: true });
        fs.symlinkSync(external, path.join(linkedTarget, 'plugins/external-link'), 'junction');
        assert.notEqual(run('linked').status, 0, '目录联接必须在旧卸载器执行前被拒绝');
        assert(!fs.existsSync(path.join(linkedTarget, 'install-started.txt')));
        assert.equal(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8'), 'external target');
    } finally {
        assert(path.dirname(sandbox) === os.tmpdir() && path.basename(sandbox).startsWith('sanrenjz-nsis-'));
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});
