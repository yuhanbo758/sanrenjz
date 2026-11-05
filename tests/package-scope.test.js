'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { createStage, parseSelections, parseBuildOptions, builderEnvironment } = require('../scripts/package-local');
const { auditEntries, auditPackage } = require('../scripts/audit-public-scope');
const projectPackage = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
assert(projectPackage.build.mac.target.every(target => typeof target === 'string' || !target.arch), 'macOS矩阵架构必须由本次CLI指定，不能被目标数组展开为两个架构');
const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory');
const { Arch } = require('builder-util');
const { Platform } = require('app-builder-lib/out/core');
for (const architecture of [Arch.x64, Arch.arm64]) {
    const targets = computeArchToTargetNamesMap(new Map([[architecture, []]]), { platformSpecificBuildOptions: projectPackage.build.mac, defaultTarget: ['dmg', 'zip'] }, Platform.MAC);
    assert.deepStrictEqual([...targets.keys()], [architecture], '真实builder目标解析不得追加另一架构');
    assert.deepStrictEqual(targets.get(architecture).sort(), ['dmg', 'zip']);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-package-'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8'); };
try {
    const publicCatalog = { tools: ['public-tool'], python: ['public-python'] };
    const privateCatalog = { tools: ['private-tool'], python: ['private-python'] };
    write(path.join(root, 'config', 'public-plugins.json'), publicCatalog);
    write(path.join(root, 'config', 'private-plugins.json'), privateCatalog);
    write(path.join(root, 'config', 'python-runtime.json'), { version: 'fixture' });
    write(path.join(root, 'package.json'), { name: 'fixture', version: '1.0.0', main: 'main.js', repository: 'old', homepage: 'old', bugs: 'old', build: { publish: { provider: 'github' } } });
    write(path.join(root, 'main.js'), 'fixture');
    write(path.join(root, 'merged-ui.js'), 'fixture');
    write(path.join(root, 'app', 'resource-layout.js'), "module.exports=require('../config/python-runtime.json');");
    write(path.join(root, 'app', 'account-avatar.js'), 'module.exports={fixture:true};');
    write(path.join(root, 'app', 'account-avatar-store.js'), 'module.exports={fixture:true};');
    write(path.join(root, 'settings.json'), { account: 'never-package' });
    write(path.join(root, 'python', 'python.exe'), 'never-package');
    write(path.join(root, 'build', 'developer.p12'), 'never-package');
    for (const id of ['public-tool', 'private-tool', 'evil-unlisted']) {
        write(path.join(root, 'app', 'software', id, 'plugin.json'), { pluginName: id });
        write(path.join(root, 'app', 'software', id, 'index.html'), id);
    }
    for (const id of ['public-python', 'private-python']) {
        write(path.join(root, 'app', 'python-software', id, 'settings.json'), { main_file: 'main.py', config_file: 'config.json' });
        write(path.join(root, 'app', 'python-software', id, 'main.py'), 'fixture');
        write(path.join(root, 'app', 'python-software', id, 'config.json'), { token: 'never-package' });
    }
    const avatarLocations = ['app/plugin_runtime/account-avatar', 'app/software/public-tool/account-avatar', 'app/python-software/public-python/account-avatar'];
    const binaryPhoto = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]);
    for (const location of avatarLocations) {
        write(path.join(root, location, 'avatar.json'), { version: 1, filename: 'fixture.png' });
        fs.writeFileSync(path.join(root, location, 'fixture.png'), binaryPhoto);
        fs.writeFileSync(path.join(root, location, 'screenshot.png'), binaryPhoto);
    }
    const stage = path.join(root, 'stage-public');
    createStage({ root, stage });
    assert(!fs.existsSync(path.join(stage, 'app', 'software', 'private-tool')));
    assert(!fs.existsSync(path.join(stage, 'app', 'software', 'evil-unlisted')));
    assert(!fs.existsSync(path.join(stage, 'python')) && !fs.existsSync(path.join(stage, 'settings.json')));
    assert(!fs.existsSync(path.join(stage, 'build', 'developer.p12')));
    assert(fs.existsSync(path.join(stage, 'app', 'python-software', 'public-python', 'settings.json')));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(stage, 'app', 'python-software', 'public-python', 'config.json'))), {});
    const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json')));
    assert.strictEqual(pkg.build.publish, null);
    assert(!pkg.repository && !pkg.homepage && !pkg.bugs && !pkg.scripts);
    const resourceConfig = pkg.build.extraResources.find(group => group.from === 'config');
    assert(resourceConfig && resourceConfig.to === 'config');
    assert.deepStrictEqual(resourceConfig.filter.sort(), ['public-plugins.json', 'python-runtime.json']);
    const resourceRoot = path.join(root, 'layout', 'resources');
    fs.mkdirSync(path.join(resourceRoot, 'app'), { recursive: true });
    fs.mkdirSync(path.join(resourceRoot, resourceConfig.to), { recursive: true });
    for (const filename of resourceConfig.filter) fs.copyFileSync(path.join(stage, resourceConfig.from, filename), path.join(resourceRoot, resourceConfig.to, filename));
    fs.copyFileSync(path.join(stage, 'app', 'resource-layout.js'), path.join(resourceRoot, 'app', 'resource-layout.js'));
    assert.strictEqual(require(path.join(resourceRoot, 'app', 'resource-layout.js')).version, 'fixture', 'ASAR外模块必须能从相邻resources/config读取运行清单');
    assert.deepStrictEqual(auditPackage(stage, { publicCatalog, privateCatalog }).errors, []);
    for (const location of avatarLocations) {
        assert(!fs.existsSync(path.join(stage, location)), '公开插件或运行模块中的头像目录也必须排除');
        assert.deepStrictEqual(fs.readFileSync(path.join(root, location, 'fixture.png')), binaryPhoto, '过滤只能排除，不能改动原头像文件');
    }
    for (const filename of ['account-avatar.js', 'account-avatar-store.js']) assert(fs.existsSync(path.join(stage, 'app', filename)), '头像运行源码不能被头像数据目录规则误排除');
    const forbiddenAvatarPaths = ['account-avatar/avatar.json', 'resources/app/account-avatar/photo.png', 'resources/app/software/public-tool/account-avatar/screenshot.png'];
    assert.strictEqual(auditEntries(forbiddenAvatarPaths, { publicCatalog, privateCatalog }).length, forbiddenAvatarPaths.length, 'manifest与二进制照片/截图都按目录拒绝，不依赖文本内容');
    assert.deepStrictEqual(auditEntries(['app/account-avatar.js', 'resources/app/account-avatar-store.js'], { publicCatalog, privateCatalog }), []);
    const archiveSource = path.join(root, 'archive-source'), archivedPayload = path.join(root, 'archive-payload');
    write(path.join(archiveSource, 'account-avatar', 'avatar.json'), { version: 1 });
    fs.writeFileSync(path.join(archiveSource, 'account-avatar', 'photo.png'), binaryPhoto);
    fs.mkdirSync(archivedPayload);
    const archiveCreated = spawnSync(process.execPath, ['-e', "let asar;try{asar=require('@electron/asar')}catch(_){asar=require('asar')}asar.createPackage(process.argv[1],process.argv[2]).catch(()=>process.exit(1));", archiveSource, path.join(archivedPayload, 'fixture.asar')], { cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'ignore' });
    assert.strictEqual(archiveCreated.status, 0, 'ASAR隐私验收fixture必须成功创建');
    assert(auditPackage(archivedPayload, { publicCatalog, privateCatalog }).errors.some(error => error.includes('account-avatar/photo.png')), '实际ASAR中的二进制头像不能通过包范围检查');
    assert(auditEntries(['resources/app/software/evil-unlisted/index.html'], { publicCatalog, privateCatalog }).length);
    assert(auditEntries(['resources/app/python-software/private-python/main.py'], { publicCatalog, privateCatalog }).length);
    assert(auditEntries(['resources/python/python.exe', 'resources/app/plugin-data/account-token.bin'], { publicCatalog, privateCatalog }).length >= 2);
    assert(auditEntries(['resources/bin/python3.14', 'resources/lib/libpython3.14.dylib', 'resources/signing/developer.p12'], { publicCatalog, privateCatalog }).length === 3);
    assert.throws(() => parseSelections(['--include', 'tools:private-tool'], privateCatalog), /--personal/);
    assert.throws(() => parseSelections(['--personal'], privateCatalog), /--include/);
    assert.throws(() => parseSelections(['--personal', '--include', 'tools:..'], privateCatalog), /无效/);
    assert.deepStrictEqual(parseBuildOptions(['--linux', '--x64', '--dir']), { platform: 'linux', architecture: 'x64' });
    assert.deepStrictEqual(parseBuildOptions(['--mac', '--arm64', '--stage-only']), { platform: 'mac', architecture: 'arm64' });
    assert.throws(() => parseBuildOptions(['--win', '--linux']), /一次/);
    assert.throws(() => parseBuildOptions(['--publish', 'always']), /不支持/);
    assert.throws(() => parseBuildOptions(['--win', '--arm64']), /x64/);
    const originalEnvironment = { CI: 'true', USE_HARD_LINKS: 'true', KEEP: 'fixture' };
    const isolatedEnvironment = builderEnvironment(originalEnvironment);
    assert.strictEqual(isolatedEnvironment.USE_HARD_LINKS, 'false');
    assert.strictEqual(isolatedEnvironment.KEEP, 'fixture');
    assert.strictEqual(originalEnvironment.USE_HARD_LINKS, 'true', '构建不得修改父进程或用户环境');
    const personal = parseSelections(['--personal', '--include', 'tools:private-tool,python:private-python'], privateCatalog);
    const personalStage = path.join(root, 'stage-personal');
    createStage({ root, stage: personalStage, personal });
    assert(fs.existsSync(path.join(personalStage, 'app', 'software', 'private-tool', 'plugin.json')));
    assert(auditPackage(personalStage, { publicCatalog, privateCatalog }).errors.length);
    assert.deepStrictEqual(auditPackage(personalStage, { publicCatalog, privateCatalog, personal }).errors, []);
    assert.throws(() => createStage({ root, stage }), /已存在/);
    console.log('Package scope passed: strict plugin allowlist, Python metadata, no real configs/runtime, public/private separation and explicit personal selection');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
