'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');


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
