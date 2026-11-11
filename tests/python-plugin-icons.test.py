import ctypes
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'app/python-support'))
import plugin_bootstrap


class IconTests(unittest.TestCase):
    def test_platform_specific_bitmap_and_retained_png(self):
        with tempfile.TemporaryDirectory(prefix='sanrenjz-icon-test-') as temporary:
            png, ico = Path(temporary) / 'logo.png', Path(temporary) / 'logo.ico'
            png.touch(); ico.touch()
            for platform in ('darwin', 'linux', 'win32'):
                calls = []

                class Window:
                    def __init__(self):
                        pass

                    def iconphoto(self, *args):
                        calls.append(('photo', args))

                    def iconbitmap(self, *args, **kwargs):
                        calls.append(('bitmap', args))

                    def after_idle(self, callback):
                        callback()

                class TkModule:
                    Tk = Window
                    PhotoImage = staticmethod(lambda **kwargs: object())

                with patch.dict(sys.modules, {'tkinter': TkModule}), patch.object(sys, 'platform', platform), patch.object(plugin_bootstrap, 'apply_macos_icon', return_value=True):
                    plugin_bootstrap.install_tkinter_icon(str(png), str(ico))
                    window = Window()
                self.assertTrue(hasattr(window, '_yuhanbopy_plugin_logo'))
                self.assertEqual(sum(call[0] == 'bitmap' for call in calls), 2 if platform == 'win32' else 0)

    @unittest.skipUnless(sys.platform == 'darwin', '需要 Mac 原生图像转换')
    def test_explicit_preparation_preserves_existing_resources(self):
        spec = importlib.util.spec_from_file_location('prepare_icons', ROOT / 'scripts/prepare-python-plugin-icons.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='sanrenjz-icon-prepare-') as temporary:
            folder = Path(temporary)
            shutil.copyfile(ROOT / 'app/software/sanrenjz-tools-text/logo.ico', folder / 'logo.ico')
            original = (folder / 'logo.ico').read_bytes()
            self.assertEqual(module.prepare(folder), 'needs-png')
            self.assertFalse((folder / 'logo.png').exists())
            self.assertEqual(module.prepare(folder, True), 'created')
            png = (folder / 'logo.png').read_bytes()
            self.assertTrue(png.startswith(b'\x89PNG\r\n\x1a\n'))
            self.assertEqual(module.prepare(folder, True), 'existing')
            self.assertEqual((folder / 'logo.png').read_bytes(), png)
            self.assertEqual((folder / 'logo.ico').read_bytes(), original)

    @unittest.skipUnless(sys.platform == 'darwin', '需要真实 Mac Tk 与 Cocoa')
    def test_real_bootstrap_sets_native_dock_image(self):
        # 单独子进程创建隐藏 Tk 窗口；只读测试图片，无网络和业务代码。
        script = r'''
import ctypes,json,tkinter as tk
r=tk.Tk();r.withdraw();r.update_idletasks()
objc=ctypes.CDLL('/usr/lib/libobjc.A.dylib')
p=ctypes.c_void_p
objc.objc_getClass.restype=p;objc.objc_getClass.argtypes=[ctypes.c_char_p]
objc.sel_registerName.restype=p;objc.sel_registerName.argtypes=[ctypes.c_char_p]
def send(ret,receiver,selector,*args):
    function=ctypes.CFUNCTYPE(ret,p,p,*([p]*len(args)))(('objc_msgSend',objc))
    return function(receiver,objc.sel_registerName(selector.encode()),*args)
application=send(p,objc.objc_getClass(b'NSApplication'),'sharedApplication')
image=send(p,application,'applicationIconImage')
data=send(p,image,'TIFFRepresentation')
rep=send(p,objc.objc_getClass(b'NSBitmapImageRep'),'imageRepWithData:',data)
print(json.dumps({'tk':[r._yuhanbopy_plugin_logo.width(),r._yuhanbopy_plugin_logo.height()],
                  'dock':[send(ctypes.c_long,rep,'pixelsWide'),send(ctypes.c_long,rep,'pixelsHigh')]}))
r.destroy()
'''
        with tempfile.TemporaryDirectory(prefix='sanrenjz-native-tk-icon-') as temporary:
            folder = Path(temporary)
            (folder / 'main.py').write_text(script, encoding='utf-8')
            result = subprocess.run([sys.executable, '-B', str(ROOT / 'app/python-support/plugin_bootstrap.py'),
                                     '--script', str(folder / 'main.py'), '--config', str(folder / 'config.json'),
                                     '--logo', str(ROOT / 'app/software/sanrenjz-tools-text/logo.png'),
                                     '--icon', str(ROOT / 'app/software/sanrenjz-tools-text/logo.ico')],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            dimensions = json.loads(result.stdout)
            self.assertEqual(dimensions['tk'], dimensions['dock'])
            self.assertGreater(dimensions['dock'][0], 0)
            # 模拟未来只有 ICO 的迁入插件：Tk 使用宿主 PNG 回退，Dock 仍应加载插件 ICO。
            command = [sys.executable, '-B', str(ROOT / 'app/python-support/plugin_bootstrap.py'),
                       '--script', str(folder / 'main.py'), '--config', str(folder / 'config.json'),
                       '--logo', str(ROOT / 'build/icon.png'),
                       '--mac-icon', str(ROOT / 'app/software/sanrenjz-tools-text/logo.ico')]
            ico_result = subprocess.run(command, capture_output=True, text=True, timeout=15)
            self.assertEqual(ico_result.returncode, 0, ico_result.stderr)
            ico_dimensions = json.loads(ico_result.stdout)
            self.assertEqual(ico_dimensions['tk'], [1024, 1024])
            self.assertEqual(ico_dimensions['dock'], [256, 256])


if __name__ == '__main__':
    unittest.main()
