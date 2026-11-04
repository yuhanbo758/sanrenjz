const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PythonManager } = require('../app/python-manager');

const detected = spawnSync('python', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
const python = detected.status === 0 ? detected.stdout.trim() : '';
const support = path.resolve(__dirname, '../app/python-support');

function fixture(t, { configured = true } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-python-test-'));
    const plugins = path.join(root, '插件 程序');
    const userData = path.join(root, 'userdata');
    const settings = { pluginPreferences: {} };
    const manager = new PythonManager({
        pluginDir: plugins, userData, appRoot: root, loadSettings: () => settings,
        environment: { resolve: async () => {
            if (!configured) throw Object.assign(new Error('尚未配置 Python'), { code: 'PYTHON_UNCONFIGURED' });
            return { executable: python, mode: 'custom', pip: true, env: { ...process.env, PYTHONPATH: '' } };
        } }
    });
    t.after(async () => { await manager.shutdown(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    return { root, plugins, userData, settings, manager };
}

function plugin(root, name, script = 'print("hello")', extras = {}) {
    const folder = path.join(root, 'sources', name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'main.py'), script);
    fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ name, main_file: 'main.py', ...extras }));
    fs.writeFileSync(path.join(folder, 'config.json'), '{"default":true}\n');
    return folder;
}

