const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const DatabaseDriver = require('better-sqlite3');

const pluginDirectory = path.join(__dirname, '..', 'app', 'software', 'sanrenjz-tools-account-manager');
const database = require(path.join(pluginDirectory, 'database-service'));

async function waitFor(check, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('等待插件界面状态超时');
}

async function run() {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-manager-'));
  const databasePath = path.join(temporaryDirectory, 'dynamic-tables.db');
  let window;
  try {
    database.createDatabase(databasePath);
    database.createTable(databasePath, {
      tableName: '账号资料',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: '项目', type: 'TEXT', notNull: true },
        { name: '用户名', type: 'TEXT' },
        { name: '密码', type: 'TEXT' }
      ]
    });
    database.createTable(databasePath, {
      tableName: '服务器资产',
      columns: [
        { name: 'id', type: 'INTEGER', primaryKey: true },
        { name: '主机名', type: 'TEXT', notNull: true },
        { name: '端口', type: 'INTEGER' },
        { name: '启用', type: 'INTEGER' }
      ]
    });
    database.createTable(databasePath, {
      tableName: '无主键备注',
      columns: [
        { name: '标题', type: 'TEXT', notNull: true },
        { name: '备注', type: 'TEXT' }
      ]
    });
    const rawDatabase = new DatabaseDriver(databasePath);
    rawDatabase.exec('CREATE TABLE "复合主键" ("批次" INTEGER, "代码" TEXT, "内容" TEXT, PRIMARY KEY ("批次", "代码")) WITHOUT ROWID');
    rawDatabase.exec('CREATE TABLE "可空复合主键" ("甲" TEXT, "乙" TEXT, "内容" TEXT, PRIMARY KEY ("甲", "乙"))');
    rawDatabase.prepare('INSERT INTO "复合主键" ("批次", "代码", "内容") VALUES (?, ?, ?)').run(1, 'A', '原内容');
    rawDatabase.prepare('INSERT INTO "可空复合主键" ("甲", "乙", "内容") VALUES (?, ?, ?)').run(null, 'A', '相同内容');
    rawDatabase.prepare('INSERT INTO "可空复合主键" ("甲", "乙", "内容") VALUES (?, ?, ?)').run(null, 'A', '相同内容');
    rawDatabase.close();
    database.insertRow(databasePath, { tableName: '账号资料', values: { 项目: '示例项目', 用户名: 'tester', 密码: 'local-only' } });
    database.insertRow(databasePath, { tableName: '账号资料', values: { 项目: '备用项目', 用户名: 'backup', 密码: 'another-secret' } });
    database.insertRow(databasePath, { tableName: '服务器资产', values: { 主机名: 'localhost', 端口: '8080', 启用: '1' } });
    database.insertRow(databasePath, { tableName: '无主键备注', values: { 标题: '第一条', 备注: '修改前' } });

    const accountRows = database.queryRows(databasePath, { tableName: '账号资料', searchColumn: '项目', searchText: '示例', searchMode: 'contains' });
    assert.strictEqual(accountRows.total, 1);
    assert.deepStrictEqual(accountRows.columns.filter(column => column.hidden === 0).map(column => column.name), ['id', '项目', '用户名', '密码']);
    const allColumnPasswordRows = database.queryRows(databasePath, { tableName: '账号资料', searchColumn: '__all__', searchText: 'local-on', searchMode: 'contains' });
    assert.strictEqual(allColumnPasswordRows.total, 1, '整表查询应能在不知道列名时找到密码片段');
    const allColumnUserRows = database.queryRows(databasePath, { tableName: '账号资料', searchColumn: '__all__', searchText: 'tester', searchMode: 'equals' });
    assert.strictEqual(allColumnUserRows.total, 1, '整表精确查询应匹配任意列');
    const serverRows = database.queryRows(databasePath, { tableName: '服务器资产' });
    assert.strictEqual(serverRows.rows[0].端口, 8080);
    assert.strictEqual(serverRows.editCapability.locatorType, 'primaryKey');
    database.updateRow(databasePath, {
      tableName: '服务器资产',
      values: { 主机名: 'localhost', 端口: '9090', 启用: '1' },
      locator: serverRows.rows[0].__locator,
      original: serverRows.rows[0].__original
    });
    assert.strictEqual(database.queryRows(databasePath, { tableName: '服务器资产' }).rows[0].端口, 9090);
    assert.throws(() => database.updateRow(databasePath, {
      tableName: '服务器资产',
      values: { 主机名: 'localhost', 端口: '7070', 启用: '1' },
      locator: serverRows.rows[0].__locator,
      original: serverRows.rows[0].__original
    }), /已被修改或删除/, '过期快照不得覆盖其他修改');
    assert.throws(() => database.deleteRow(databasePath, {
      tableName: '服务器资产',
      locator: serverRows.rows[0].__locator,
      original: serverRows.rows[0].__original
    }), /已被修改或删除/, '过期快照不得删除已改动记录');
    const currentServer = database.queryRows(databasePath, { tableName: '服务器资产' }).rows[0];
    assert.throws(() => database.deleteRow(databasePath, { tableName: '服务器资产', locator: currentServer.__locator }), /原始记录快照/);
    assert.deepStrictEqual(database.deleteRow(databasePath, {
      tableName: '服务器资产', locator: currentServer.__locator, original: currentServer.__original
    }), { changes: 1 });
    assert.strictEqual(database.queryRows(databasePath, { tableName: '服务器资产' }).total, 0);
    const rowidRows = database.queryRows(databasePath, { tableName: '无主键备注' });
    assert.strictEqual(rowidRows.editCapability.locatorType, 'rowid');
    database.updateRow(databasePath, {
      tableName: '无主键备注',
      values: { 标题: '第一条', 备注: '修改后' },
      locator: rowidRows.rows[0].__locator,
      original: rowidRows.rows[0].__original
    });
    assert.strictEqual(database.queryRows(databasePath, { tableName: '无主键备注' }).rows[0].备注, '修改后');
    const currentNote = database.queryRows(databasePath, { tableName: '无主键备注' }).rows[0];
    assert.strictEqual(database.deleteRow(databasePath, {
      tableName: '无主键备注', locator: currentNote.__locator, original: currentNote.__original
    }).changes, 1, '无主键表应能按 rowid 删除');
    assert.strictEqual(database.queryRows(databasePath, { tableName: '无主键备注' }).total, 0);
    const compositeRows = database.queryRows(databasePath, { tableName: '复合主键' });
    assert.strictEqual(compositeRows.editCapability.locatorType, 'primaryKey');
    assert.strictEqual(compositeRows.columns.find(column => column.name === '批次').autoGenerated, false);
    database.updateRow(databasePath, {
      tableName: '复合主键',
      values: { 批次: '2', 代码: 'B', 内容: '新内容' },
      locator: compositeRows.rows[0].__locator,
      original: compositeRows.rows[0].__original
    });
    const updatedComposite = database.queryRows(databasePath, { tableName: '复合主键' }).rows[0];
    assert.strictEqual(updatedComposite.批次, 2);
    assert.strictEqual(updatedComposite.代码, 'B');
    assert.strictEqual(updatedComposite.内容, '新内容');
    assert.strictEqual(database.deleteRow(databasePath, {
      tableName: '复合主键', locator: updatedComposite.__locator, original: updatedComposite.__original
    }).changes, 1, '复合主键表应能删除指定行');
    assert.strictEqual(database.queryRows(databasePath, { tableName: '复合主键' }).total, 0);
    const ambiguousRows = database.queryRows(databasePath, { tableName: '可空复合主键' });
    assert.strictEqual(ambiguousRows.total, 2);
    assert.throws(() => database.deleteRow(databasePath, {
      tableName: '可空复合主键', locator: ambiguousRows.rows[0].__locator, original: ambiguousRows.rows[0].__original
    }), /无法唯一定位/, '非唯一的可空复合主键不得导致批量删除');
    assert.strictEqual(database.queryRows(databasePath, { tableName: '可空复合主键' }).total, 2, '多行删除必须整体回滚');
    assert.throws(() => database.updateRow(databasePath, {
      tableName: '可空复合主键', values: { 内容: '误改' },
      locator: ambiguousRows.rows[0].__locator, original: ambiguousRows.rows[0].__original
    }), /无法唯一定位/, '非唯一的可空复合主键不得导致批量修改');
    assert.ok(database.queryRows(databasePath, { tableName: '可空复合主键' }).rows.every(row => row.内容 === '相同内容'), '多行修改必须整体回滚');
    assert.throws(() => database.queryRows(databasePath, { tableName: '服务器资产', searchColumn: '不存在', searchText: 'x' }), /查询字段/);

    ipcMain.handle('plugin-storage-get-async', (_event, _pluginName, key) => key === 'lastSession' ? { databasePath, tableName: '账号资料' } : null);
    ipcMain.handle('plugin-storage-set-async', () => true);
    ipcMain.handle('close-plugin-window', () => true);
    ipcMain.on('show-open-dialog', event => { event.returnValue = null; });
    ipcMain.on('show-save-dialog', event => { event.returnValue = null; });

    window = new BrowserWindow({
      show: false,
      width: 900,
      height: 650,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        preload: path.join(pluginDirectory, 'preload.js')
      }
    });
    await window.loadFile(path.join(pluginDirectory, 'index.html'));
    await waitFor(() => window.webContents.executeJavaScript("document.querySelectorAll('#tableHead th').length === 5"));
    const initial = await window.webContents.executeJavaScript(`({
      title: document.querySelector('#tableTitle').textContent,
      headers: [...document.querySelectorAll('#tableHead th')].map(node => node.textContent),
      rows: document.querySelectorAll('#tableBody tr').length,
      pageOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      addButtonVisible: document.querySelector('#addRow').getBoundingClientRect().right <= innerWidth,
      emptyHidden: getComputedStyle(document.querySelector('#empty')).display === 'none',
      passwordMasked: [...document.querySelectorAll('#tableBody td.sensitive')].every(cell => cell.textContent === '••••••••'),
      searchStrategy: document.querySelector('#searchColumn').value,
      searchLabel: document.querySelector('#searchColumn').selectedOptions[0].textContent
    })`);
    assert.strictEqual(initial.title, '账号资料');
    assert.deepStrictEqual(initial.headers, ['id', '项目', '用户名', '密码', '操作']);
    assert.strictEqual(initial.rows, 2);
    assert.strictEqual(initial.pageOverflow, false);
    assert.strictEqual(initial.addButtonVisible, true);
    assert.strictEqual(initial.emptyHidden, true);
    assert.strictEqual(initial.passwordMasked, true);
    assert.strictEqual(initial.searchStrategy, '__all__');
    assert.strictEqual(initial.searchLabel, '整表（全部列）');

    await window.webContents.executeJavaScript(`
      document.querySelector('#searchText').value = 'local-on';
      document.querySelector('#searchButton').click();
    `);
    await waitFor(() => window.webContents.executeJavaScript("document.querySelectorAll('#tableBody tr').length === 1 && document.querySelector('#status').textContent.includes('已加载')"));
    const searchedProject = await window.webContents.executeJavaScript("document.querySelector('#tableBody tr td:nth-child(2)').textContent");
    assert.strictEqual(searchedProject, '示例项目', '整表查询 UI 应跨列找到密码片段对应的记录');

    await window.webContents.executeJavaScript("document.querySelector('.edit-row').click()");
    await waitFor(() => window.webContents.executeJavaScript("document.querySelector('#rowDrawer').classList.contains('open')"));
    const editForm = await window.webContents.executeJavaScript(`({
      title: document.querySelector('#drawerTitle').textContent,
      idDisabled: document.querySelector('#field-0').disabled,
      password: document.querySelector('[data-column="密码"]').value,
      saveVisible: document.querySelector('#saveRow').getBoundingClientRect().bottom <= innerHeight
    })`);
    assert.strictEqual(editForm.title, '修改记录');
    assert.strictEqual(editForm.idDisabled, true);
    assert.strictEqual(editForm.password, 'local-only');
    assert.strictEqual(editForm.saveVisible, true, '修改抽屉底部保存按钮必须保持可见');
    if (process.env.ACCOUNT_PLUGIN_SCREENSHOT) {
      window.setSize(1180, 760);
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync(process.env.ACCOUNT_PLUGIN_SCREENSHOT, (await window.capturePage()).toPNG());
    }
    await window.webContents.executeJavaScript(`
      document.querySelector('[data-column="项目"]').value = '已修正项目';
      document.querySelector('[data-column="密码"]').value = 'corrected-secret';
      document.querySelector('[data-null-column="用户名"]').click();
      document.querySelector('#saveRow').click();
    `);
    await waitFor(() => window.webContents.executeJavaScript("!document.querySelector('#rowDrawer').classList.contains('open') && document.querySelector('#status').textContent === '记录修改成功'"));
    const correctedRows = database.queryRows(databasePath, { tableName: '账号资料', searchColumn: '__all__', searchText: 'corrected-secret', searchMode: 'equals' });
    assert.strictEqual(correctedRows.total, 1);
    assert.strictEqual(correctedRows.rows[0].项目, '已修正项目');
    assert.strictEqual(correctedRows.rows[0].用户名, null);

    await window.webContents.executeJavaScript("document.querySelector('#clearSearch').click()");
    await waitFor(() => window.webContents.executeJavaScript("document.querySelectorAll('#tableBody tr').length === 2"));
    await window.webContents.executeJavaScript("document.querySelector('#tableBody .delete-row').click()");
    await waitFor(() => window.webContents.executeJavaScript("document.querySelector('#deleteModal').classList.contains('open')"));
    const deleteDialog = await window.webContents.executeJavaScript(`({
      description: document.querySelector('#deleteDescription').textContent,
      modalText: document.querySelector('#deleteModal').textContent,
      confirmVisible: document.querySelector('#confirmDelete').getBoundingClientRect().bottom <= innerHeight
    })`);
    assert.match(deleteDialog.description, /账号资料/);
    assert.ok(!deleteDialog.modalText.includes('corrected-secret'), '确认框不应泄露密码');
    assert.strictEqual(deleteDialog.confirmVisible, true);
    await window.webContents.executeJavaScript("document.querySelector('[data-close-delete]').click()");
    assert.strictEqual(database.queryRows(databasePath, { tableName: '账号资料' }).total, 2, '取消删除不应修改数据库');
    await window.webContents.executeJavaScript("document.querySelector('#tableBody .delete-row').click(); document.querySelector('#confirmDelete').click()");
    await waitFor(() => window.webContents.executeJavaScript("document.querySelector('#status').textContent === '记录删除成功' && document.querySelectorAll('#tableBody tr').length === 1"));
    assert.strictEqual(database.queryRows(databasePath, { tableName: '账号资料' }).total, 1, '确认删除只移除目标行');
    assert.strictEqual(database.queryRows(databasePath, { tableName: '账号资料' }).rows[0].项目, '备用项目');

    for (const [width, height] of [[1180, 760], [1440, 900]]) {
      window.setSize(width, height);
      await new Promise(resolve => setTimeout(resolve, 80));
      const layout = await window.webContents.executeJavaScript(`({
        pageOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
        tableVisible: document.querySelector('.grid-card').getBoundingClientRect().height > 200,
        addButtonVisible: document.querySelector('#addRow').getBoundingClientRect().right <= innerWidth
      })`);
      assert.strictEqual(layout.pageOverflow, false, `${width}x${height} 不应出现页面级滚动`);
      assert.strictEqual(layout.tableVisible, true, `${width}x${height} 数据表区域应保持可见`);
      assert.strictEqual(layout.addButtonVisible, true, `${width}x${height} 新增按钮应保持可见`);
    }
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.table-item')].find(node => node.textContent === '服务器资产').click()`);
    await waitFor(() => window.webContents.executeJavaScript("document.querySelector('#tableTitle').textContent === '服务器资产'"));
    const changedHeaders = await window.webContents.executeJavaScript("[...document.querySelectorAll('#tableHead th')].map(node => node.textContent)");
    assert.deepStrictEqual(changedHeaders, ['id', '主机名', '端口', '启用', '操作']);

    console.log('账号数据表插件验证通过：动态表结构、主键/rowid 修改与删除、并发冲突保护、查询校验、三尺寸 UI。');
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    ipcMain.removeHandler('plugin-storage-get-async');
    ipcMain.removeHandler('plugin-storage-set-async');
    ipcMain.removeHandler('close-plugin-window');
    ipcMain.removeAllListeners('show-open-dialog');
    ipcMain.removeAllListeners('show-save-dialog');
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

app.whenReady().then(() => run().then(() => app.exit(0)).catch(error => {
  console.error(error);
  app.exit(1);
}));
