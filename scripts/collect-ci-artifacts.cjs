'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { auditPackage, loadCatalog } = require('./audit-public-scope');
const { resolvePackageLayout } = require('./package-local');

const NATIVE_PLATFORMS = { win: 'win32', mac: 'darwin', linux: 'linux' };
function regularFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error('产物必须是非空普通文件');
    return stat;
}
function parseOptions(argv) {
    const options = { platform: 'win', arch: 'x64', requireSmoke: true };
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === '--require-smoke') continue;
        if (!['--platform', '--arch'].includes(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('无效的产物收集参数');
        options[argv[index].slice(2)] = argv[++index];
    }
    if (!NATIVE_PLATFORMS[options.platform] || !['x64', 'arm64'].includes(options.arch) || (options.platform !== 'mac' && options.arch !== 'x64')) throw new Error('不支持的构建平台或架构');
    return options;
}
function expectedNames(pkg, platform, arch) {
    const base = `sanrenjz-${pkg.version}-${platform}-${arch}`;
    return platform === 'win' ? [`${base}.exe`] : platform === 'mac' ? [`${base}.dmg`, `${base}.zip`] : [`${base}.AppImage`, `${base}.tar.gz`];
}
function validateBinary(file, platform, arch) {
    regularFile(file);
    const data = fs.readFileSync(file);
    let valid = false;
    if (platform === 'win' && data.length >= 64 && data.toString('ascii', 0, 2) === 'MZ') {
        const pe = data.readUInt32LE(0x3c);
        valid = pe + 6 <= data.length && data.toString('binary', pe, pe + 4) === 'PE\x00\x00' && data.readUInt16LE(pe + 4) === 0x8664;
    } else if (platform === 'mac' && data.length >= 8) {
        valid = data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === (arch === 'arm64' ? 0x0100000c : 0x01000007);
    } else if (platform === 'linux' && data.length >= 20) {
        valid = data.toString('binary', 0, 4) === '\x7fELF' && data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === 62;
    }
    if (!valid) throw new Error(`原生二进制平台或架构不符：${path.basename(file)}`);
}
function validateInstaller(file, platform) {
    const data = fs.readFileSync(file);
    let valid;
    if (file.endsWith('.exe')) valid = data.length >= 2 && data.toString('ascii', 0, 2) === 'MZ';
    else if (file.endsWith('.dmg')) valid = data.length >= 512 && data.toString('ascii', data.length - 512, data.length - 508) === 'koly';
    else if (file.endsWith('.zip')) valid = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
    else if (file.endsWith('.AppImage')) { validateBinary(file, platform, 'x64'); valid = true; }
    else if (file.endsWith('.tar.gz')) valid = data.length >= 3 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 8;
    if (!valid) throw new Error(`安装包格式与扩展名不符：${path.basename(file)}`);
}
function collectArtifacts(root = path.resolve(__dirname, '..'), input = {}) {
    const options = { platform: 'win', arch: 'x64', ...input };
    const { platform, arch } = parseOptions(['--platform', options.platform, '--arch', options.arch]);
    const dist = path.join(root, 'dist');
    const entries = fs.readdirSync(dist, { withFileTypes: true });
    if (entries.some(entry => /^personal-(?:stage|package)-/.test(entry.name))) throw new Error('CI 目录包含个人包，停止收集');
    const packages = entries.filter(entry => /^public-package-\d+-\d+$/.test(entry.name));
    // 每个平台任务必须是新检出工作区，不能按时间猜测应上传哪个旧包。
    if (packages.length !== 1 || !packages[0].isDirectory() || packages[0].isSymbolicLink()) throw new Error('必须存在且仅存在一个公开构建目录');
    const output = path.join(dist, packages[0].name);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('非法版本号');
    const layout = resolvePackageLayout(output, { platform, arch }, pkg);
    regularFile(path.join(layout.resources, 'app.asar'));
    validateBinary(layout.binary, platform, arch);
    const audit = auditPackage(layout.unpacked, {
        publicCatalog: loadCatalog(root, 'public'), privateCatalog: loadCatalog(root, 'private'), personal: [],
    });
    if (audit.errors.length) throw new Error(`安装包公开范围审计失败：${audit.errors.join('；')}`);
    const sqlite = path.join(layout.resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
    if (fs.existsSync(sqlite)) validateBinary(sqlite, platform, arch);
    const target = `${platform}-${arch}`;
    const commit = process.env.GITHUB_SHA || '';
    const sourceCommit = /^[a-f0-9]{40}$/i.test(commit) ? commit : null;
    const report = JSON.parse(fs.readFileSync(path.join(dist, `packaged-runtime-${target}.json`), 'utf8'));
    if (report.schemaVersion !== 1 || report.success !== true || report.exitCode !== 0 || report.errors?.length !== 0 || !Array.isArray(report.assertions) || report.assertions.length === 0 || report.bundledPython !== false || report.version !== pkg.version || report.target !== target || report.platform !== NATIVE_PLATFORMS[platform] || report.arch !== arch || report.sourceCommit !== sourceCommit || (process.env.GITHUB_ACTIONS === 'true' && !sourceCommit)) throw new Error('本次对应平台的原生运行验收未通过');
    let signing = platform === 'win' ? 'unsigned' : 'none';
    if (platform === 'mac') {
        const signature = JSON.parse(fs.readFileSync(path.join(output, `preview-signature-${arch}.json`), 'utf8'));
        if (signature.signing !== 'ad-hoc' || signature.notarized !== false || signature.verified !== true || signature.arch !== arch) throw new Error('macOS预览签名报告不符');
        signing = 'ad-hoc';
    }
    const expected = expectedNames(pkg, platform, arch);
    const installers = fs.readdirSync(output).filter(name => /\.(?:exe|dmg|zip|AppImage|tar\.gz)$/i.test(name)).sort();
    if (JSON.stringify(installers) !== JSON.stringify([...expected].sort())) throw new Error('安装包名称或数量与对应平台构建不一致');
    const files = expected.map(filename => {
        const file = path.join(output, filename);
        const stat = regularFile(file);
        validateInstaller(file, platform);
        return { filename, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    });
    const destination = path.join(dist, 'ci-artifacts');
    fs.mkdirSync(destination);
    for (const file of files) fs.copyFileSync(path.join(output, file.filename), path.join(destination, file.filename), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.filename}\n`).join(''), { encoding: 'utf8', flag: 'wx' });
    const info = {
        schemaVersion: 1, target, version: pkg.version, platform: NATIVE_PLATFORMS[platform], arch, files,
        sourceCommit, auditedEntries: audit.files, bundledPython: false, personal: false, published: false,
        signing, notarized: false, runtimeVerified: true, runtimeAssertions: report.assertions.length,
    };
    if (files.length === 1) Object.assign(info, files[0]);
    fs.writeFileSync(path.join(destination, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify(info));
    return info;
}
if (require.main === module) {
    try { collectArtifacts(path.resolve(__dirname, '..'), parseOptions(process.argv.slice(2))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { collectArtifacts, parseOptions, expectedNames, validateBinary };