async function until(predicate, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('等待 Python 子进程超时');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function untilProcessExited(pid) {
    await until(() => {
        try { process.kill(pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
}

async function readLaunchMarker(file) {
    let value;
    // 文件存在时Python可能尚未写完；等待完整标记，避免CI把空文件误判为启动失败。
    await until(() => {
        try {
            value = JSON.parse(fs.readFileSync(file, 'utf8'));
            return Number.isInteger(value.pid) && Number.isInteger(value.launcher);
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
            throw error;
        }
    });
    return value;
}

test('无 Python 时可以导入、列出与筛选；读取列表不初始化用户配置', async (t) => {
    const { root, userData, settings, manager } = fixture(t, { configured: false });
    const item = await manager.importPath(plugin(root, '示例'));
    assert.equal(item.id, 'python:示例/main.py');
    assert.equal(item.engine, 'python');
    assert.equal(fs.existsSync(userData), false);
    settings.pluginPreferences[item.id] = { showInMainUI: false, autoStartWithMain: true };
    assert.equal(manager.list()[0].hidden, true);
    assert.equal(manager.list()[0].autoStart, true);
    assert.equal(manager.list({ includeHidden: false }).length, 0);
    await assert.rejects(manager.run(item.id), { code: 'PYTHON_UNCONFIGURED' });
});

test('拒绝越界清单和多入口歧义；单文件导入不会复制相邻依赖', async (t) => {
    const { root, plugins, manager } = fixture(t);
    const source = plugin(root, '越界', '', { main_file: '../outside.py' });
    fs.writeFileSync(path.join(path.dirname(source), 'outside.py'), '');
    await assert.rejects(manager.importPath(source), { code: 'PLUGIN_INVALID' });
    const single = path.join(root, 'solo.py');
    fs.writeFileSync(single, '');
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'unused-package');
    const item = await manager.importPath(single);
    assert.equal(item.id, 'python:solo.py');
    assert.equal(item.requirementsPath, '');
    assert.equal(fs.existsSync(path.join(plugins, 'requirements.txt')), false);
    const ambiguous = path.join(root, 'ambiguous');
    fs.mkdirSync(ambiguous);
    fs.writeFileSync(path.join(ambiguous, 'a.py'), '');
    fs.writeFileSync(path.join(ambiguous, 'b.py'), '');
    await assert.rejects(manager.importPath(ambiguous), { code: 'PLUGIN_INVALID' });
});

test('同名导入需确认；替换保留用户配置，移除也保留配置', async (t) => {
    const { root, manager } = fixture(t);
    const source = plugin(root, 'replace');
    const first = await manager.importPath(source);
    fs.mkdirSync(path.dirname(first.configPath), { recursive: true });
    const original = '{ "retained": true }\n';
    fs.writeFileSync(first.configPath, original);
    await assert.rejects(manager.importPath(source), { code: 'PLUGIN_EXISTS' });
    fs.writeFileSync(path.join(source, 'main.py'), 'print("updated")');
    const replacement = await manager.importPath(source, { overwrite: true });
    assert.equal(replacement.id, first.id);
    assert.equal(fs.readFileSync(first.configPath, 'utf8'), original);
    assert.match(fs.readFileSync(replacement.path, 'utf8'), /updated/);
    await manager.remove(first.id);
    assert.equal(manager.list().length, 0);
    assert.equal(fs.readFileSync(first.configPath, 'utf8'), original);
});

test('新内容准备失败时保留旧插件', async (t) => {
    const { root, manager } = fixture(t);
    const source = plugin(root, 'rollback', 'print("old")');
    const item = await manager.importPath(source);
    fs.writeFileSync(path.join(source, 'main.py'), 'print("new")');
    const original = fs.cpSync;
    try {
        fs.cpSync = () => { throw new Error('模拟磁盘复制失败'); };
        await assert.rejects(manager.importPath(source, { overwrite: true }), /模拟磁盘复制失败/);
    } finally {
        fs.cpSync = original;
    }
    assert.match(fs.readFileSync(item.path, 'utf8'), /old/);
});

test('迁移后公开升级入口保留自定义 VBS/helper，拒绝新插件根之外的目录', async (t) => {
    const { root, plugins, manager } = fixture(t);
    const source = plugin(root, 'custom-helper');
    const customVbs = "' Custom standalone_launcher.py wrapper\r\nWScript.Echo \"custom\"\r\n";
    const customHelper = 'def resolve_launch(plugin):\n    return "custom behavior"\n';
    fs.writeFileSync(path.join(source, 'VBS运行.vbs'), customVbs);
    fs.writeFileSync(path.join(source, 'standalone_launcher.py'), customHelper);
    const installed = path.join(plugins, 'custom-helper');
    fs.cpSync(source, installed, { recursive: true, filter: () => true });
    const result = await manager.upgradeStandardHelpers(installed);
    assert.equal(result.updated, false);
    assert.equal(result.reason, 'custom-helper');
    assert.equal(fs.readFileSync(path.join(installed, 'VBS运行.vbs'), 'utf8'), customVbs);
    assert.equal(fs.readFileSync(path.join(installed, 'standalone_launcher.py'), 'utf8'), customHelper);
    assert.equal(fs.existsSync(path.join(installed, 'plugin_config_runtime.py')), false);
    await assert.rejects(manager.upgradeStandardHelpers(source), { code: 'PLUGIN_INVALID' });
});

test('迁移后的旧标准 VBS 升级为读取新宿主设置，来源副本保持原样', async (t) => {
    const { root, plugins, manager } = fixture(t);
    const source = plugin(root, 'old-standard');
    const oldVbs = String.raw`Option Explicit
Dim shell, fso, folder, helper, candidates, candidate, pythonExe, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
helper = folder & "\standalone_launcher.py"
If Not fso.FileExists(helper) Then
    MsgBox "Launcher missing: " & helper, vbCritical, "Launch failed"
    WScript.Quit 1
End If
' This Python runs only the stdlib launcher; the launcher selects the saved runtime.
candidates = Array(folder & "\..\..\..\python\python-3.12.8-embed-amd64\pythonw.exe", _
    folder & "\..\..\resources\python\python-3.12.8-embed-amd64\pythonw.exe", _
    folder & "\..\..\..\python\python-3.12.8-embed-amd64\python.exe", _
    folder & "\..\..\resources\python\python-3.12.8-embed-amd64\python.exe")
pythonExe = "pythonw.exe"
For Each candidate In candidates
    If fso.FileExists(candidate) Then
        pythonExe = fso.GetAbsolutePathName(candidate)
        Exit For
    End If
Next
command = Chr(34) & pythonExe & Chr(34) & " " & Chr(34) & helper & Chr(34)
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
    MsgBox "Unable to start Python: " & Err.Description, vbCritical, "Launch failed"
    WScript.Quit 1
End If
`;
    fs.writeFileSync(path.join(source, 'VBS运行.vbs'), oldVbs);
    const installed = path.join(plugins, 'old-standard');
    fs.cpSync(source, installed, { recursive: true, filter: () => true });
    const result = await manager.upgradeStandardHelpers(installed);
    assert.equal(result.updated, true);
    assert.equal(result.files.length, 3);
    assert.match(fs.readFileSync(path.join(installed, 'VBS运行.vbs'), 'utf8'), /sanrenjz\\settings\.json/);
    const helper = fs.readFileSync(path.join(installed, 'standalone_launcher.py'), 'utf8');
    assert.ok(helper.includes('sanrenjz/settings.json'));
    assert.equal(helper.includes('yuhanbopy-app'), false);
    assert.equal(fs.readFileSync(path.join(source, 'VBS运行.vbs'), 'utf8'), oldVbs);
    assert.equal((await manager.upgradeStandardHelpers(installed)).reason, 'current');
});

test('迁移多入口无清单目录跳过辅助升级，非法显式入口仍拒绝', async (t) => {
    const { plugins, manager } = fixture(t);
    const folder = path.join(plugins, 'legacy-multiple');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'a.py'), '');
    fs.writeFileSync(path.join(folder, 'b.py'), '');
    const result = await manager.upgradeStandardHelpers(folder);
    assert.equal(result.reason, 'ambiguous-entry');
    assert.equal(result.updated, false);
    assert.equal(manager.list().length, 2);
    assert.equal(fs.existsSync(path.join(folder, 'standalone_launcher.py')), false);
    fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({ main_file: '../outside.py' }));
    await assert.rejects(manager.upgradeStandardHelpers(folder), { code: 'PLUGIN_INVALID' });
});

test('实际运行使用所选解释器、统一配置和同目录模块；日志可见且做脱敏', { skip: !python }, async (t) => {
    const { root, manager } = fixture(t);
    const source = plugin(root, '运行 空格', 'import sibling, os\nprint(sibling.VALUE, flush=True)\nprint("token=do-not-log", flush=True)\nprint(os.environ["YUHANBOPY_PLUGIN_CONFIG_FILE"], flush=True)');
    fs.writeFileSync(path.join(source, 'sibling.py'), 'VALUE="sibling-loaded"');
    const item = await manager.importPath(source);
    const result = await manager.run(item.id);
    assert.equal(result.success, true);
    await until(() => manager.getLogs(item.id).some((entry) => /已退出/.test(entry.message)));
    const output = manager.getLogs(item.id).map((entry) => entry.message).join('');
    assert.match(output, /sibling-loaded/);
    assert.ok(output.includes(item.configPath));
    assert.equal(output.includes('do-not-log'), false);
    assert.equal(manager.list()[0].isRunning, false);
});

test('缺失依赖先返回确认计划，不执行插件或安装；环境标记正确跳过', { skip: !python }, async (t) => {
    const { root, manager } = fixture(t);
    const source = plugin(root, 'dependencies', 'raise RuntimeError("must not start")');
    fs.writeFileSync(path.join(source, 'requirements.txt'), 'sanrenjz-missing-test-package-931872>=9\nnot-installed; python_version < "2"\n');
    const item = await manager.importPath(source);
    const result = await manager.run(item.id);
    assert.equal(result.requiresDependencies, true);
    assert.deepEqual(result.packages, ['sanrenjz-missing-test-package-931872>=9']);
    assert.equal(manager.getLogs(item.id).length, 0);
    assert.equal(manager.list()[0].isRunning, false);
});

test('extras 依赖递归检查元数据和环境标记，基础包已装不掩盖缺失 extra', { skip: !python }, async (t) => {
    const { root, manager } = fixture(t);
    const site = path.join(root, 'fake-site');
    const distribution = (name, version, requirements = []) => {
        const folder = path.join(site, name.replace(/-/g, '_') + '-' + version + '.dist-info');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'METADATA'), ['Metadata-Version: 2.1', 'Name: ' + name, 'Version: ' + version, ...requirements.map((requirement) => 'Requires-Dist: ' + requirement), ''].join('\n'));
    };
    distribution('sanrenjz-extra-base-fixture', '1.0', [
        'sanrenjz-extra-leaf-fixture[tls]>=2; extra == "socks"',
        'sanrenjz-never-installed-fixture; python_version < "2"'
    ]);
    manager.environment.resolve = async () => ({ executable: python, pip: true, env: { ...process.env, PYTHONPATH: site, PYTHONUTF8: '1' } });
    const source = plugin(root, 'extra-dependencies');
    const requirements = path.join(source, 'requirements.txt');
    fs.writeFileSync(requirements, 'sanrenjz-extra-base-fixture[socks]>=1\n');
    const item = await manager.importPath(source);
    let plan = await manager.dependencyPlan(item.id);
    assert.deepEqual(plan.packages, ['sanrenjz-extra-base-fixture[socks]>=1']);
    distribution('sanrenjz-extra-leaf-fixture', '2.0', ['sanrenjz-extra-nested-fixture>=1; extra == "tls"']);
    plan = await manager.dependencyPlan(item.id);
    assert.equal(plan.requiresDependencies, true);
    distribution('sanrenjz-extra-nested-fixture', '1.0');
    plan = await manager.dependencyPlan(item.id);
    assert.equal(plan.requiresDependencies, false);
    assert.deepEqual(plan.packages, []);
    fs.writeFileSync(item.requirementsPath, 'sanrenjz-extra-base-fixture>=1\n');
    fs.rmSync(path.join(site, 'sanrenjz_extra_leaf_fixture-2.0.dist-info'), { recursive: true });
    assert.equal((await manager.dependencyPlan(item.id)).requiresDependencies, false);
});

