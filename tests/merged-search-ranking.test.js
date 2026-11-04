const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { searchCatalog } = require('../app/search_utils');

const plugin = (name, text) => ({ name, searchText: text, engine: 'tools' });
const content = (title, body = '', contentType = 'text-snippet') => ({ title, searchTitle: title.toLowerCase(), searchBody: body.toLowerCase(), contentType });

test('多词覆盖优先：两个词的片段排在只匹配一个词的插件前', () => {
    const results = searchCatalog('skill gitea', [plugin('AI 视频工作室', 'skill')], [content('skill-gitea的git备份同步')]);
    assert.equal(results[0].contentType, 'text-snippet');
    assert.equal(results[0].matchedKeywordsCount, 2);
    assert.equal(results[1].matchedKeywordsCount, 1);
});

test('单词及同覆盖多词保留插件、命令、片段优先顺序', () => {
    for (const query of ['skill', 'skill gitea']) {
        const results = searchCatalog(query, [plugin('工具', 'skill gitea')], [content('skill gitea', 'skill gitea'), content('skill gitea', '', 'command')]);
        assert.deepEqual(results.map(item => item.type === 'plugin' ? 'plugin' : item.contentType), ['plugin', 'command', 'text-snippet']);
    }
});

test('跨标题、正文和预览的匹配计数取并集，不重复计算同一查询词', () => {
    const results = searchCatalog('skill gitea backup', [], [{ title: 'skill', searchTitle: 'skill', searchBody: 'gitea skill', preview: 'backup skill', contentType: 'text-snippet' }]);
    assert.equal(results[0].matchedKeywordsCount, 3);
    assert.equal(results[0].totalKeywords, 3);
});

test('重复词去重，忽略首尾空白、连续空格、制表符与大小写', () => {
    const results = searchCatalog('  SKILL\t skill  GiTeA gitea  ', [plugin('工具', 'SKILL gitea')], []);
    assert.equal(results[0].matchedKeywordsCount, 2);
    assert.equal(results[0].totalKeywords, 2);
    assert.equal(searchCatalog('skill SKILL', [plugin('工具', 'skill')], [])[0].totalKeywords, 1);
});

test('更多词覆盖不会被高分插件覆盖，相关性只在同覆盖同类型内比较', () => {
    const results = searchCatalog('skill gitea backup', [plugin('partial', 'skill gitea')], [content('skill', 'gitea backup')]);
    assert.equal(results[0].title, 'skill');
    const sameType = searchCatalog('skill', [], [content('相关介绍', 'skill'), content('skill')]);
    assert.equal(sameType[0].title, 'skill');
});

test('无匹配、空查询与数量限制保持一致', () => {
    assert.deepEqual(searchCatalog('unmatched', [plugin('工具', 'skill')], []), []);
    assert.deepEqual(searchCatalog('   \t ', [plugin('工具', 'skill')], []), []);
    assert.equal(searchCatalog('skill', Array.from({ length: 70 }, (_value, index) => plugin(`工具${index}`, 'skill')), []).length, 50);
});

test('真实快捷搜索页面输入路径及匹配标记验收', () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [path.join(__dirname, 'merged-search-ranking-electron.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 35000, maxBuffer: 2 * 1024 * 1024 });
    const log = path.join(__dirname, '..', 'dist', 'merged-search-ranking-console.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''), 'utf8');
    if (result.status !== 0) console.error((result.stdout || '').slice(-7000) + (result.stderr || '').slice(-7000));
    assert.equal(result.status, 0, `真实搜索界面验收失败，日志 ${log}；${result.error || ''}`);
});
