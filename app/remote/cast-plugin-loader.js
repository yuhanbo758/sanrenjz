'use strict';
const fs = require('fs'), path = require('path');
const FOLDER = 'sanrenjz-tools-cast-receiver';
const MISSING = '电脑未安装兼容的媒体投放接收器，请先安装或更新此插件';
const CHANNELS = ['cast-receiver-status', 'cast-receiver-configure', 'cast-receiver-control', 'cast-receiver-enqueue', 'cast-mirror-status', 'cast-mirror-stop', 'cast-mirror-input'];

// 宿主只负责可选插件发现和已配对连接；播放、镜像及业务接口由插件提供。
class CastPluginLoader {
  constructor(remote) {
    this.remote = remote; this.instance = null; this.pending = null; this.closed = false;
    for (const channel of CHANNELS) remote.ipcMain.handle(channel, async (event, params) => {
      if (event.sender !== remote.manager.pluginWindows.get('媒体投放接收器')?.webContents) throw new Error('接收窗口身份无效');
      const instance = await this.refresh();
      if (!instance) throw new Error(MISSING);
      return instance.desktop(channel, params);
    });
    this.refresh().catch(error => console.warn('可选投放插件加载失败:', error.message));
    try { this.watcher = fs.watch(remote.manager.pluginDir, { persistent: false }, () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh().catch(error => console.warn('投放插件刷新失败:', error.message)), 250);
    }); this.watcher.on('error', () => {}); } catch (_) {}
  }
  refresh() {
    if (this.closed) return Promise.resolve(null);
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }
  async load() {
    let directory = this.directory || path.join(this.remote.manager.pluginDir, FOLDER);
    let manifest;
    try {
      if ((await fs.promises.lstat(directory)).isSymbolicLink()) throw new Error('不支持链接插件目录');
      manifest = JSON.parse(await fs.promises.readFile(path.join(directory, 'plugin.json'), 'utf8'));
      await fs.promises.access(path.join(directory, 'host.js'));
    } catch (error) {
      this.unload();
      if (error.code === 'ENOENT') {
        manifest = null;
        // 小店或本地导入可能使用中文目录名，按清单身份发现实际安装目录。
        const entries = await fs.promises.readdir(this.remote.manager.pluginDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          const candidate = path.join(this.remote.manager.pluginDir, entry.name);
          try {
            const config = JSON.parse(await fs.promises.readFile(path.join(candidate, 'plugin.json'), 'utf8'));
            await fs.promises.access(path.join(candidate, 'host.js'));
            if (config.pluginName !== '媒体投放接收器') continue;
            directory = candidate; manifest = config; break;
          } catch (_) {}
        }
        if (!manifest) return null;
      } else throw error;
    }
    if (manifest.pluginName !== '媒体投放接收器') { this.unload(); throw new Error('投放插件身份不匹配'); }
    if (this.closed) return null;
    if (!this.instance) { this.directory = directory; this.instance = require(path.join(directory, 'host.js')).attach(this.remote); }
    return this.instance;
  }
  async request(method, params) {
    const instance = await this.refresh();
    if (!instance) {
      if (method === 'cast-status') return { installed: false, running: false, error: MISSING };
      if (method === 'mirror-status') return { installed: false, active: false, control: false };
      throw new Error(MISSING);
    }
    return instance.request(method, params);
  }
  unload() { this.instance?.dispose(); this.instance = null; this.directory = null; }
  close() {
    this.closed = true; clearTimeout(this.timer); this.watcher?.close(); this.unload();
    for (const channel of CHANNELS) this.remote.ipcMain.removeHandler(channel);
  }
}
module.exports = { CastPluginLoader, MISSING };
