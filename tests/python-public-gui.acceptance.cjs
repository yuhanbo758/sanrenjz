// 独立运行的真实 Tk 初始化验收；不加入默认测试，避免启动真实插件任务。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PythonManager } = require('../app/python-manager');
const { PythonEnvironment } = require('../app/python-environment');

const project = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const python = value('--python') || process.env.SANRENJZ_ACCEPTANCE_PYTHON;
if (!python || !fs.existsSync(python)) throw new Error('使用 --python 指定用于验收的实际 Python 解释器');
const reportPath = path.resolve(value('--report') || path.join(project, 'dist/python-public-gui-report.json'));

const PROBE = String.raw`
import json, os, pathlib, runpy, socket, subprocess, sys, tkinter as tk
from tkinter import messagebox

marker = pathlib.Path(os.environ['SANRENJZ_GUI_MARKER'])
root_directory = pathlib.Path(os.environ['SANRENJZ_GUI_SANDBOX']).resolve()
plugin = pathlib.Path(__file__).resolve().parent
result = {'ok': False, 'networkBlocked': True, 'commandsBlocked': True, 'windowsHidden': True,
          'executable': sys.executable, 'version': sys.version.split()[0], 'pluginDirectory': str(plugin),
          'configFile': os.environ.get('YUHANBOPY_PLUGIN_CONFIG_FILE', ''),
          'configDirectory': os.environ.get('YUHANBOPY_PLUGIN_CONFIG_DIR', ''), 'widgetCount': 0, 'mainloopEntered': False}
windows = []
callback_errors = []

def write_result():
    marker.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

def deny(*args, **kwargs):
    raise RuntimeError('验收探针阻止网络或外部命令')

class BlockedSocket(socket.socket):
    connect = deny
    connect_ex = deny

socket.socket = BlockedSocket
socket.create_connection = deny
subprocess.Popen = deny
subprocess.run = deny
subprocess.call = deny
os.system = deny
for name in ('showerror', 'showwarning', 'showinfo', 'askokcancel', 'askyesno', 'askquestion', 'askretrycancel', 'askyesnocancel'):
    setattr(messagebox, name, deny)

original_init = tk.Tk.__init__
original_loop = tk.Misc.mainloop

def report_callback(self, kind, error, trace):
    callback_errors.append(str(error))
    self.destroy()

def hidden_init(self, *args, **kwargs):
    original_init(self, *args, **kwargs)
    self.withdraw()
    self.report_callback_exception = lambda *error: report_callback(self, *error)
    windows.append(self)

def count_widgets(widget):
    return sum(1 + count_widgets(child) for child in widget.winfo_children())

def probe_mainloop(self, *args, **kwargs):
    self.withdraw()
    self.update_idletasks()
    result['windowsHidden'] = result['windowsHidden'] and self.state() == 'withdrawn' and not self.winfo_viewable()
    result['mainloopEntered'] = True
    result['widgetCount'] += count_widgets(self)
    self.after(180, self.destroy)
    original_loop(self, *args, **kwargs)
    if callback_errors:
        raise RuntimeError('初始化回调失败：' + '; '.join(callback_errors))

tk.Tk.__init__ = hidden_init
tk.Misc.mainloop = probe_mainloop

try:
    config = pathlib.Path(result['configFile']).resolve()
    if not config.is_relative_to(root_directory):
        raise RuntimeError('验收配置不在临时目录')
    runpy.run_path(str(plugin / ORIGINAL_ENTRY), run_name='__main__')
    if not result['mainloopEntered'] or result['widgetCount'] == 0:
        raise RuntimeError('未发现完整 Tk 界面初始化')
    if not result['windowsHidden']:
        raise RuntimeError('验收窗口未保持隐藏')
    result['ok'] = True
except BaseException as error:
    result['error'] = type(error).__name__ + ': ' + str(error)
    raise
finally:
    for window in windows:
        try:
            window.destroy()
        except tk.TclError:
            pass
    write_result()
`;

