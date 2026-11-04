const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-snippets-'));
const first = path.join(root, 'first');
const second = path.join(root, 'second');
fs.mkdirSync(first);
fs.mkdirSync(second);
fs.writeFileSync(path.join(first, '同名.md'), '第一份', 'utf8');
fs.writeFileSync(path.join(second, '同名.md'), '第二份', 'utf8');
let settings = { snippetsPaths: [first, second], defaultSnippetsPath: first, autoInsert: false, searchSubfolders: true };
let activity = { favorites: [], recent: [] };
let insertionPayload = null;
ipcMain.on('plugin-storage-get', (event, _name, key) => { event.returnValue = key === 'snippets-activity-v1' ? activity : settings; });
ipcMain.on('plugin-storage-set', (event, _name, key, value) => {
    if (key === 'snippets-activity-v1') activity = value;
    else settings = value;
    event.returnValue = true;
});
ipcMain.handle('insert-content', (_event, payload) => { insertionPayload = payload; return { success: true }; });
for (const channel of ['hide-search-window', 'restore-previous-focus', 'close-plugin-window']) ipcMain.handle(channel, () => true);

app.whenReady().then(async () => {
    const plugin = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-text');
    const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: path.join(plugin, 'preload.js'), nodeIntegration: true, contextIsolation: false } });
    try {
        await win.loadFile(path.join(plugin, 'index.html'));
        clipboard.writeText('剪贴板新建内容');
        const result = await win.webContents.executeJavaScript(`(() => {
            const rows = [...document.querySelectorAll('.snippet-item')];
            const noRepeatedTitle = !document.querySelector('.header h1');
            const initialFolders = rows.map(row => row.querySelector('.snippet-folder').textContent);
            rows[0].click();
            const preview = document.getElementById('previewContent').textContent;
            closeModal('previewModal');
            document.getElementById('searchInput').value = '同名 第一份'; searchSnippets();
            const filtered = document.querySelectorAll('.snippet-item').length;
            document.getElementById('searchInput').value = ''; searchSnippets();
            return { noRepeatedTitle, initialFolders, preview, filtered, noOverflow: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth };
        })()`);
        assert.equal(result.noRepeatedTitle, true);
        assert.equal(result.initialFolders.length, 2);
        assert.equal(result.preview, '第一份');
        assert.equal(result.filtered, 1);
        assert.equal(result.noOverflow, true);
        const newFromClipboard = await win.webContents.executeJavaScript(`(() => {
            createFromClipboard();
            const content = document.getElementById('snippetContent').value;
            closeModal('snippetModal');
            const folder = document.getElementById('folderFilter');
            folder.value = ${JSON.stringify(second)}; searchSnippets();
            const filteredByFolder = document.querySelectorAll('.snippet-item').length;
            folder.value = ''; searchSnippets();
            return { content, filteredByFolder };
        })()`);
        assert.equal(newFromClipboard.content, '剪贴板新建内容');
        assert.equal(newFromClipboard.filteredByFolder, 1);
        const features = await win.webContents.executeJavaScript(`(() => {
            const first = window.services.getSnippets()[0];
            window.services.toggleFavorite(first.path);
            setListFilter('favorite');
            const favoriteCount = document.querySelectorAll('.snippet-item').length;
            window.services.copySnippet(first);
            setListFilter('recent');
            const recentCount = document.querySelectorAll('.snippet-item').length;
            const duplicate = window.services.duplicateSnippet(first.path);
            loadSnippets();
            return { favoriteCount, recentCount, duplicate, content: require('fs').readFileSync(duplicate, 'utf8') };
        })()`);
        assert.equal(features.favoriteCount, 1);
        assert.equal(features.recentCount, 1);
        assert.equal(features.content, '第一份');
        assert.equal(fs.existsSync(features.duplicate), true);
        assert.equal(activity.favorites.length, 1);
        assert.equal(activity.recent.length, 1);
        const backend = await win.webContents.executeJavaScript(`(() => {
            const a = window.services.getSnippets();
            let collision = false, stale = false;
            try { window.services.createSnippet('同名', '不应覆盖'); } catch { collision = true; }
            const created = window.services.createSnippet('新片段', '新内容');
            const renamed = window.services.editSnippet(created, '重命名', '更新内容');
            window.services.deleteSnippet(a.find(item => item.content === '第二份').path);
            const current = window.services.getSnippets().find(item => item.path === ${JSON.stringify(path.join(first, '同名.md'))});
            require('fs').writeFileSync(current.path, '外部修改', 'utf8');
            try { window.services.editSnippet(current.path, '同名', '覆盖'); } catch { stale = true; }
            return { collision, stale, created, renamed };
        })()`);
        assert.equal(backend.collision, true);
        assert.equal(backend.stale, true);
        assert.equal(fs.readFileSync(path.join(first, '同名.md'), 'utf8'), '外部修改');
        assert.equal(fs.existsSync(path.join(second, '同名.md')), false);
        assert.equal(fs.existsSync(backend.created), false);
        assert.equal(fs.readFileSync(backend.renamed, 'utf8'), '更新内容');
        settings.autoInsert = true;
        await win.webContents.executeJavaScript(`window.exports['text-snippets'].args.select(null, { content: '插入正文' })`);
        assert.deepEqual(insertionPayload, { title: '文本片段', content: '插入正文', contentType: 'text-snippet', directInsert: true });
        console.log('text snippets Electron UI and file operations passed');
        app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    finally { win.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});
