'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCatalog, auditPackage } = require('./audit-public-scope');

const ROOT_FILES = ['main.js', 'index.html', 'search-window.html', 'super-panel.html', 'screenshot-overlay.html', 'log-window.html', 'python-log.html', 'merged-ui.js', 'merged-ui.css', 'custom-super-panel-actions-example.json', 'LICENSE'];
const UNSAFE_NAMES = new Set(['.git', 'node_modules', '__pycache__', 'logs', 'cache', '.cache', 'user-data', 'plugin-data', 'plugin-configs', 'python-plugin-configs', 'dist', 'tests', '.downloads']);
function copyRuntime(source, destination, { plugin = false, configName = 'config.json' } = {}) {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error('打包源包含符号链接，请先移除链接后重试');
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            if (UNSAFE_NAMES.has(entry.toLowerCase()) || entry.startsWith('.') || /(?:\.log|\.tmp|\.bak|\.pyc|\.sqlite(?:3)?|\.db|\.bin|\.enc)$/i.test(entry)) continue;
            if (plugin && (entry === configName || entry === 'config.json')) continue;
            copyRuntime(path.join(source, entry), path.join(destination, entry), { plugin, configName });
        }
    } else fs.copyFileSync(source, destination);
}
function parseSelections(argv, privateCatalog) {
    const index = argv.indexOf('--include');
    const values = index >= 0 ? String(argv[index + 1] || '').split(',').filter(Boolean) : [];
    if (values.length && !argv.includes('--personal')) throw new Error('私有插件必须显式指定--personal --include');
    for (const value of values) {
        const [engine, id, extra] = value.split(':');
        if (extra || !privateCatalog[engine]?.includes(id)) throw new Error(`无效个人插件选择：${value}`);
    }
    if (argv.includes('--personal') && !values.length) throw new Error('个人包必须用--include明确选择插件');
    return [...new Set(values)];
}
function parseBuildOptions(argv) {
    const switches = new Set(['--stage-only', '--dir', '--personal', '--win', '--mac', '--linux', '--x64', '--arm64']);
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] === '--include') {
            if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('--include缺少插件列表');
            index++; continue;
        }
        if (!switches.has(argv[index])) throw new Error(`不支持的本地构建参数：${argv[index]}`);
    }
    const requested = ['win', 'mac', 'linux'].filter(platform => argv.includes(`--${platform}`));
    if (requested.length > 1) throw new Error('一次只能构建一个平台');
    const platform = requested[0] || ({ win32: 'win', darwin: 'mac', linux: 'linux' })[process.platform];
    const architectures = ['x64', 'arm64'].filter(architecture => argv.includes(`--${architecture}`));
    if (!platform || architectures.length > 1) throw new Error('请选择一个受支持的平台与架构');
    const architecture = architectures[0] || (platform === 'mac' && process.arch === 'arm64' ? 'arm64' : 'x64');
    if (platform !== 'mac' && architecture !== 'x64') throw new Error('当前Windows/Linux安装与Python运行时仅支持x64');
    if (platform === 'mac' && process.platform !== 'darwin' && !argv.includes('--stage-only')) throw new Error('macOS本地构建需要在macOS主机上执行');
    return { platform, architecture };
}
function createStage({ root, stage, personal = [] }) {
    if (fs.existsSync(stage)) throw new Error('打包暂存目录已存在，请使用新目录');
    const publicCatalog = loadCatalog(root, 'public');
    const privateCatalog = loadCatalog(root, 'private');
    for (const selected of personal) {
        const [engine, id] = selected.split(':');
        if (!privateCatalog[engine]?.includes(id)) throw new Error(`无效个人插件：${selected}`);
    }
    fs.mkdirSync(stage, { recursive: true });
    for (const name of ROOT_FILES) if (fs.existsSync(path.join(root, name))) copyRuntime(path.join(root, name), path.join(stage, name));
    fs.mkdirSync(path.join(stage, 'app'), { recursive: true });
    for (const entry of fs.readdirSync(path.join(root, 'app'), { withFileTypes: true })) {
        if (entry.isFile() && /\.(js|py)$/.test(entry.name)) copyRuntime(path.join(root, 'app', entry.name), path.join(stage, 'app', entry.name));
    }
    for (const name of ['app/plugin_runtime', 'app/remote', 'app/python-support', 'assets', 'build']) {
        if (fs.existsSync(path.join(root, name))) copyRuntime(path.join(root, name), path.join(stage, name));
    }
    fs.mkdirSync(path.join(stage, 'config'), { recursive: true });
    for (const name of ['public-plugins.json', 'python-runtime.json']) if (fs.existsSync(path.join(root, 'config', name))) copyRuntime(path.join(root, 'config', name), path.join(stage, 'config', name));
    for (const [engine, directory] of Object.entries({ tools: 'software', python: 'python-software' })) {
        const selected = new Set([...(publicCatalog[engine] || []), ...personal.filter(item => item.startsWith(`${engine}:`)).map(item => item.slice(engine.length + 1))]);
        for (const id of selected) {
            if (!/^[a-zA-Z0-9._-]+$/.test(id) || id === '.' || id === '..') throw new Error('白名单包含非法目录名');
            const source = path.join(root, 'app', directory, id);
            const manifest = path.join(source, engine === 'tools' ? 'plugin.json' : 'settings.json');
            if (!fs.existsSync(manifest)) throw new Error(`插件缺少清单：${engine}:${id}`);
            const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            const configName = String(metadata.config_file || 'config.json');
            const destination = path.join(stage, 'app', directory, id);
            copyRuntime(source, destination, { plugin: true, configName });
            // 不从开发机复制真实配置；公开默认模板为空，由插件提供默认值。
            if (engine === 'python') {
                if (path.basename(configName) !== configName || !configName.endsWith('.json')) throw new Error(`非法默认配置名：${engine}:${id}`);
                fs.writeFileSync(path.join(destination, configName), '{}\n', 'utf8');
            }
        }
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    delete pkg.repository; delete pkg.homepage; delete pkg.bugs; delete pkg.scripts;
    pkg.build = { ...pkg.build, publish: null, files: ['*.js', '*.html', '*.css', 'LICENSE', '*.json', 'app/**/*', 'assets/**/*', 'config/**/*', 'build/**/*', 'node_modules/**/*'], extraResources: [{ from: 'app', to: 'app', filter: ['**/*'] }, { from: 'config', to: 'config', filter: ['python-runtime.json', 'public-plugins.json'] }, { from: 'build', to: 'build', filter: ['*.ico', '*.png', '*.icns'] }] };
    if (personal.length) { pkg.build.productName = `${pkg.build.productName}（个人版）`; pkg.build.artifactName = 'sanrenjz-personal-${version}-${os}-${arch}.${ext}'; }
    fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    const audit = auditPackage(stage, { publicCatalog, privateCatalog, personal });
    if (audit.errors.length) throw new Error(`暂存审计失败：${audit.errors.join('；')}`);
    return { stage, files: audit.files, personal };
}
function main(argv = process.argv.slice(2)) {
    const root = path.resolve(__dirname, '..');
    const { platform, architecture } = parseBuildOptions(argv);
    const privateCatalog = loadCatalog(root, 'private');
    const personal = parseSelections(argv, privateCatalog);
    const kind = personal.length ? 'personal' : 'public';
    const stamp = `${Date.now()}-${process.pid}`;
    const stage = path.join(root, 'dist', `${kind}-stage-${stamp}`);
    const result = createStage({ root, stage, personal });
    console.log(JSON.stringify(result));
    if (argv.includes('--stage-only')) return;
    const modules = path.join(root, 'node_modules');
    if (!fs.existsSync(modules)) throw new Error('请先安装项目依赖');
    fs.symlinkSync(modules, path.join(stage, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const cli = path.join(modules, 'electron-builder', 'out', 'cli', 'cli.js');
    const output = path.join(root, 'dist', `${kind}-package-${stamp}`);
    const args = [cli, '--projectDir', stage, '--publish', 'never', `--${platform}`, `--${architecture}`, `--config.directories.output=${output}`];
    if (argv.includes('--dir')) args.push('--dir');
    const child = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    if (child.status !== 0) throw new Error('本地打包失败，暂存目录已保留');
    const unpacked = path.join(output, platform === 'win' ? 'win-unpacked' : platform === 'linux' ? 'linux-unpacked' : architecture === 'arm64' ? 'mac-arm64' : 'mac');
    if (!fs.existsSync(unpacked)) throw new Error('构建完成但没有找到对应平台产物，暂存与日志已保留');
    const audited = auditPackage(unpacked, { publicCatalog: loadCatalog(root, 'public'), privateCatalog, personal });
    if (audited.errors.length) throw new Error(`构建产物审计失败：${audited.errors.join('；')}`);
    console.log(JSON.stringify({ output, files: audited.files, published: false, personal }));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { ROOT_FILES, copyRuntime, parseSelections, parseBuildOptions, createStage };
