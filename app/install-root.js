const path = require('path');

function getInstalledAppRoot(app, { platform = process.platform, env = process.env, executable = process.execPath, developmentRoot = path.resolve(__dirname, '..') } = {}) {
    if (!app.isPackaged) return developmentRoot;
    // macOS签名包与AppImage挂载目录不可写，用户插件必须放在独立的可写数据目录。
    if (platform !== 'win32') return app.getPath('userData');
    return env.PORTABLE_EXECUTABLE_DIR || path.dirname(executable);
}

module.exports = { getInstalledAppRoot };
