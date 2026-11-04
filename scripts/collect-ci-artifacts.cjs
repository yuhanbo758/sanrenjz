'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { auditPackage, loadCatalog } = require('./audit-public-scope');

function regularFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('产物必须是普通文件');
    return stat;
}

function collectArtifacts(root = path.resolve(__dirname, '..')) {
    const dist = path.join(root, 'dist');
    const entries = fs.readdirSync(dist, { withFileTypes: true });
    if (entries.some(entry => /^personal-(?:stage|package)-/.test(entry.name))) throw new Error('CI 目录包含个人包，停止收集');
    const packages = entries.filter(entry => /^public-package-\d+-\d+$/.test(entry.name));
    // 新检出工作区应只有本次公开构建，禁止猜测旧包或按时间选择。
    if (packages.length !== 1 || !packages[0].isDirectory() || packages[0].isSymbolicLink()) throw new Error('必须存在且仅存在一个公开构建目录');
    const output = path.join(dist, packages[0].name);
    const unpacked = path.join(output, 'win-unpacked');
    const unpackedStat = fs.lstatSync(unpacked);
    if (!unpackedStat.isDirectory() || unpackedStat.isSymbolicLink()) throw new Error('缺少有效的 Windows 解包产物');
    regularFile(path.join(unpacked, '三人聚智.exe'));
    regularFile(path.join(unpacked, 'resources', 'app.asar'));
    const audit = auditPackage(unpacked, {
        publicCatalog: loadCatalog(root, 'public'),
        privateCatalog: loadCatalog(root, 'private'),
        personal: [],
    });
    if (audit.errors.length) throw new Error(`安装包公开范围审计失败：${audit.errors.join('；')}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('非法版本号');
    const filename = `sanrenjz-${pkg.version}-x64.exe`;
    const installers = fs.readdirSync(output).filter(name => /\.exe$/i.test(name));
    if (installers.length !== 1 || installers[0] !== filename) throw new Error('安装包名称或数量与公开 Windows x64 构建不一致');
    const installer = path.join(output, filename);
    const stat = regularFile(installer);
    const bytes = fs.readFileSync(installer);
    if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error('安装包不是 Windows 可执行文件');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const destination = path.join(dist, 'ci-artifacts');
    // 不覆盖已有目录，避免上传前一次运行或本机遗留文件。
    fs.mkdirSync(destination);
    fs.copyFileSync(installer, path.join(destination, filename), fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), `${sha256}  ${filename}\n`, { encoding: 'utf8', flag: 'wx' });
    const commit = process.env.GITHUB_SHA || '';
    const info = {
        version: pkg.version,
        platform: 'win32',
        arch: 'x64',
        filename,
        bytes: stat.size,
        sha256,
        sourceCommit: /^[a-f0-9]{40}$/i.test(commit) ? commit : null,
        auditedEntries: audit.files,
        bundledPython: false,
        personal: false,
        published: false,
    };
    fs.writeFileSync(path.join(destination, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify(info));
    return info;
}

if (require.main === module) {
    try { collectArtifacts(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { collectArtifacts };
