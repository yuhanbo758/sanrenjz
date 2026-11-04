'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE_DIRS = { tools: 'software', python: 'python-software' };
function loadCatalog(root, name) {
    return JSON.parse(fs.readFileSync(path.join(root, 'config', `${name}-plugins.json`), 'utf8'));
}
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function walk(directory, prefix = '', boundary = directory) {
    if (!fs.existsSync(directory)) return [];
    const realBoundary = fs.realpathSync(boundary);
    const output = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
            let target;
            try { target = fs.realpathSync(absolute); }
            catch (_) { throw new Error(`包中包含悬空或循环链接：${relative}`); }
            if (!inside(realBoundary, target)) throw new Error(`包中链接指向外部目录：${relative}`);
            // macOS Framework 的 Current/Resources 链接合法；只审计链接，不跟随递归。
            if (fs.statSync(target).isDirectory() && inside(target, fs.realpathSync(directory))) throw new Error(`包中链接形成目录循环：${relative}`);
            output.push(relative);
            continue;
        }
        if (entry.name === 'node_modules') continue;
        if (entry.isDirectory()) output.push(...walk(absolute, relative, realBoundary));
        else output.push(relative);
    }
    return output;
}
function auditEntries(entries, { publicCatalog, privateCatalog, personal = [] }) {
    const errors = [];
    const allowed = {};
    for (const engine of Object.keys(ENGINE_DIRS)) allowed[engine] = new Set(publicCatalog[engine] || []);
    for (const selection of personal) {
        const [engine, id] = selection.split(':');
        if (!allowed[engine] || !(privateCatalog[engine] || []).includes(id)) throw new Error(`无效个人插件：${selection}`);
        allowed[engine].add(id);
    }
    for (const input of entries) {
        const name = input.replace(/\\/g, '/').replace(/^\/+/, '');
        if (/(^|\/)(?:\.git|tests|logs|plugin-data|plugin-configs|python-plugin-configs|user-data|__pycache__)(\/|$)/i.test(name) ||
            /(^|\/)(?:account-token\.bin|Cookies|Login Data|\.env(?:\..*)?|.*-secrets\.bin)$/i.test(name) || /\.(?:pem|key|pfx|p12|keystore|jks)$/i.test(name)) errors.push(`用户或开发数据：${name}`);
        if (/(^|\/)(?:runtime|python)(\/|$)/i.test(name) || /(^|\/)python(?:w|\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(name) || /(^|\/)(?:lib)?python\d+(?:\.\d+)*(?:[a-z]*)?\.(?:dll|dylib|so(?:\.\d+)*)$/i.test(name)) errors.push(`预装Python运行时：${name}`);
        for (const [engine, directory] of Object.entries(ENGINE_DIRS)) {
            const pattern = new RegExp(`(?:^|/)app/${directory}/([^/]+)(?:/|$)`);
            const match = name.match(pattern);
            if (match && !allowed[engine].has(match[1])) errors.push(`未列入白名单的插件：${engine}:${match[1]}`);
            for (const id of privateCatalog[engine] || []) {
                if (name.split('/').includes(id) && !personal.includes(`${engine}:${id}`)) errors.push(`私有插件：${engine}:${id}`);
            }
        }
    }
    return [...new Set(errors)];
}
function auditGit(root, publicCatalog, privateCatalog) {
    const errors = [];
    const probe = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
    const initialized = probe.status === 0 && path.resolve(probe.stdout.trim()).toLowerCase() === path.resolve(root).toLowerCase();
    const ignore = fs.existsSync(path.join(root, '.gitignore')) ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8') : '';
    for (const [engine, directory] of Object.entries(ENGINE_DIRS)) {
        for (const id of privateCatalog[engine] || []) {
            const relative = `app/${directory}/${id}`;
            if (initialized) {
                const ignored = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', relative], { windowsHide: true });
                if (ignored.status !== 0) errors.push(`私有插件没有Git忽略：${engine}:${id}`);
                const tracked = spawnSync('git', ['-C', root, 'ls-files', '--', relative], { encoding: 'utf8', windowsHide: true });
                if (tracked.stdout.trim()) errors.push(`私有插件已被Git跟踪：${engine}:${id}`);
            } else if (!ignore.split(/\r?\n/).some(line => line.trim().replace(/^\//, '').replace(/\/$/, '') === relative)) {
                errors.push(`私有插件没有明确Git忽略：${engine}:${id}`);
            }
        }
    }
    for (const id of publicCatalog.python || []) {
        const relative = `app/python-software/${id}/settings.json`;
        if (!fs.existsSync(path.join(root, relative))) errors.push(`公开Python插件缺少settings.json：${id}`);
        if (initialized && spawnSync('git', ['-C', root, 'check-ignore', '--no-index', relative], { windowsHide: true }).status === 0) errors.push(`公开Python清单被Git忽略：${id}`);
    }
    if (!initialized && ignore.split(/\r?\n/).some(line => line.trim() === 'settings.json')) errors.push('未锚定的settings.json忽略会排除公开Python清单');
    return { initialized, errors };
}
function auditPackage(target, options) {
    const entries = walk(target);
    const archives = entries.filter(name => name.endsWith('.asar'));
    const dependencyErrors = [];
    for (const name of archives) {
        let asar;
        try { asar = require('@electron/asar'); } catch (_) { asar = require('asar'); }
        const archive = path.join(target, name);
        const archived = asar.listPackage(archive).map(item => item.replace(/\\/g, '/').replace(/^\/+/, ''));
        entries.push(...archived);
        if (path.basename(name) === 'app.asar') {
            const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
            for (const dependency of Object.keys(pkg.dependencies || {})) {
                const metadata = `node_modules/${dependency}/package.json`;
                if (!archived.includes(metadata) && !fs.existsSync(path.join(path.dirname(archive), metadata))) dependencyErrors.push(`构建产物缺少生产依赖：${dependency}`);
            }
            if (pkg.dependencies?.['better-sqlite3'] && !fs.existsSync(path.join(`${archive}.unpacked`, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))) dependencyErrors.push('SQLite原生模块未解包');
            for (const metadata of ['python-runtime.json', 'public-plugins.json']) {
                if (!fs.existsSync(path.join(path.dirname(archive), 'config', metadata))) dependencyErrors.push(`ASAR外运行模块缺少配置资源：config/${metadata}`);
            }
        }
    }
    return { files: entries.length, errors: [...auditEntries(entries, options), ...dependencyErrors] };
}
function main(argv = process.argv.slice(2)) {
    const root = path.resolve(__dirname, '..');
    const targetIndex = argv.indexOf('--target');
    const publicCatalog = loadCatalog(root, 'public');
    const privateCatalog = loadCatalog(root, 'private');
    const includeIndex = argv.indexOf('--include');
    const personal = includeIndex >= 0 ? String(argv[includeIndex + 1] || '').split(',').filter(Boolean) : [];
    if (personal.length && !argv.includes('--personal')) throw new Error('审计个人包必须同时指定--personal和--include');
    const git = auditGit(root, publicCatalog, privateCatalog);
    const result = targetIndex >= 0 ? auditPackage(path.resolve(argv[targetIndex + 1]), { publicCatalog, privateCatalog, personal }) : { files: 0, errors: [] };
    result.errors.push(...git.errors);
    console.log(JSON.stringify({ ...result, gitInitialized: git.initialized }, null, 2));
    if (result.errors.length) process.exitCode = 1;
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { ENGINE_DIRS, loadCatalog, walk, auditEntries, auditGit, auditPackage };
