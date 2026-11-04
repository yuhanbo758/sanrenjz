'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
let asar;
try { asar = require('@electron/asar'); } catch (_) { asar = require('asar'); }
const { collectArtifacts, parseOptions, expectedNames } = require('../scripts/collect-ci-artifacts.cjs');
const { resolvePackageLayout } = require('../scripts/package-local');
const { auditPackage } = require('../scripts/audit-public-scope');
const roots = [];
let checks = 0;
const check = (value, label) => { assert(value, label); checks++; };
const rejects = (fn, match) => { assert.throws(fn, match); checks++; };
function write(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}
function binary(platform, arch = 'x64') {
    const data = Buffer.alloc(512);
    if (platform === 'win') { data.write('MZ'); data.writeUInt32LE(0x80, 0x3c); data.write('PE\0\0', 0x80, 'binary'); data.writeUInt16LE(0x8664, 0x84); }
    else if (platform === 'mac') { data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
    else { data.write('\x7fELF', 0, 'binary'); data[4] = 2; data[5] = 1; data.writeUInt16LE(62, 18); }
    return data;
}
async function fixture(platform = 'win', arch = 'x64') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-collect-')); roots.push(root);
    const pkg = { name: 'sanrenjz', version: '1.2.3-preview.1', build: { productName: '三人聚智' } };
    write(path.join(root, 'package.json'), pkg);
    write(path.join(root, 'config/public-plugins.json'), { tools: ['public-tool'], python: ['public-python'] });
    write(path.join(root, 'config/private-plugins.json'), { tools: ['private-tool'], python: ['private-python'] });
    const output = path.join(root, 'dist/public-package-1234-5678');
    const unpacked = path.join(output, platform === 'win' ? 'win-unpacked' : platform === 'linux' ? 'linux-unpacked' : arch === 'arm64' ? 'mac-arm64' : 'mac');
    const appRoot = platform === 'mac' ? path.join(unpacked, '三人聚智.app') : unpacked;
    const resources = path.join(appRoot, platform === 'mac' ? 'Contents/Resources' : 'resources');
    const executable = path.join(appRoot, platform === 'mac' ? 'Contents/MacOS/三人聚智' : platform === 'win' ? '三人聚智.exe' : 'sanrenjz');
    write(executable, binary(platform, arch));
    const source = path.join(root, 'archive-source'); write(path.join(source, 'package.json'), { name: 'sanrenjz', version: pkg.version, dependencies: {} });
    fs.mkdirSync(resources, { recursive: true }); await asar.createPackage(source, path.join(resources, 'app.asar'));
    write(path.join(resources, 'config/public-plugins.json'), { tools: ['public-tool'], python: ['public-python'] });
    write(path.join(resources, 'config/python-runtime.json'), { version: 'fixture' });
    write(path.join(resources, 'app/software/public-tool/plugin.json'), { name: 'fixture' });
    write(path.join(resources, 'app/python-software/public-python/settings.json'), { main_file: 'main.py', config_file: 'config.json' });
    write(path.join(resources, 'app/python-software/public-python/config.json'), {});
    for (const name of expectedNames(pkg, platform, arch)) {
        const data = Buffer.alloc(512);
        if (name.endsWith('.exe') || name.endsWith('.AppImage')) binary(platform, arch).copy(data);
        else if (name.endsWith('.dmg')) data.write('koly');
        else if (name.endsWith('.zip')) data.writeUInt32LE(0x04034b50);
        else { data[0] = 0x1f; data[1] = 0x8b; data[2] = 8; }
        write(path.join(output, name), data);
    }
    const report = { schemaVersion: 1, target: `${platform}-${arch}`, platform: { win: 'win32', mac: 'darwin', linux: 'linux' }[platform], arch, version: pkg.version, sourceCommit: /^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null, success: true, exitCode: 0, errors: [], assertions: ['isolated runtime fixture'], bundledPython: false };
    write(path.join(root, `dist/packaged-runtime-${platform}-${arch}.json`), report);
    if (platform === 'mac') write(path.join(output, `preview-signature-${arch}.json`), { signing: 'ad-hoc', notarized: false, verified: true, arch });
    return { root, output, unpacked, resources, executable, pkg, report, options: { platform, arch } };
}
(async () => {
    const log = console.log; console.log = () => {};
    try {
        for (const [platform, arch] of [['win', 'x64'], ['mac', 'x64'], ['mac', 'arm64'], ['linux', 'x64']]) {
            const f = await fixture(platform, arch);
            const result = collectArtifacts(f.root, f.options);
            check(result.platform === f.report.platform && result.arch === arch, '平台和架构必须匹配');
            check(result.files.length === (platform === 'win' ? 1 : 2), '必须完整收集平台安装包');
            check(fs.readdirSync(path.join(f.root, 'dist/ci-artifacts')).length === result.files.length + 2, '只收集安装包与两份元数据');
            check(!JSON.stringify(result).includes(f.root) && !JSON.stringify(result).includes('archive-source'), '元数据不得包含本地路径');
            for (const item of result.files) check(item.sha256 === crypto.createHash('sha256').update(fs.readFileSync(path.join(f.output, item.filename))).digest('hex'), 'SHA256必须来自实际安装包');
            check(resolvePackageLayout(f.output, f.options, f.pkg).executable === f.executable, '布局必须定位正确原生程序');
            rejects(() => collectArtifacts(f.root, f.options), /EEXIST/);
        }
        let f = await fixture(); fs.mkdirSync(path.join(f.root, 'dist/public-package-2222-3333')); rejects(() => collectArtifacts(f.root), /仅存在一个/);
        f = await fixture(); fs.mkdirSync(path.join(f.root, 'dist/personal-stage-1234-7777')); rejects(() => collectArtifacts(f.root), /个人包/);
        f = await fixture(); write(path.join(f.output, 'unexpected.exe'), binary('win')); rejects(() => collectArtifacts(f.root), /名称或数量/);
        f = await fixture(); write(path.join(f.output, expectedNames(f.pkg, 'win', 'x64')[0]), Buffer.alloc(0)); rejects(() => collectArtifacts(f.root), /非空/);
        f = await fixture(); fs.rmSync(path.join(f.resources, 'app.asar')); rejects(() => collectArtifacts(f.root), /ENOENT/);
        f = await fixture(); write(path.join(f.resources, 'app/software/private-tool/main.js'), 'fixture'); rejects(() => collectArtifacts(f.root), /公开范围/);
        f = await fixture(); write(path.join(f.resources, 'runtime/python/python.exe'), 'fixture'); rejects(() => collectArtifacts(f.root), /公开范围/);
        f = await fixture(); write(path.join(f.root, 'dist/packaged-runtime-win-x64.json'), { ...f.report, sourceCommit: 'f'.repeat(40) }); rejects(() => collectArtifacts(f.root), /原生运行验收/);
        f = await fixture(); write(path.join(f.root, 'dist/packaged-runtime-win-x64.json'), { ...f.report, assertions: [] }); rejects(() => collectArtifacts(f.root), /原生运行验收/);
        f = await fixture('mac', 'arm64'); write(f.executable, binary('mac', 'x64')); rejects(() => collectArtifacts(f.root, f.options), /平台或架构/);
        f = await fixture('mac', 'x64'); write(path.join(f.output, 'preview-signature-x64.json'), { signing: 'Developer ID', notarized: false }); rejects(() => collectArtifacts(f.root, f.options), /签名报告/);
        rejects(() => parseOptions(['--platform', 'linux', '--arch', 'arm64']), /不支持/);
        rejects(() => parseOptions(['--include', 'private']), /无效/);
        f = await fixture('mac', 'x64');
        const framework = path.join(f.unpacked, '三人聚智.app/Contents/Frameworks/Electron Framework.framework/Versions');
        write(path.join(framework, 'A/Resources/Info.plist'), 'fixture');
        try {
            fs.symlinkSync(path.join(framework, 'A'), path.join(framework, 'Current'), process.platform === 'win32' ? 'junction' : 'dir');
            check(auditPackage(f.unpacked, { publicCatalog: { tools: ['public-tool'], python: ['public-python'] }, privateCatalog: { tools: ['private-tool'], python: ['private-python'] } }).errors.length === 0, '合法内部Framework链接必须通过');
            fs.symlinkSync(f.root, path.join(f.unpacked, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
            rejects(() => auditPackage(f.unpacked, { publicCatalog: { tools: [], python: [] }, privateCatalog: { tools: [], python: [] } }), /外部/);
        } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
        f = await fixture('mac', 'x64');
        try {
            fs.symlinkSync(f.unpacked, path.join(f.unpacked, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
            rejects(() => auditPackage(f.unpacked, { publicCatalog: { tools: [], python: [] }, privateCatalog: { tools: [], python: [] } }), /循环/);
        } catch (error) { if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error; }
    } finally {
        console.log = log;
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(`CI artifacts passed: ${checks} assertions across Windows, macOS x64/arm64, Linux, privacy, architecture, runtime gate and checksums`);
})().catch(error => { console.error(error); process.exitCode = 1; });