test('运行中不能重复启动、替换或删除；停止终止子进程', { skip: !python }, async (t) => {
    const { root, manager } = fixture(t);
    const source = plugin(root, 'long-running', 'import time\nprint("ready", flush=True)\ntime.sleep(60)');
    const item = await manager.importPath(source);
    await manager.run(item.id);
    await assert.rejects(manager.run(item.id), { code: 'PLUGIN_RUNNING' });
    await assert.rejects(manager.remove(item.id), { code: 'PLUGIN_RUNNING' });
    await assert.rejects(manager.importPath(source, { overwrite: true }), /正在运行/);
    await manager.stop(item.id);
    await until(() => !manager.list()[0].isRunning);
    assert.ok(manager.getLogs(item.id).some((entry) => entry.message.includes('已停止')));
});

test('加密格式沿用旧协议，临时明文执行后清理，解密失败不暴露密钥', { skip: !python }, async (t) => {
    const { root, manager } = fixture(t);
    const encrypted = path.join(root, 'legacy.enc');
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(process.env.YUHANBOPY_ENC_KEY || '12345678901234567890123456789012');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    fs.writeFileSync(encrypted, Buffer.concat([iv, cipher.update('print("encrypted-compatible", flush=True)'), cipher.final()]));
    const item = await manager.importPath(encrypted);
    await manager.run(item.id);
    const temporary = manager.running.get(item.id).temporary;
    assert.equal(fs.existsSync(temporary), true);
    await until(() => manager.getLogs(item.id).some((entry) => /已退出/.test(entry.message)));
    assert.equal(fs.existsSync(temporary), false);
    assert.ok(manager.getLogs(item.id).some((entry) => /encrypted-compatible/.test(entry.message)));
    fs.writeFileSync(item.path, 'invalid-encrypted-content');
    await assert.rejects(manager.run(item.id), { code: 'PYTHON_DECRYPT_FAILED' });
    assert.equal(manager.getLogs(item.id).some((entry) => entry.message.includes(key.toString())), false);
});

