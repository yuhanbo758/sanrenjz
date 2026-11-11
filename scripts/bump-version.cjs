'use strict';
const fs = require('fs');
const path = require('path');
const { parseReleaseVersion } = require('./preview-version.cjs');

function releaseParts(version) {
    const parsed = parseReleaseVersion(version);
    const parts = version.split('-')[0].split('.').map(Number);
    if (!parts.every(Number.isSafeInteger) || parts[2] > 9) throw new Error('自 0.2.0 起，末位版本号只能为 0 到 9；历史版本须显式迁移');
    return { ...parsed, parts };
}

function nextReleaseVersion(version) {
    const { prerelease, parts: [major, minor, patch] } = releaseParts(version);
    if (prerelease) throw new Error('预发布版本须显式指定，不能自动推导下一个正式版本');
    // 末位到 9 后进位到中间位；不擅自把 0.9.9 推进到 1.0.0。
    const nextMinor = minor + (patch === 9 ? 1 : 0);
    if (!Number.isSafeInteger(nextMinor)) throw new Error('版本号超出安全整数范围');
    return `${major}.${nextMinor}.${patch === 9 ? 0 : patch + 1}`;
}

function main(argv = process.argv.slice(2), root = path.resolve(__dirname, '..')) {
    if (argv.length > 1 || argv.some(value => !['--apply', '--check'].includes(value))) throw new Error('仅支持 --check 或 --apply；默认只预览');
    const files = ['package.json', 'package-lock.json'].map(name => path.join(root, name));
    const original = files.map(file => fs.readFileSync(file, 'utf8'));
    const [pkg, lock] = original.map(text => JSON.parse(text));
    const current = pkg.version;
    releaseParts(current);
    if (lock.version !== current || lock.packages?.['']?.version !== current) throw new Error('package.json 与 package-lock.json 版本不一致，拒绝覆盖');
    if (argv.includes('--check')) return { current, valid: true };
    const next = nextReleaseVersion(current);
    if (argv.includes('--apply')) {
        pkg.version = next;
        lock.version = next;
        lock.packages[''].version = next;
        try {
            [pkg, lock].forEach((value, index) => {
                const newline = original[index].includes('\r\n') ? '\r\n' : '\n';
                fs.writeFileSync(files[index], `${JSON.stringify(value, null, 2)}\n`.replace(/\n/g, newline), 'utf8');
            });
        } catch (error) {
            files.forEach((file, index) => fs.writeFileSync(file, original[index], 'utf8'));
            throw error;
        }
    }
    return { current, next, applied: argv.includes('--apply') };
}

if (require.main === module) {
    try { console.log(JSON.stringify(main())); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { nextReleaseVersion, main };
