const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMergedHost, publicRuntime } = require('../app/merged-host');

test('统一IPC实际导入三类插件，同名分引擎运行、隐藏及配置环境投影', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-host-'));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const toolsDir = path.join(root, 'app', 'software'); fs.mkdirSync(toolsDir, { recursive: true });
    let settings = { pythonMode: 'none' }, selected = [], failRefresh = false;
    const handlers = new Map();
    const tools = { pluginDir: toolsDir, pluginWindows: new Map(), pluginProcesses: new Map(), getPluginList: async () => fs.readdirSync(toolsDir).filter(n => !n.startsWith('.')).map(n => ({ name: JSON.parse(fs.readFileSync(path.join(toolsDir,n,'plugin.json'))).pluginName, path: path.join(toolsDir,n), description: 'tool' })), runPlugin: async p => { selected.push(p); } };
    tools.getPluginManagementList = async () => (await tools.getPluginList()).map(plugin => ({
        ...plugin, pluginSettings: { autoSeparate: true, exitOnBackground: false, pushToSearch: true,
            showInMainUI: settings.pluginPreferences?.[plugin.name]?.showInMainUI !== false,
            autoStartWithMain: settings.pluginPreferences?.[plugin.name]?.autoStartWithMain === true }
    }));
    const dialogs = [];
    const host = createMergedHost({ app: { isPackaged: false, getPath: () => profile }, appRoot: root, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: dialogs.shift() }), showMessageBox: async () => ({ response: 0 }) }, getWindow: () => null, getManager: () => tools, loadSettings: () => settings,
        saveSettings: value => { settings = { ...settings, ...value }; fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings), 'utf8'); },
        refresh: async () => { if (failRefresh) throw new Error('模拟目录刷新失败'); }, send: () => {} });
    const invoke = (key,...args) => handlers.get(key)({},...args);
    try {
        assert.equal((await invoke('python:status')).configured, false);
        const source = path.join(root, 'source'); fs.mkdirSync(source);
        const file = path.join(source, '示例.py'); fs.writeFileSync(file, 'print("ok")');
        const plugin = path.join(source,'配套插件'); fs.mkdirSync(plugin); fs.writeFileSync(path.join(plugin,'settings.json'),JSON.stringify({ name:'相同名称',main_file:'run.py' })); fs.writeFileSync(path.join(plugin,'run.py'),'print("ok")');
        const tool = path.join(source,'tool'); fs.mkdirSync(tool); fs.writeFileSync(path.join(tool,'plugin.json'),JSON.stringify({ pluginName:'相同名称',main:'index.html' })); fs.writeFileSync(path.join(tool,'index.html'),'<p>ok</p>');
        for (const [kind,p] of [['python-file',file],['python-folder',plugin],['tools-folder',tool]]) { dialogs.push([p]); assert.equal((await invoke('unified:import',kind)).success,true); }
        const list = await invoke('unified:list'); assert.equal(list.length,3); assert.equal(new Set(list.map(p=>p.id)).size,3);
        const py = list.find(p=>p.engine==='python' && p.name==='相同名称'), js = list.find(p=>p.engine==='tools');
        const management = await host.managementList();
        assert.equal(management.length, 3);
        assert.equal(new Set(management.map(item => item.id)).size, 3, '跨类型同名保留稳定且独立的 ID');
        assert.deepEqual(management.find(item => item.id === js.id).pluginSettings,
            { autoSeparate: true, exitOnBackground: false, pushToSearch: true, showInMainUI: true, autoStartWithMain: false }, '效率插件附加选项继续保留');
        assert.deepEqual(management.find(item => item.id === py.id).pluginSettings,
            { showInMainUI: true, autoStartWithMain: false }, 'Python 仅提供有效通用管理选项');
        await invoke('unified:run',js.id); assert.equal(selected.length,1);
        assert.equal((await invoke('unified:run',py.id)).code,'PYTHON_UNCONFIGURED');
        await invoke('unified:preference',py.id,'showInMainUI',false);
        assert.equal((await invoke('unified:list')).length,2);
        assert.equal((await host.searchEntries()).length,2);
        assert.equal(settings.pluginPreferences[py.id].showInMainUI,false);
        const hiddenManagement = await host.managementList();
        assert.equal(hiddenManagement.length, 3, '管理列表始终包含隐藏的 Python 程序');
        assert.equal(hiddenManagement.find(item => item.id === py.id).pluginSettings.showInMainUI, false);
        failRefresh = true;
        const savedWithWarning = await invoke('unified:preference', py.id, 'autoStartWithMain', true);
        assert.equal(savedWithWarning.success, true, '落盘成功后刷新异常不应报告保存失败');
        assert.match(savedWithWarning.warning, /已保存.*刷新失败/);
        const diskSettings = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
        assert.equal(diskSettings.pluginPreferences[py.id].autoStartWithMain, true, '刷新失败仍保留成功写入的磁盘偏好');
        assert.equal(diskSettings.pluginPreferences[py.id].showInMainUI, false, '刷新失败不改变其他偏好');
        assert.equal((await host.managementList()).find(item => item.id === py.id).pluginSettings.autoStartWithMain, true);
        failRefresh = false;
        assert.equal(fs.existsSync(path.join(profile,'python-plugin-configs')),false);
        const safe = publicRuntime({ executable:'python.exe',version:'3.14.10',env:{ SECRET_TOKEN:'do-not-send' } });
        assert.equal(JSON.stringify(safe).includes('SECRET_TOKEN'),false);
    } finally { await host.python.shutdown(); fs.rmSync(root,{recursive:true,force:true}); }
});
