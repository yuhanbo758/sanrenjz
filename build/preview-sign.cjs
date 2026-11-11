const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

module.exports = async function signPackage(context) {
    if (context.electronPlatformName !== 'darwin' || (process.env.SANRENJZ_ADHOC_BUILD !== '1' && process.env.SANRENJZ_PREVIEW_BUILD !== '1')) return;
    require('./dmg-detach-retry.cjs').install(context);
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const entitlements = path.join(context.packager.projectDir, 'build', 'entitlements.mac.plist');
    if (!fs.statSync(app).isDirectory() || !fs.statSync(entitlements).isFile()) throw new Error('ad-hoc签名所需资源不完整');
    const nativeFiles = [];
    function findNative(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) findNative(file);
            else if (/\.(node|dylib)$/.test(entry.name) || entry.name === 'mac-dock-helper') nativeFiles.push(file);
        }
    }
    findNative(app);
    // .node位于非标准嵌套位置，先逐项签名，再签外层Framework/helper/app。
    for (const file of nativeFiles) execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', file], { stdio: 'inherit' });
    // 由Apple工具规范化XML，避免AMFI对跨平台文本格式的解析差异。
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-adhoc-sign-'));
    try {
        const normalized = path.join(temporary, 'entitlements.plist');
        execFileSync('plutil', ['-lint', entitlements], { stdio: 'inherit' });
        execFileSync('plutil', ['-convert', 'xml1', '-o', normalized, entitlements], { stdio: 'inherit' });
        console.log(JSON.stringify({ originalEntitlementBytes: fs.statSync(entitlements).size, normalizedEntitlementBytes: fs.statSync(normalized).size }));
        // 仅提供本地完整性用的ad-hoc签名；没有Developer ID身份，也不宣称已公证。
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', normalized, app], { stdio: 'inherit' });
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    for (const file of nativeFiles) execFileSync('codesign', ['--verify', '--strict', file], { stdio: 'inherit' });
    const result = require('child_process').spawnSync('codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' });
    if (result.status !== 0 || !/Signature=adhoc/.test(`${result.stdout}\n${result.stderr}`)) throw new Error('macOS包签名模式不符');
    const arch = typeof context.arch === 'string' ? context.arch : require('builder-util').Arch[context.arch];
    if (!['x64', 'arm64'].includes(arch)) throw new Error('未知macOS架构');
    const output = path.join(context.outDir || path.dirname(context.appOutDir), `preview-signature-${arch}.json`);
    fs.writeFileSync(output, JSON.stringify({ signing: 'ad-hoc', notarized: false, verified: true, arch, nativeCodeFiles: nativeFiles.length }, null, 2));
};
