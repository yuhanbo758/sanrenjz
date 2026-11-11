const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const removing = new Set();
function markerPath(root, key) {
    return path.join(root, '.uninstalled', crypto.createHash('sha256').update(key).digest('hex'));
}

function isUninstalled(root, key) {
    return fs.existsSync(markerPath(root, key));
}

function assertPluginAvailable(target) {
    const resolved = path.resolve(target);
    for (const directory of removing) {
        const relative = path.relative(directory, resolved);
        if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
            throw new Error('插件正在卸载，请稍后重试');
        }
    }
}

async function removePluginPath(root, target, key, { recursive = true } = {}) {
    root = path.resolve(root);
    target = path.resolve(target);
    // 只允许删除实际插件根的直接子项，拒绝目录联接和相似路径前缀。
    if (path.dirname(target) !== root || fs.lstatSync(target).isSymbolicLink() ||
        path.dirname(fs.realpathSync(target)) !== fs.realpathSync(root)) {
        throw new Error('不能卸载插件目录外的文件或链接');
    }
    assertPluginAvailable(target);
    removing.add(target);
    try {
        const marker = markerPath(root, key);
        const directory = path.dirname(marker);
        fs.mkdirSync(directory, { recursive: true });
        if (fs.lstatSync(directory).isSymbolicLink() || path.dirname(fs.realpathSync(directory)) !== fs.realpathSync(root)) {
            throw new Error('卸载记录目录不能是外部链接');
        }
        // 先记录用户卸载意图，写入失败则不删文件；部分删除失败时也防止启动补齐旧包。
        if (!fs.existsSync(marker)) fs.writeFileSync(marker, '', { flag: 'wx' });
        await fs.promises.rm(target, { recursive, force: false, maxRetries: 2, retryDelay: 100 });
    } finally {
        removing.delete(target);
    }
}

module.exports = { isUninstalled, removePluginPath, assertPluginAvailable };