test('新独立启动器只使用新 settings 与统一配置，不回退旧宿主', { skip: !python }, async (t) => {
    const { root, userData, manager } = fixture(t);
    const item = await manager.importPath(plugin(root, 'standalone'));
    fs.mkdirSync(userData, { recursive: true });
    const file = path.join(userData, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ pythonMode: 'custom', customPythonPath: python }));
    const code = 'import sys,json; sys.path.insert(0,sys.argv[1]); from standalone_launcher import resolve_launch; command,env=resolve_launch(sys.argv[2],sys.argv[3]); print(json.dumps({"command":command,"config":env["YUHANBOPY_PLUGIN_CONFIG_FILE"]}))';
    const result = spawnSync(python, ['-c', code, support, item.folderPath, file], { encoding: 'utf8', windowsHide: true, env: { ...process.env, YUHANBOPY_PLUGIN_CONFIG_FILE: '', YUHANBOPY_PLUGIN_CONFIG_DIR: '' } });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.command[0], python);
    // Windows临时目录可能使用8.3短路径；核对是否为同一个实际配置文件。
    assert.equal(fs.realpathSync(parsed.config), fs.realpathSync(item.configPath));
    fs.writeFileSync(file, JSON.stringify({ pythonMode: 'none', customPythonPath: python }));
    const missing = spawnSync(python, ['-c', code, support, item.folderPath, file], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /尚未配置 Python/);
});

