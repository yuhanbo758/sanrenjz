const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-search-ranking-'));
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const output = path.join(root, 'dist', 'merged-search-ranking-validation');
fs.mkdirSync(output, { recursive: true });
const report = { assertions: [], errors: [], isolatedProfile: true, hidden: true };
const check = (value, label) => { assert(value, label); report.assertions.push(label); };
const partial = { id: 'tools:studio', engine: 'tools', name: 'AI 视频工作室', description: '使用 Skill 自动制作短视频', searchText: 'ai 视频工作室 使用 skill 自动制作短视频', features: [] };
const snippet = { type: 'content', contentType: 'text-snippet', title: 'skill-gitea的git备份同步-gitea-git-backup', preview: '调用 gitea-git-backup skill，根据下面的内容进行操作', searchTitle: 'skill-gitea的git备份同步-gitea-git-backup', searchBody: '调用 gitea-git-backup skill，根据下面的内容进行操作', pluginName: '隔离文本片段助手' };
let catalog = { version: 1, plugins: [partial], contents: [snippet] };
let businessCalls = 0;
ipcMain.handle('search-catalog-get', () => catalog);
ipcMain.handle('get-pin-status', () => true);
ipcMain.handle('hide-search-window', () => ({ success: true }));
ipcMain.handle('run-plugin', () => { businessCalls++; throw new Error('搜索验收禁止运行业务'); });
ipcMain.handle('unified:run', () => { businessCalls++; throw new Error('搜索验收禁止运行业务'); });
ipcMain.handle('insert-content', () => { businessCalls++; throw new Error('搜索验收禁止插入内容'); });
process.on('unhandledRejection', error => report.errors.push(String(error)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) { if (await fn()) return; await delay(30); }
    throw new Error(message);
}
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 780, height: 520, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) report.errors.push(message); });
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    const input = async query => {
        await evaluate(`document.getElementById('search-input').value=${JSON.stringify(query)}; document.getElementById('search-input').dispatchEvent(new Event('input',{bubbles:true})); true;`);
        await delay(100);
        await until(() => evaluate('searchFrame===0'), '真实输入动画帧未完成');
        return evaluate('filteredResults.map(item=>({name:item.name,title:item.title,type:item.type,contentType:item.contentType,engine:item.engine,matched:item.matchedKeywordsCount,total:item.totalKeywords}))');
    };
    const refresh = async next => {
        catalog = { ...next, version: catalog.version + 1 };
        win.webContents.send('search-catalog-invalidated', { version: catalog.version });
        await until(() => evaluate(`catalogVersion===${catalog.version}`), '目录刷新未完成');
    };
    try {
        await win.loadFile(path.join(root, 'search-window.html'));
        await until(() => evaluate('catalogVersion===1'), '实际搜索页面未加载统一目录');
        const multi = await input('skill gitea');
        check(multi[0].contentType === 'text-snippet' && multi[0].matched === 2 && multi[1].type === 'plugin' && multi[1].matched === 1, '真实逐字输入路径：2/2片段排在1/2插件之前');
        check(await evaluate("document.querySelector('.result-item.selected .result-title').textContent.includes('skill-gitea') && document.querySelector('.result-item.selected .match-indicator').textContent.trim()==='2/2'"), '首项高亮及2/2匹配标记与排序同步');
        fs.writeFileSync(path.join(output, 'multi-keyword-ranking.png'), (await win.webContents.capturePage()).toPNG());
        const single = await input('skill');
        check(single[0].type === 'plugin', '单词skill仍优先插件');
        check(await evaluate("document.querySelectorAll('.match-indicator').length===0"), '单词查询不显示多词匹配标记');
        const duplicate = await input('  SKILL\tSkill GITEA  gitea ');
        check(duplicate[0].matched === 2 && duplicate.every(item => item.total === 2), '实际输入去除重复词并统一大小写和空白');
        await refresh({ plugins: [{ ...partial, id: 'python:helper/run.py', engine: 'python', name: 'Python skill-gitea', searchText: 'python skill gitea' }], contents: [snippet, { ...snippet, title: 'skill gitea命令', searchTitle: 'skill gitea命令', contentType: 'command' }] });
        const same = await input('skill gitea');
        check(same[0].engine === 'python' && same[1].contentType === 'command' && same[2].contentType === 'text-snippet', '同覆盖排序保留Python插件、命令、片段优先级');
        await refresh({ plugins: [partial], contents: [{ ...snippet, title: 'skill 标题', searchTitle: 'skill 标题', searchBody: '正文中的gitea', preview: 'backup预览' }] });
        const union = await input('skill gitea backup');
        check(union[0].matched === 3 && union[0].total === 3, '实际片段跨标题正文预览覆盖计数取并集');
        await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); true;");
        check(await evaluate("selectedIndex===1 && document.querySelector('.result-item.selected').dataset.index==='1'"), '重新排序后方向键导航仍选中正确结果');
        const none = await input('不存在的搜索词');
        check(none.length === 0 && await evaluate("document.getElementById('results-container').textContent.includes('没有找到')"), '无匹配保留原空结果提示');
        await input('   ');
        check(await evaluate("document.getElementById('results-container').textContent.includes('开始输入')"), '空查询保持起始提示');
        check(businessCalls === 0, '搜索和导航不运行插件或插入业务内容');
        check(report.errors.length === 0, '实际搜索页面没有未处理脚本错误');
        report.success = true;
    } catch (error) { report.success = false; report.errors.push(error.stack || String(error)); }
    finally {
        fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
        console.log(JSON.stringify(report)); app.exit(report.success ? 0 : 1);
    }
}).catch(error => { console.error(error); app.exit(1); });
setTimeout(() => { console.error('快捷搜索排序验收超时'); app.exit(2); }, 30000).unref();
app.once('quit', () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
