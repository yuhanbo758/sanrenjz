const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RunLogStore, validateLogFilter } = require('../app/run-log-store');
const { createMergedHost } = require('../app/merged-host');

const entry = (engine, id, message, name = '相同名称') => ({ engine, id: `${engine}:${id}`, name, stream: 'stdout', message });

test('统一日志按带类型ID隔离同名插件，来源包含隐藏安装项和保留历史', () => {
    const store = new RunLogStore({ limit: 3 });
    store.registerSources([{ id: 'tools:shared', engine: 'tools', name: '相同名称' }, { id: 'python:shared/run.py', engine: 'python', name: '相同名称', hidden: true }]);
    store.append(entry('tools', 'shared', '效率输出'));
    store.append(entry('python', 'shared/run.py', 'Python输出'));
    assert.equal(store.query().length, 2);
    assert.deepEqual(store.query({ engine: 'tools' }).map(record => record.message), ['效率输出']);
    assert.deepEqual(store.query({ id: 'python:shared/run.py' }).map(record => record.message), ['Python输出']);
    assert.deepEqual(store.sources().map(source => source.installed), [true, true]);
    store.registerSources([{ id: 'tools:shared', engine: 'tools', name: '相同名称' }]);
    assert.equal(store.sources().find(source => source.engine === 'python').installed, false);
    store.append(entry('tools', 'shared', '第二条'));
    store.append(entry('tools', 'shared', '第三条'));
    store.append(entry('tools', 'shared', '第四条'));
    assert.equal(store.sources().some(source => source.engine === 'python'), false, '历史日志淘汰后不无限保留已移除来源');
    assert.equal(store.snapshot().sequence, 5);
    assert.deepEqual(store.query().map(record => record.sequence), [3, 4, 5]);
});

test('日志条数、单条和总字符预算有界，返回副本不能改写缓存', () => {
    const store = new RunLogStore({ maxChars: 2048 });
    for (let index = 0; index < 12; index++) store.append(entry('tools', 'fixture', `${index}:${'中文'.repeat(250)}`));
    assert(store.totalChars <= 2048);
    assert(store.query().length < 12);
    assert(store.query().at(-1).message.startsWith('11:'));
    const bounded = new RunLogStore();
    bounded.append(entry('python', 'fixture.py', '🌟'.repeat(20000)));
    assert(bounded.query()[0].message.length <= 16000);
    assert.match(bounded.query()[0].message, /已截断/);
    const result = bounded.query(); result[0].message = '修改副本'; result.push({});
    assert.notEqual(bounded.query()[0].message, '修改副本');
    assert.equal(bounded.query().length, 1);
});

