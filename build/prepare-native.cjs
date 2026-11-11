const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function buildDockHelper(root, architecture = process.arch) {
    if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(architecture) || architecture !== process.arch) throw new Error('Dock helper 需要对应架构的原生 macOS 构建环境');
    const output = path.join(root, 'app', 'native', 'mac-dock-helper');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    execFileSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-arch', architecture === 'x64' ? 'x86_64' : architecture,
        '-mmacosx-version-min=11.0', '-framework', 'Cocoa', path.join(root, 'build', 'mac-dock-helper.m'), '-o', output], { stdio: 'inherit' });
    execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', output], { stdio: 'inherit' });
    return output;
}

module.exports = async function beforePack(context) {
    if (context.electronPlatformName !== 'darwin') return;
    const architecture = typeof context.arch === 'string' ? context.arch : require('builder-util').Arch[context.arch];
    buildDockHelper(context.packager.projectDir, architecture);
};
module.exports.buildDockHelper = buildDockHelper;
if (require.main === module) buildDockHelper(path.resolve(__dirname, '..'), process.argv[2] || process.arch);
