const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getInstalledAppRoot } = require('../app/install-root');

test('Windows安装目录和Portable原始目录保持原规则', () => {
    const app = { isPackaged: true, getPath: () => { throw new Error('Windows不切换用户插件目录'); } };
    const executable = path.resolve('isolated/install/sanrenjz.exe');
    assert.equal(getInstalledAppRoot(app, { platform: 'win32', env: {}, executable }), path.dirname(executable));
    assert.equal(getInstalledAppRoot(app, { platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'portable-root' } }), 'portable-root');
});

test('macOS与Linux插件放在可写userData，运行不修改签名包或AppImage挂载目录', () => {
    const app = { isPackaged: true, getPath: name => { assert.equal(name, 'userData'); return 'isolated-profile'; } };
    for (const platform of ['darwin', 'linux']) {
        assert.equal(getInstalledAppRoot(app, { platform, env: { PORTABLE_EXECUTABLE_DIR: 'bundle-root' }, executable: 'read-only-bundle' }), 'isolated-profile');
    }
});

test('开发态仍使用项目目录，不随宿主系统迁移插件', () => {
    const app = { isPackaged: false, getPath: () => { throw new Error('开发态不使用真实用户数据'); } };
    assert.equal(getInstalledAppRoot(app, { platform: 'darwin', developmentRoot: 'project-root' }), 'project-root');
});
