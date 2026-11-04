"""三人聚智插件独立启动：只使用新宿主保存的解释器，不访问旧产品配置。"""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback


def resolve_launch(plugin, settings_file=None):
    plugin = Path(plugin).resolve()
    appdata = Path(os.environ.get('APPDATA') or Path.home() / '.config')
    settings_file = Path(settings_file or os.environ.get('SANRENJZ_SETTINGS_FILE') or appdata / 'sanrenjz/settings.json')
    settings = json.loads(settings_file.read_text(encoding='utf-8-sig')) if settings_file.is_file() else {}
    mode = settings.get('pythonMode', 'none')
    saved = settings.get('customPythonPath') if mode == 'custom' else settings.get('managedPythonPath') if mode == 'managed' else ''
    if not saved:
        raise FileNotFoundError('尚未配置 Python，请打开三人聚智，在设置中选择或安装 Python 环境')
    executable = Path(saved)
    if not executable.is_file():
        raise FileNotFoundError('三人聚智保存的 Python 已失效，请在设置中重新选择')
    if executable.name.lower() == 'pythonw.exe' and executable.with_name('python.exe').is_file():
        executable = executable.with_name('python.exe')
    environment = dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONUTF8='1')
    for key in ('PYTHONHOME', 'PYTHONPATH', 'TCL_LIBRARY', 'TK_LIBRARY', 'VIRTUAL_ENV', 'CONDA_PREFIX'):
        environment.pop(key, None)
    prefix = executable.parent
    environment['PATH'] = os.pathsep.join(map(str, [prefix, prefix / 'Scripts', prefix / 'Library/bin', prefix / 'DLLs'])) + os.pathsep + environment.get('PATH', '')
    environment['SANRENJZ_SETTINGS_FILE'] = str(settings_file)
    environment['SANRENJZ_PYTHON_PLUGIN_DIR'] = str(plugin.parent)
    environment['SANRENJZ_PLUGIN_DIRECTORY'] = str(plugin)
    metadata = json.loads((plugin / 'settings.json').read_text(encoding='utf-8-sig'))
    entry = (plugin / metadata['main_file']).resolve()
    if not entry.is_relative_to(plugin) or entry.suffix.lower() != '.py' or not entry.is_file():
        raise ValueError('独立启动需要插件目录内存在的明文 .py 入口')
    # 先解析统一配置，再运行插件；随包运行时的优先级高于系统同名模块。
    sys.path.insert(0, str(plugin))
    from plugin_config_runtime import initialize_config, get_config_directory
    os.environ.pop('YUHANBOPY_PLUGIN_CONFIG_FILE', None)
    os.environ.pop('YUHANBOPY_PLUGIN_CONFIG_DIR', None)
    config = initialize_config(plugin, settings_file)
    environment['YUHANBOPY_PLUGIN_CONFIG_FILE'] = config
    environment['YUHANBOPY_PLUGIN_CONFIG_DIR'] = get_config_directory()
    support = os.environ.get('SANRENJZ_PYTHON_SUPPORT_DIR')
    candidates = ([Path(support) / 'plugin_bootstrap.py'] if support else []) + [
        plugin.parents[1] / 'app/python-support/plugin_bootstrap.py',
        plugin.parents[1] / 'resources/app/python-support/plugin_bootstrap.py',
        plugin.parents[1] / 'python-support/plugin_bootstrap.py']
    bootstrap = next((file for file in candidates if file.is_file()), None)
    command = [str(executable)]
    if bootstrap:
        command += [str(bootstrap), '--script', str(entry), '--plugin-dir', str(plugin),
                    '--config', config, '--config-dir', get_config_directory(),
                    '--logo', str(plugin / 'logo.png'), '--icon', str(plugin / 'logo.ico'),
                    '--app-id', 'com.sanrenjz.python.plugin.' + plugin.name.lower().replace('_', '.')]
    else:
        command.append(str(entry))
    return command, environment


def show_error(message):
    if os.name == 'nt':
        ctypes.windll.user32.MessageBoxW(None, message, '三人聚智插件启动失败', 0x10)
    else:
        print(message, file=sys.stderr)


def launch(plugin=None, settings_file=None):
    plugin = Path(plugin or Path(__file__).resolve().parent)
    directory = Path(tempfile.gettempdir()) / 'sanrenjz-python-startup'
    directory.mkdir(parents=True, exist_ok=True)
    fd, log_name = tempfile.mkstemp(prefix='startup-', suffix='.log', dir=directory)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        try:
            command, environment = resolve_launch(plugin, settings_file)
            output.write('Python: ' + command[0] + '\nPlugin: ' + str(plugin) + '\n')
            output.flush()
            child = subprocess.run(command, cwd=str(plugin), env=environment, stdout=output, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            if child.returncode:
                raise RuntimeError('插件退出异常，请查看诊断日志')
            return 0
        except Exception:
            traceback.print_exc(file=output)
    show_error('插件启动失败，诊断日志：\n' + log_name)
    return 1


if __name__ == '__main__':
    raise SystemExit(launch())
