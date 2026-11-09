const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');
const { replacePluginDirectory } = require('./plugin_store');

function inside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function validateTree(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const full = path.join(root, entry.name);
        if (entry.isSymbolicLink()) throw new Error('插件包不能包含符号链接');
        if (entry.isDirectory() && entry.name !== '.git') validateTree(full);
    }
}

function extractZip(archive, destination) {
    const limit = 512 * 1024 * 1024;
    if (fs.statSync(archive).size > limit) throw new Error('插件压缩包超过 512 MB');
    let total = 0, count = 0;
    const names = new Set();
    const bytes = fs.readFileSync(archive);
    // 在解压分配内存之前检查路径及展开体积，避免路径穿越和压缩炸弹。
    const entries = unzipSync(bytes, { filter(file) {
        const name = file.name.replace(/\\/g, '/');
        if (name.includes('\0') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) throw new Error('ZIP 包含不安全路径');
        const segments = name.split('/');
        if (segments.some((part, index) => (!part && index !== segments.length - 1) || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('ZIP 包含 Windows 不安全文件名');
        const canonical = name.replace(/\/$/, '').toLowerCase();
        if (names.has(canonical)) throw new Error('ZIP 包含重复或大小写冲突路径');
        names.add(canonical);
        if (++count > 20000) throw new Error('插件 ZIP 文件数量超过上限');
        total += file.originalSize;
        if (total > limit) throw new Error('插件解压后超过 512 MB');
        return true;
    } });
    fs.mkdirSync(destination, { recursive: true });
    for (const [name, data] of Object.entries(entries)) {
        const target = path.resolve(destination, name.replace(/\\/g, '/'));
        if (!inside(destination, target)) throw new Error('ZIP 目标路径越界');
        if (name.endsWith('/')) fs.mkdirSync(target, { recursive: true });
        else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); }
    }
}

function findRoots(directory) {
    const roots = [];
    function visit(folder, depth) {
        if (depth > 8) throw new Error('插件包目录层级过深');
        const tools = fs.existsSync(path.join(folder, 'plugin.json'));
        const python = fs.existsSync(path.join(folder, 'settings.json'));
        if (tools && python) throw new Error('同一插件根目录不能同时包含 plugin.json 和 settings.json');
        if (tools || python) { roots.push({ path: folder, engine: tools ? 'tools' : 'python' }); return; }
        const entries = fs.readdirSync(folder, { withFileTypes: true });
        if (entries.some(e => e.isFile() && /\.(py|enc)$/i.test(e.name))) {
            roots.push({ path: folder, engine: 'python' }); return;
        }
        for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') visit(path.join(folder, entry.name), depth + 1);
    }
    visit(directory, 0);
    if (!roots.length) throw new Error('未找到可识别的效率插件或 Python 插件');
    return roots;
}

async function importTools(source, { toolsDir, manager, overwrite = false }) {
    const root = fs.realpathSync(source);
    validateTree(root);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
    if (fs.existsSync(path.join(root, 'settings.json'))) throw new Error('插件清单类型冲突');
    if (!config || typeof config.pluginName !== 'string' || !config.pluginName.trim() || typeof config.main !== 'string') throw new Error('效率插件必须提供名称和 main 入口');
    const main = path.resolve(root, config.main);
    if (!inside(root, main) || !fs.existsSync(main) || !fs.statSync(main).isFile() || !inside(root, fs.realpathSync(main))) throw new Error('插件入口无效或越界');
    if (path.relative(root, main).split(path.sep)[0].toLowerCase() === '.runtime') throw new Error('插件入口不能位于本机 .runtime 运行资料目录');
    const installed = await manager.getPluginList();
    const old = installed.find(p => p.name === config.pluginName);
    const target = old?.path || path.join(toolsDir, path.basename(source));
    if (!inside(toolsDir, target) || path.resolve(target) === path.resolve(toolsDir)) throw new Error('插件目标目录无效');
    if (fs.existsSync(target) && fs.realpathSync(target) === root) return { name: config.pluginName, action: 'unchanged', engine: 'tools' };
    if (inside(root, target) || inside(target, root)) throw new Error('导入源与目标不能互相包含');
    const occupant = installed.find(p => path.resolve(p.path).toLowerCase() === path.resolve(target).toLowerCase());
    if (occupant && occupant.name !== config.pluginName) throw new Error('目标文件夹属于另一个插件，请使用不同文件夹名称');
    if (old && (manager.pluginWindows.has(old.name) || manager.pluginProcesses.has(old.name))) throw new Error('插件正在运行，请关闭后再替换');
    if (fs.existsSync(target) && !overwrite) { const error = new Error(`插件 ${config.pluginName} 已存在`); error.code = 'PLUGIN_EXISTS'; throw error; }
    const update = replacePluginDirectory(root, target, {
        filter: p => !['.git', '.downloads', '__pycache__'].includes(path.basename(p))
    });
    return { name: config.pluginName, path: target, engine: 'tools', action: old ? 'replaced' : 'added', ...update };
}

module.exports = { inside, validateTree, extractZip, findRoots, importTools };
