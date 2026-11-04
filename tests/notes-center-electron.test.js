const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { preload: path.join(__dirname, 'notes-center-electron-preload.js'), nodeIntegration: true, contextIsolation: false } });
  try {
    await win.loadFile(path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-notes-center', 'index.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      await wait(30);
      window.confirm = () => true;
      const initialSplit = document.querySelector('[data-view="split"]').classList.contains('active') && getComputedStyle(document.querySelector('#notePreview')).display !== 'none';
      const content = document.querySelector('#noteContent');
      content.value = '# 甲\\n\\n最新内容'; content.dispatchEvent(new Event('input'));
      document.querySelector('[data-id="2"]').click();
      await wait(30);
      const firstSaved = window.notesDataForTest['md-notes'].find(item => item.id === 1).content;
      document.querySelector('#copyNote').click();
      const copied = window.copiedForTest;
      document.querySelector('#pinNote').click(); await wait(20);
      const pinned = window.notesDataForTest['md-notes'].find(item => item.id === 2).pinned;
      document.querySelector('#duplicateNote').click(); await wait(20);
      const duplicated = window.notesDataForTest['md-notes'].length === 3;
      document.querySelector('#importNote').click(); await wait(20);
      const imported = window.notesDataForTest['md-notes'].some(item => item.title === '导入篇');
      document.querySelector('#exportNote').click(); await wait(20);
      const exported = window.exportedForTest;
      document.querySelector('[data-tool="floating-notes"]').click(); await wait(20);
      document.querySelector('[data-copy="0"]').click(); await wait(20);
      const stickyCopied = window.copiedForTest;
      const stickyEditor = document.querySelector('[data-sti="0"]');
      stickyEditor.value = '快速切换便签'; stickyEditor.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-tool="markdown-notes"]').click();
      document.querySelector('[data-tool="floating-notes"]').click(); await wait(30);
      const stickySaved = window.notesDataForTest.stickies[0].text;
      return { initialSplit, firstSaved, copied, pinned, duplicated, imported, exported, stickyCopied, stickySaved,
        noHeader: !document.querySelector('.head'), pageScroll: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert.equal(result.initialSplit, true);
    assert.equal(result.firstSaved, '# 甲\n\n最新内容');
    assert.equal(result.copied, '第二篇');
    assert.equal(result.pinned, true);
    assert.equal(result.duplicated, true);
    assert.equal(result.imported, true);
    assert.deepEqual(result.exported, { title: '导入篇', content: '# 导入成功' });
    assert.equal(result.stickyCopied, '便签原文');
    assert.equal(result.stickySaved, '快速切换便签');
    assert.equal(result.noHeader, true);
    assert.equal(result.pageScroll, false);
    for (const [width, height] of [[1180, 760], [1480, 900]]) {
      win.setSize(width, height);
      const overflow = await win.webContents.executeJavaScript('document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth');
      assert.equal(overflow, false, `${width}x${height} 出现页面滚动`);
    }
    console.log('notes center Electron interactions passed'); app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { win.destroy(); }
});
