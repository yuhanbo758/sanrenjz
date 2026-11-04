const fs = require('fs');
const path = require('path');

// 只缓存插件清单和图标位置，不缓存用户存储；动态功能在返回列表时实时合并。
class PluginCatalog {
    constructor(directory, { ttl = 5000 } = {}) {
        this.directory = directory;
        this.ttl = ttl;
        this.manifests = new Map();
        this.entries = null;
        this.expiresAt = 0;
        this.loading = null;
    }

    async read(force = false) {
        if (this.loading) {
            await this.loading;
            return force ? this.read(true) : this.entries;
        }
        if (!force && this.entries && Date.now() < this.expiresAt) return this.entries;
        this.expiresAt = 0;
        const loading = this.scan(force);
        this.loading = loading;
        try {
            return await loading;
        } finally {
            if (this.loading === loading) this.loading = null;
        }
    }

    async scan(force) {
        const folders = await fs.promises.readdir(this.directory, { withFileTypes: true });
        const next = new Map();
        const entries = await Promise.all(folders.filter(item => item.isDirectory() && !item.name.startsWith('.')).map(async item => {
            const pluginPath = path.join(this.directory, item.name);
            const manifestPath = path.join(pluginPath, 'plugin.json');
            try {
                const stat = await fs.promises.stat(manifestPath);
                const signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
                const cached = this.manifests.get(manifestPath);
                const config = !force && cached?.signature === signature
                    ? cached.config
                    : JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
                if (!config || typeof config !== 'object' || Array.isArray(config) ||
                    (config.pluginName !== undefined && typeof config.pluginName !== 'string')) {
                    throw new Error('插件清单必须是对象，插件名称必须是文本');
                }
                next.set(manifestPath, { signature, config });
                let iconPath = '';
                for (const name of ['logo.ico', 'logo.png']) {
                    const candidate = path.join(pluginPath, name);
                    try {
                        await fs.promises.access(candidate, fs.constants.R_OK);
                        iconPath = candidate;
                        break;
                    } catch (_) { }
                }
                return { path: pluginPath, folder: item.name, config, iconPath };
            } catch (error) {
                if (error.code !== 'ENOENT') console.warn(`读取插件清单失败 ${item.name}:`, error.message);
                return null;
            }
        }));
        this.manifests = next;
        this.entries = entries.filter(Boolean);
        this.expiresAt = Date.now() + this.ttl;
        return this.entries;
    }
}

module.exports = { PluginCatalog };
