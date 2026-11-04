'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const { install } = require('../build/dmg-detach-retry.cjs');
const builderUtil = require('builder-util');
const originalExec = builderUtil.exec;

test('DMG卸载仅重试本次成功挂载设备的资源忙，保留原始构建清理路径', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-dmg-retry-'));
    const image = path.join(root, 'owned.dmg');
    const secondImage = path.join(root, 'second.dmg');
    const foreignImage = path.join(root, 'foreign.dmg');
    const manager = { tempFiles: [] };
    const context = { electronPlatformName: 'darwin', packager: { info: { tempDirManager: manager } } };
    let execute;
    let waits;
    let assertions = 0;
    const equal = (actual, expected) => { assert.deepEqual(actual, expected); assertions++; };
    const busy = () => new Error('\u001b[31mExit code: 16. Command failed: hdiutil detach -force /dev/disk2\nhdiutil: couldn\'t eject "disk2" - Resource busy\u001b[39m');
    const failure = (code, reason) => new Error(`Exit code: ${code}. Command failed: hdiutil detach -force /dev/disk2\n${reason}`);
    try {
        equal(install({ electronPlatformName: 'win32' }), false);
        assert.throws(() => install({ electronPlatformName: 'darwin' }), /临时文件登记/); assertions++;
        equal(builderUtil.exec, originalExec);
        install(context, { exec: (...args) => execute(...args), sleep: async milliseconds => { waits.push(milliseconds); } });
        const wrapper = builderUtil.exec;
        equal(install(context), true);
        equal(builderUtil.exec, wrapper);
        // 运行锁定依赖中的原始attach/finally代码；Windows无dmg-license，仅隔离循环导出。
        const sourceFile = require.resolve('dmg-builder/out/dmgUtil');
        const sourceRequire = createRequire(sourceFile);
        equal(sourceRequire('builder-util'), builderUtil);
        const dmg = {};
        vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), {
            exports: dmg, __dirname: path.dirname(sourceFile),
            require: name => name === './dmg' ? {} : sourceRequire(name),
            setTimeout: callback => { queueMicrotask(callback); return 0; },
        }, { filename: sourceFile });

        async function scenario({ imagePath = image, quietFailure = busy(), forceFailures = [], taskError, attachOutput = '/dev/disk2\tGUID_partition_scheme\n/dev/disk2s1\tApple_HFS\t/Volumes/example', attachError, direct } = {}) {
            const calls = []; waits = [];
            let index = 0;
            execute = async (file, args, ...rest) => {
                calls.push({ file, args, rest });
                if (args[0] === 'attach') { if (attachError) throw attachError; return attachOutput; }
                if (args[0] === 'detach' && args[1] === '-quiet' && quietFailure) throw quietFailure;
                if (args[0] === 'detach' && args[1] === '-force') { const error = forceFailures[index++]; if (error) throw error; }
                return 'complete';
            };
            let error;
            let result;
            try {
                result = direct ? await builderUtil.exec(...direct) : await dmg.attachAndExecute(imagePath, true, async () => { if (taskError) throw taskError; return 'customized'; });
            } catch (caught) { error = caught; }
            return { result, error, calls, waits, forces: calls.filter(call => call.args[0] === 'detach' && call.args[1] === '-force').length };
        }
        // 安装时登记为空；之后追加/替换登记表仍应生效。
        manager.tempFiles.push({ path: image, isDir: false });
        let result = await scenario({ forceFailures: [busy(), busy()] });
        equal(result.error, undefined); equal(result.result, 'customized'); equal(result.waits, [3000, 6000]); equal(result.forces, 3);
        const lastBusy = busy();
        result = await scenario({ forceFailures: [busy(), busy(), busy(), lastBusy] });
        equal(result.error, lastBusy); equal(result.waits, [3000, 6000, 9000]); equal(result.forces, 4);
        const invalid = failure(6, 'Device not configured');
        result = await scenario({ forceFailures: [invalid] });
        equal(result.error, invalid); equal(result.waits, []); equal(result.forces, 1);
        result = await scenario({ imagePath: foreignImage, forceFailures: [lastBusy] });
        // 即使设备号被外部镜像复用，也不能继承上一场失败挂载的所有权。
        equal(result.error, lastBusy); equal(result.waits, []); equal(result.forces, 1);
        result = await scenario({ quietFailure: null });
        equal(result.error, undefined); equal(result.forces, 0); equal(result.waits, []);
        result = await scenario({ direct: ['hdiutil', ['detach', '-force', '/dev/disk2']], forceFailures: [lastBusy] });
        equal(result.error, lastBusy); equal(result.waits, []); equal(result.forces, 1);
        const taskError = new Error('customize failed');
        result = await scenario({ forceFailures: [busy()], taskError });
        equal(result.error, taskError); equal(result.forces, 2); equal(result.waits, [3000]);
        result = await scenario({ direct: ['hdiutil', ['detach', '-force', '/dev/disk99']], forceFailures: [lastBusy] });
        equal(result.error, lastBusy); equal(result.waits, []); equal(result.forces, 1);
        result = await scenario({ direct: ['other', ['detach', '-force', '/dev/disk2']], forceFailures: [lastBusy] });
        equal(result.error, lastBusy); equal(result.waits, []); equal(result.forces, 1);
        const attachFailure = new Error('attach failed');
        result = await scenario({ attachError: attachFailure });
        equal(result.error, attachFailure); equal(result.forces, 0); equal(result.waits, []);
        for (const error of [failure(116, 'Resource busy'), failure(6, 'Resource busy'), failure(16, 'Permission denied')]) {
            result = await scenario({ forceFailures: [error] });
            equal(result.error, error); equal(result.waits, []); equal(result.forces, 1);
            await scenario({ quietFailure: null });
        }
        manager.tempFiles = [{ path: secondImage, isDir: false }];
        result = await scenario({ imagePath: secondImage, forceFailures: [busy()] });
        equal(result.error, undefined); equal(result.waits, [3000]);
        const secondManager = { tempFiles: [] };
        equal(install({ ...context, packager: { info: { tempDirManager: secondManager } } }), true);
        equal(builderUtil.exec, wrapper);
        secondManager.tempFiles.push({ path: image, isDir: false });
        result = await scenario({ forceFailures: [busy()] });
        equal(result.error, undefined); equal(result.waits, [3000]);
        secondManager.tempFiles = [{ path: image, isDir: true }];
        result = await scenario({ forceFailures: [lastBusy] });
        equal(result.error, lastBusy); equal(result.waits, []);
        secondManager.tempFiles = [{ path: image, isDir: false }];
        result = await scenario({ attachOutput: '/dev/other\tunknown', forceFailures: [lastBusy] });
        equal(result.error, lastBusy); equal(result.waits, []);
        const nativeBusy = Object.assign(new Error('hdiutil: Resource busy'), { code: 16 });
        result = await scenario({ forceFailures: [nativeBusy] });
        equal(result.error, undefined); equal(result.waits, [3000]);
        for (const imagePath of [path.join(root, 'owned.zip'), 'relative.dmg']) {
            secondManager.tempFiles = [{ path: imagePath, isDir: false }];
            result = await scenario({ imagePath, forceFailures: [lastBusy] });
            equal(result.error, lastBusy); equal(result.waits, []); equal(result.forces, 1);
        }
        const passthrough = { cwd: root, env: { FIXTURE: 'synthetic' } };
        result = await scenario({ direct: ['which', ['python3'], passthrough, false] });
        equal(result.result, 'complete'); equal(result.calls[0].rest, [passthrough, false]); equal(result.waits, []);
        const outsideExec = () => {};
        builderUtil.exec = outsideExec;
        assert.throws(() => install(context), /其他钩子修改/); assertions++;
        equal(builderUtil.exec, outsideExec);
        console.log(`DMG detach retry passed: ${assertions} assertions; no real child processes`);
    } finally {
        builderUtil.exec = originalExec;
        fs.rmSync(root, { recursive: true, force: true });
    }
});
