const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { once } = require('events');
const PluginManager = require('../app/software_manager');
const root = process.argv[2];
if (!root || !fs.statSync(root).isDirectory() || !path.basename(root).startsWith('sanrenjz-dock-electron-')) throw new Error('缺少父进程测试目录');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, win) => {
    win.show = () => {}; win.focus = () => {}; win.showInactive = () => {};
});
const waitFor = async predicate => {
    const deadline = Date.now() + 7000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('等待 Dock 集成超时');
        await new Promise(resolve => setTimeout(resolve, 40));
    }
};

app.whenReady().then(async () => {
    const children = [];
    let manager, failed = false;
    try {
        const host = new BrowserWindow({ show: false });
        manager = new PluginManager(host);
        ipcMain.handle('get-plugin-pin-status-window', (_event, name) => manager.getPluginPinStatus(name));
        manager.pluginDir = path.join(root, 'plugins');
        const originalSpawn = manager.macDock.spawnProcess;
        manager.macDock.spawnProcess = (...args) => {
            const child = originalSpawn(...args); children.push(child); return child;
        };
        for (const [folder, name, autoSeparate] of [['a', '测试插件甲', false], ['b', '测试插件乙', true]]) {
            const directory = path.join(manager.pluginDir, folder); fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ pluginName: name, main: 'index.html' }));
            fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><body>隔离空插件</body>');
            fs.copyFileSync(path.resolve(__dirname, '../app/software/sanrenjz-tools-text/logo.png'), path.join(directory, 'logo.png'));
            fs.writeFileSync(manager.getPluginStoragePath(name), JSON.stringify({ autoSeparate }));
            assert.equal((await manager.runPlugin(directory)).success, true);
        }
        assert.equal(manager.macDock.entries.size, 1);
        assert.equal(manager.togglePluginPin('测试插件甲'), true);
        assert.equal(manager.macDock.entries.size, 2);
        assert.equal(manager.togglePluginPin('测试插件甲'), false);
        assert.equal(manager.macDock.entries.size, 1);
        await waitFor(() => children[1].exitCode === 0);
        manager.stopPlugin('测试插件乙');
        assert.equal(manager.macDock.entries.size, 0);
        await waitFor(() => children[0].exitCode === 0);
        console.log('MAC_DOCK_ELECTRON_OK');
    } catch (error) { console.error(error); failed = true; }
    finally {
        const exits = children.filter(child => child.exitCode === null).map(child => once(child, 'close'));
        manager?.stopAllPlugins();
        await Promise.all(exits);
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
        app.exit(failed ? 1 : 0);
    }
}).catch(error => { console.error(error); app.exit(1); });
