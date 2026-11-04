'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
    isWebContentsLoading,
    waitForPluginWindowReady
} = require('../app/plugin_runtime/plugin-window-ready');

/**
 * 构造最小 WebContents 替身，只模拟本回归测试需要的加载状态和事件能力。
 */
class FakeWebContents extends EventEmitter {
    constructor(loading = false) {
        super();
        this.loading = loading;
        this.destroyed = false;
    }

    isLoadingMainFrame() {
        return this.loading;
    }

    isDestroyed() {
        return this.destroyed;
    }
}

(async () => {
    // 已经打开并完成加载的插件必须立即返回，这是重复派发不再卡住的核心断言。
    const readyContents = new FakeWebContents(false);
    assert.strictEqual(isWebContentsLoading(readyContents), false);
    assert.deepStrictEqual(await waitForPluginWindowReady(readyContents, 50), { waited: false });
    assert.strictEqual(readyContents.listenerCount('dom-ready'), 0);

    // 新建窗口仍需等待 dom-ready，确保插件 preload 与页面脚本完成初始化后再派发。
    const loadingContents = new FakeWebContents(true);
    const loadingPromise = waitForPluginWindowReady(loadingContents, 100);
    setImmediate(() => {
        loadingContents.loading = false;
        loadingContents.emit('dom-ready');
    });
    assert.deepStrictEqual(await loadingPromise, { waited: true });
    assert.strictEqual(loadingContents.listenerCount('dom-ready'), 0);
    assert.strictEqual(loadingContents.listenerCount('did-fail-load'), 0);

    // 模拟第一次状态检查后页面立即完成的竞态，第二次检查应主动收口。
    let checks = 0;
    const racedContents = new FakeWebContents(true);
    racedContents.isLoadingMainFrame = () => (++checks === 1);
    assert.deepStrictEqual(await waitForPluginWindowReady(racedContents, 50), { waited: false });

    // 主框架加载失败和超时都要显式失败，不能让总指挥界面永久停在“正在移交”。
    const failedContents = new FakeWebContents(true);
    const failedPromise = waitForPluginWindowReady(failedContents, 100);
    setImmediate(() => failedContents.emit('did-fail-load', null, -6, 'FILE_NOT_FOUND', '', true));
    await assert.rejects(failedPromise, /插件页面加载失败/);

    const timedOutContents = new FakeWebContents(true);
    await assert.rejects(waitForPluginWindowReady(timedOutContents, 10), /等待插件页面就绪超时/);

    console.log('Plugin window readiness tests passed: reuse, load, race, failure, timeout');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