test('敏感字段脱敏，实时通知同步或异步失败不影响日志记录', async () => {
    const received = [];
    const store = new RunLogStore({ onLog: record => { received.push(record); record.message = '窗口修改'; return Promise.reject(new Error('窗口已关闭')); } });
    const record = store.append(entry('python', 'fixture.py', '中文🌟 token=isolated-token\n"password": "isolated secret"\napi_key=isolated-key\nAuthorization: Bearer isolated-auth\nCookie: session=isolated-cookie; more=hidden'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, 1);
    assert(record.message.includes('中文🌟'));
    for (const text of ['isolated-token', 'isolated secret', 'isolated-key', 'isolated-auth', 'isolated-cookie', 'more=hidden']) assert.equal(record.message.includes(text), false);
    assert.notEqual(store.query()[0].message, '窗口修改');
    store.onLog = () => { throw new Error('同步通知失败'); };
    assert(store.append(entry('tools', 'fixture', '仍然可用')));
    assert.equal(store.query().length, 2);
});

test('无效筛选严格拒绝，筛选ID只用于内存比较', () => {
    const store = new RunLogStore(); store.append(entry('tools', 'fixture', 'hello'));
    for (const filter of [null, [], { engine: 'unknown' }, { id: 3 }, { id: 'untyped' }, { engine: 'tools', id: 'python:x.py' }, { path: '/sensitive' }]) assert.throws(() => store.query(filter));
    assert.deepEqual(validateLogFilter(), { engine: 'all', id: '' });
    assert.deepEqual(store.query({ id: 'tools:../../never-read-a-file' }), []);
    assert.equal(store.append({ engine: 'tools', id: 'python:x', message: '忽略' }), null);
});

test('统一宿主API汇集实时输出、隐藏来源和筛选导出，保留配置且不检查Python', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-runtime-logs-'));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const toolsDir = path.join(root, 'app', 'software'); fs.mkdirSync(toolsDir, { recursive: true });
    const pythonDir = path.join(root, 'app', 'python-software', 'shared'); fs.mkdirSync(pythonDir, { recursive: true });
    fs.writeFileSync(path.join(pythonDir, 'settings.json'), JSON.stringify({ name: '相同名称', main_file: 'run.py' }));
    fs.writeFileSync(path.join(pythonDir, 'run.py'), 'raise RuntimeError("禁止运行真实业务")');
    const pythonId = 'python:shared/run.py';
    const settings = { pythonMode: 'none', customMarker: '保留配置', pluginPreferences: { [pythonId]: { showInMainUI: false } } };
    const settingsPath = path.join(profile, 'settings.json'); fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const before = fs.readFileSync(settingsPath, 'utf8');
    const handlers = new Map(), events = [];
    let saveChoice = { canceled: true }, dialogCount = 0;
    const tools = { pluginDir: toolsDir, getPluginList: async () => [{ name: '相同名称', path: path.join(toolsDir, 'shared') }] };
    const host = createMergedHost({ app: { isPackaged: false, getPath: () => profile }, appRoot: root,
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        dialog: { showSaveDialog: async (_window, options) => { dialogCount++; assert.equal(options.defaultPath, '三人聚智-运行日志.txt'); return saveChoice; } },
        getWindow: () => null, getManager: () => tools, loadSettings: () => settings,
        saveSettings: () => { throw new Error('日志操作不得写设置'); }, refresh: async () => {}, send: (channel, record) => events.push({ channel, record })
    });
    t.after(async () => { await host.python.shutdown(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); });
    host.environment.inspect = async () => { throw new Error('日志操作不得检查Python'); };
    const invoke = (channel, ...args) => handlers.get(channel)({}, ...args);
    const initial = await invoke('runtime:logs');
    assert.equal(initial.plugins.length, 2);
    assert.equal(initial.records.length, 0);
    assert.equal(initial.plugins.find(source => source.id === pythonId).installed, true);
    host.recordToolLog({ id: 'tools:shared', name: '相同名称', stream: 'stdout', message: '效率 <输出>' });
    host.python._log(pythonId, 'stdout', 'Python 中文🌟 token=isolated-value');
    const snapshot = await invoke('runtime:logs');
    assert.equal(snapshot.records.length, 2);
    assert.equal(snapshot.records.find(record => record.engine === 'python').name, '相同名称');
    assert.equal(events.filter(event => event.channel === 'runtime:log').length, 2);
    assert.equal(events.filter(event => event.channel === 'python:log').length, 1, '保留旧Python实时协议');
    assert.equal((await invoke('python:logs', pythonId)).length, 1, '保留旧Python读取协议');
    assert.equal((await invoke('runtime:export-logs', { engine: 'python', id: pythonId })).canceled, true);
    const file = path.join(root, '筛选日志.txt'); saveChoice = { canceled: false, filePath: file };
    assert.equal((await invoke('runtime:export-logs', { engine: 'python', id: pythonId })).count, 1);
    const exported = fs.readFileSync(file, 'utf8');
    assert.match(exported, /\[Python\] \[相同名称\].*Python 中文🌟/);
    assert.equal(exported.includes('效率 <输出>'), false);
    assert.equal(exported.includes('isolated-value'), false);
    const invalid = await invoke('runtime:export-logs', { engine: 'tools', id: pythonId });
    assert.equal(invalid.success, false);
    assert.equal(dialogCount, 2, '无效筛选不能进入文件对话框');
    fs.rmSync(path.join(pythonDir, 'settings.json'));
    fs.rmSync(path.join(pythonDir, 'run.py'));
    const removed = await invoke('runtime:logs');
    assert.equal(removed.plugins.find(source => source.id === pythonId).installed, false, '移除后仍可按历史来源筛选');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(profile, 'python-plugin-configs')), false, '浏览日志不初始化插件配置');
});