test('Windows VBS → 新启动器 → 所选 Python 实际链路成功', { skip: !python || process.platform !== 'win32' }, async (t) => {
    const { root, manager } = fixture(t);
    const marker = path.join(root, 'vbs-success.txt');
    const source = plugin(root, 'VBS 空格', 'import os,pathlib,json\npathlib.Path(' + JSON.stringify(marker) + ').write_text(json.dumps({"config":os.environ["YUHANBOPY_PLUGIN_CONFIG_FILE"],"pid":os.getpid(),"launcher":os.getppid()}),encoding="utf-8")');
    const item = await manager.importPath(source);
    const appdata = path.join(root, 'appdata');
    fs.mkdirSync(path.join(appdata, 'sanrenjz'), { recursive: true });
    fs.writeFileSync(path.join(appdata, 'sanrenjz/settings.json'), JSON.stringify({ pythonMode: 'custom', customPythonPath: python }));
    const result = spawnSync('cscript.exe', ['//nologo', path.join(item.folderPath, 'VBS运行.vbs')], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, APPDATA: appdata, SANRENJZ_PYTHON_SUPPORT_DIR: support, YUHANBOPY_PLUGIN_CONFIG_FILE: '', YUHANBOPY_PLUGIN_CONFIG_DIR: '' } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const launched = await readLaunchMarker(marker);
    assert.ok(launched.config.includes('python-plugin-configs'));
    // VBS 有意非阻塞；写出标记不等于 Python 已退出，必须等待本次进程释放目录。
    await untilProcessExited(launched.pid);
    await untilProcessExited(launched.launcher);
});

test('Windows managed VBS 忽略存在但损坏的旧 custom，并用 -E 隔绝环境污染', { skip: !python || process.platform !== 'win32' }, async (t) => {
    const { root, manager } = fixture(t);
    const marker = path.join(root, 'managed-success.txt');
    const source = plugin(root, 'managed-launcher', 'import pathlib,sys,os,json\npathlib.Path(' + JSON.stringify(marker) + ').write_text(json.dumps({"executable":sys.executable,"pid":os.getpid(),"launcher":os.getppid()}),encoding="utf-8")');
    const item = await manager.importPath(source);
    const broken = path.join(root, 'broken-custom.exe');
    fs.writeFileSync(broken, 'This file exists but is not a Python executable.');
    const appdata = path.join(root, 'appdata');
    fs.mkdirSync(path.join(appdata, 'sanrenjz'), { recursive: true });
    fs.writeFileSync(path.join(appdata, 'sanrenjz/settings.json'), JSON.stringify({ customPythonPath: broken, pythonMode: 'managed', managedPythonPath: python }));
    const polluted = path.join(root, 'not-python-home');
    fs.mkdirSync(polluted);
    const result = spawnSync('cscript.exe', ['//nologo', path.join(item.folderPath, 'VBS运行.vbs')], {
        encoding: 'utf8', timeout: 10000, windowsHide: true,
        env: { ...process.env, APPDATA: appdata, PYTHONHOME: polluted, PYTHONPATH: polluted, SANRENJZ_PYTHON_SUPPORT_DIR: support, YUHANBOPY_PLUGIN_CONFIG_FILE: '', YUHANBOPY_PLUGIN_CONFIG_DIR: '' }
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const launched = await readLaunchMarker(marker);
    assert.equal(launched.executable, python);
    await untilProcessExited(launched.pid);
    await untilProcessExited(launched.launcher);
});