async function waitFor(predicate, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('隐藏 GUI 初始化验收超时');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

(async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sanrenjz-public-gui-'));
    const userData = path.join(sandbox, 'userdata');
    const pluginDir = path.join(sandbox, 'python-plugins');
    const settings = { pythonMode: 'custom', customPythonPath: path.resolve(python), pluginPreferences: {} };
    const environment = new PythonEnvironment({
        userData, appRoot: project, loadSettings: () => settings,
        saveSettings: (next) => Object.assign(settings, next),
        baseEnv: { ...process.env, TEMP: sandbox, TMP: sandbox, HOME: sandbox, USERPROFILE: sandbox, APPDATA: path.join(sandbox, 'appdata') }
    });
    let currentMarker = '';
    const manager = new PythonManager({
        pluginDir, userData, appRoot: project, loadSettings: () => settings,
        environment: { resolve: async () => {
            const runtime = await environment.resolve();
            return { ...runtime, env: { ...runtime.env, SANRENJZ_GUI_MARKER: currentMarker, SANRENJZ_GUI_SANDBOX: sandbox } };
        } }
    });
    const report = { checkedAt: new Date().toISOString(), mode: 'hidden-gui-initialization', runtime: null,
        guardrails: { temporaryCopiesOnly: true, networkingBlockedInProbe: true, externalCommandsBlockedInProbe: true, noButtonClicks: true },
        plugins: [], allPassed: false, remainingManagedProcesses: null, sandboxRemoved: false };
    try {
        const inspected = await environment.inspect(path.resolve(python), { hiddenTk: true });
        report.runtime = { executable: inspected.executable, version: inspected.version, architecture: inspected.architecture, bitness: inspected.bitness, pip: inspected.pip, tk: inspected.tk };
        for (const name of ['cos_downloader', 'file_downloader', 'github_downloader', 'terminal']) {
            const source = path.join(project, 'app/python-software', name);
            const prepared = path.join(sandbox, 'sources', name);
            fs.cpSync(source, prepared, { recursive: true, filter: (file) => !['__pycache__', '.legacy-configs'].includes(path.basename(file)) && !file.endsWith('.log') });
            const metadataFile = path.join(prepared, 'settings.json');
            const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
            const original = metadata.main_file;
            metadata.main_file = '__gui_acceptance_probe__.py';
            fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
            fs.writeFileSync(path.join(prepared, metadata.main_file), 'ORIGINAL_ENTRY = ' + JSON.stringify(original) + '\n' + PROBE, 'utf8');
            currentMarker = path.join(sandbox, name + '-result.json');
            const item = await manager.importPath(prepared);
            const started = await manager.run(item.id);
            if (!started.success) throw new Error(`${name} 未成功启动：${JSON.stringify(started)}`);
            await waitFor(() => fs.existsSync(currentMarker));
            await waitFor(() => !manager.running.has(item.id));
            const evidence = JSON.parse(fs.readFileSync(currentMarker, 'utf8'));
            const logs = manager.getLogs(item.id);
            report.plugins.push({ name, id: item.id, ...evidence, exited: true,
                selectedInterpreterMatches: path.resolve(evidence.executable).toLowerCase() === path.resolve(python).toLowerCase(),
                stderr: logs.filter((entry) => entry.stream === 'stderr').map((entry) => entry.message).join('').slice(-4000) });
            if (!evidence.ok) throw new Error(`${name} 初始化失败：${evidence.error}`);
        }
        report.allPassed = report.plugins.length === 4 && report.plugins.every((item) => item.ok && item.selectedInterpreterMatches && item.exited);
    } catch (error) {
        report.error = error.message;
        process.exitCode = 1;
    } finally {
        await manager.shutdown();
        report.remainingManagedProcesses = manager.running.size;
        fs.rmSync(sandbox, { recursive: true, force: true });
        report.sandboxRemoved = !fs.existsSync(sandbox);
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
        console.log(JSON.stringify({ allPassed: report.allPassed, plugins: report.plugins.map((item) => ({ name: item.name, ok: item.ok, widgets: item.widgetCount })), remainingManagedProcesses: report.remainingManagedProcesses, report: reportPath, error: report.error }));
    }
})();
