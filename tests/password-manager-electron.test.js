const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert');
const path = require('path');

const memory = new Map();
const storageKey = (pluginName, key) => `${pluginName}:${key}`;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

ipcMain.on('plugin-storage-get', (event, pluginName, key) => {
    event.returnValue = memory.get(storageKey(pluginName, key)) ?? null;
});
ipcMain.on('plugin-storage-set', (event, pluginName, key, value) => {
    memory.set(storageKey(pluginName, key), value);
    event.returnValue = true;
});
ipcMain.on('plugin-storage-remove', (event, pluginName, key) => {
    memory.delete(storageKey(pluginName, key));
    event.returnValue = true;
});
ipcMain.handle('plugin-storage-get-async', (_event, pluginName, key) => {
    return memory.get(storageKey(pluginName, key)) ?? null;
});
ipcMain.handle('plugin-storage-set-async', async (_event, pluginName, key, value) => {
    await delay(80);
    memory.set(storageKey(pluginName, key), value);
    return true;
});
ipcMain.handle('plugin-storage-remove-async', async (_event, pluginName, key) => {
    await delay(10);
    memory.delete(storageKey(pluginName, key));
    return true;
});

async function runPasswordManagerFlow() {
    const directory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-password');
    const errors = [];
    const win = new BrowserWindow({
        show: false,
        width: 1000,
        height: 720,
        webPreferences: {
            preload: path.join(directory, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false
        }
    });
    win.webContents.on('console-message', (_event, level, message) => {
        if (level >= 3) errors.push(message);
    });

    await win.loadFile(path.join(directory, 'index.html'));
    await delay(60);

    const result = await win.webContents.executeJavaScript(`(async () => {
        window.confirm = () => true;
        document.getElementById('setupPassword').value = 'test-pass';
        document.getElementById('confirmPassword').value = 'test-pass';
        setupLockPassword();

        addNewPassword();
        const unsafeTitle = '<img src=x onerror="window.__xss=true"> O\\'Reilly';
        document.getElementById('passwordTitle').value = unsafeTitle;
        document.getElementById('passwordUsername').value = 'user@example.com';
        document.getElementById('passwordValue').value = 'p\\'ass<word>';
        document.getElementById('apiKeyValue').value = 'secret-api-key';
        saveCurrentPassword();

        const titleText = document.querySelector('.password-title')?.textContent || '';
        const injectedImageCount = document.querySelectorAll('.password-item img').length;

        addNewPassword();
        const apiKeyWasCleared = document.getElementById('apiKeyValue').value === '';
        document.querySelector('.password-item').click();

        let rendererTicked = false;
        setTimeout(() => { rendererTicked = true; }, 0);
        const deletePromise = deleteCurrentPassword();
        await new Promise(resolve => setTimeout(resolve, 20));
        const deleteBusyState = document.getElementById('deletePasswordButton').disabled
            && document.getElementById('deletePasswordButton').textContent.includes('删除中');
        await deletePromise;

        const deletedFromUi = document.querySelectorAll('.password-item').length === 0;

        const csv = [
            '标题,用户名,密码,API密钥,网址,分类,备注,创建时间,更新时间',
            '导入账号,csv-user,csv-password,csv-api-key,https://example.com,自定义分类,备注,2026-01-01,2026-01-02'
        ].join('\\n');
        const importResult = await importFromCSV(csv, false, false);
        const importedItem = db.getAllPasswords()[0];
        const lockPasswordPreserved = Boolean(appStorage.getLockPassword());
        const importedCategoryVisible = categories.includes('自定义分类');

        const resetPromise = resetLockPassword();
        await resetPromise;
        const setupVisible = getComputedStyle(document.getElementById('setupScreen')).display !== 'none';

        return {
            titleText,
            unsafeTitle,
            injectedImageCount,
            apiKeyWasCleared,
            rendererTicked,
            deleteBusyState,
            deletedFromUi,
            importResult,
            importedItem,
            lockPasswordPreserved,
            importedCategoryVisible,
            setupVisible,
            preloadApi: Boolean(window.electronAPI),
            xssTriggered: Boolean(window.__xss)
        };
    })()`);

    win.destroy();

    assert.deepStrictEqual(errors, [], `插件不应产生控制台错误：${errors.join('; ')}`);
    assert.strictEqual(result.preloadApi, true, 'contextIsolation=false 时仍应提供窄 preload API');
    assert.strictEqual(result.titleText, result.unsafeTitle, '账号标题必须按纯文本完整显示');
    assert.strictEqual(result.injectedImageCount, 0, '账号标题不得注入 HTML');
    assert.strictEqual(result.xssTriggered, false, '账号标题不得执行脚本');
    assert.strictEqual(result.apiKeyWasCleared, true, '新增账号时不得残留上一条 API 密钥');
    assert.strictEqual(result.rendererTicked, true, '异步删除期间渲染线程应保持响应');
    assert.strictEqual(result.deleteBusyState, true, '删除期间应显示忙碌状态并阻止重复点击');
    assert.strictEqual(result.deletedFromUi, true, '删除后列表应立即同步');
    assert.deepStrictEqual(result.importResult, { success: true, imported: 1, skipped: 0 });
    assert.strictEqual(result.importedItem.apiKey, 'csv-api-key', 'CSV 导入不得错位或丢失 API 密钥');
    assert.strictEqual(result.importedItem.url, 'https://example.com', 'CSV 导入网址列不得错位');
    assert.strictEqual(result.lockPasswordPreserved, true, '覆盖导入不得删除当前开屏密码');
    assert.strictEqual(result.importedCategoryVisible, true, '导入的自定义分类必须立即可见');
    assert.strictEqual(result.setupVisible, true, '整库清空后应返回设置开屏密码界面');
    assert.deepStrictEqual(
        [...memory.keys()].filter(key => key.startsWith('password-manager:') && !key.endsWith(':encryptionSalt')),
        [],
        '重置密码应清除全部账号数据，随机派生盐可以安全复用'
    );
}

app.whenReady().then(async () => {
    try {
        await runPasswordManagerFlow();
        console.log('Password manager Electron regression passed');
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
