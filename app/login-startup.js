function getLoginItemOptions(app, executable = process.execPath) {
    // 开发版与安装版共用用户设置；不能把开发用裸 Electron 写入系统启动项。
    if (!app.isPackaged) return null;
    return { path: executable, args: [] };
}

module.exports = { getLoginItemOptions };
