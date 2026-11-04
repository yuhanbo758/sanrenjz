'use strict';

/**
 * 判断插件页面当前是否仍处于加载阶段。
 *
 * Electron 版本不同，WebContents 暴露的加载状态方法可能不同，因此先使用
 * isLoadingMainFrame，缺失时再回退到 isLoading。已加载完成的复用窗口会直接
 * 返回 false，避免等待一个不会再次出现的 dom-ready 事件。
 *
 * @param {Electron.WebContents|object} webContents 插件窗口的 WebContents。
 * @returns {boolean} 是否仍需等待页面就绪。
 */
function isWebContentsLoading(webContents) {
    if (typeof webContents?.isLoadingMainFrame === 'function') {
        return webContents.isLoadingMainFrame();
    }
    if (typeof webContents?.isLoading === 'function') {
        return webContents.isLoading();
    }
    return false;
}

/**
 * 等待新建插件窗口完成 DOM 初始化；对于已经打开的插件窗口立即返回。
 *
 * 监听注册后会再次检查加载状态，用于封闭“第一次检查仍在加载、但监听注册前
 * 已经完成”的竞态窗口。超时和主框架加载失败都会显式报错，避免总指挥派发
 * 永久悬挂。
 *
 * @param {Electron.WebContents|object} webContents 插件窗口的 WebContents。
 * @param {number} timeoutMs 最长等待时间，默认 10 秒。
 * @returns {Promise<{waited: boolean}>} 是否实际等待过 dom-ready。
 */
function waitForPluginWindowReady(webContents, timeoutMs = 10000) {
    if (!webContents) {
        return Promise.reject(new Error('插件窗口 WebContents 不存在'));
    }
    if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
        return Promise.reject(new Error('插件窗口已销毁'));
    }
    if (!isWebContentsLoading(webContents)) {
        return Promise.resolve({ waited: false });
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (typeof webContents.removeListener === 'function') {
                webContents.removeListener('dom-ready', onReady);
                webContents.removeListener('did-fail-load', onFailed);
            }
        };
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(result);
        };
        const onReady = () => finish(null, { waited: true });
        const onFailed = (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
            // 子框架加载失败不代表插件主页面不可用，只处理主框架失败。
            if (isMainFrame === false) return;
            finish(new Error(`插件页面加载失败（${errorCode}）：${errorDescription || '未知错误'}`));
        };

        webContents.once('dom-ready', onReady);
        webContents.on('did-fail-load', onFailed);
        timer = setTimeout(() => {
            finish(new Error(`等待插件页面就绪超时（${timeoutMs}ms）`));
        }, timeoutMs);

        // 监听注册后再次检查，避免 dom-ready 恰好在注册前触发造成永久等待。
        if (!isWebContentsLoading(webContents)) {
            finish(null, { waited: false });
        }
    });
}

module.exports = {
    isWebContentsLoading,
    waitForPluginWindowReady
};
