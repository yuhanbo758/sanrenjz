import argparse
import ctypes
import os
import runpy
import sys


def configure_windows_identity(app_id):
    if sys.platform != "win32" or not app_id:
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception:
        pass


def apply_macos_icon(image_path):
    """只读加载已有 PNG/ICO/ICNS；无需 PyObjC、转换图片或生成应用包。"""
    if sys.platform != "darwin" or not image_path or not os.path.isfile(image_path):
        return False
    try:
        ctypes.CDLL('/System/Library/Frameworks/AppKit.framework/AppKit')
        objc = ctypes.CDLL('/usr/lib/libobjc.A.dylib')
        pointer = ctypes.c_void_p
        objc.objc_getClass.argtypes = [ctypes.c_char_p]
        objc.objc_getClass.restype = pointer
        objc.sel_registerName.argtypes = [ctypes.c_char_p]
        objc.sel_registerName.restype = pointer

        def send(result, receiver, selector, *args):
            function = ctypes.CFUNCTYPE(result, pointer, pointer, *([pointer] * len(args)))(('objc_msgSend', objc))
            return function(receiver, objc.sel_registerName(selector.encode('ascii')), *args)

        filename = send(pointer, objc.objc_getClass(b'NSString'), 'stringWithUTF8String:', ctypes.cast(ctypes.c_char_p(os.fsencode(image_path)), pointer))
        image = send(pointer, objc.objc_getClass(b'NSImage'), 'alloc')
        image = send(pointer, image, 'initWithContentsOfFile:', filename)
        if not image:
            return False
        try:
            application = send(pointer, objc.objc_getClass(b'NSApplication'), 'sharedApplication')
            send(None, application, 'setApplicationIconImage:', image)
        finally:
            send(None, image, 'release')
        return True
    except Exception:
        # 图标加载失败保留 Tk/宿主默认图像，不能阻断插件启动。
        return False


def install_tkinter_icon(logo_path, icon_path, mac_icon_path=""):
    if not any(path and os.path.isfile(path) for path in (logo_path, icon_path, mac_icon_path)):
        return
    try:
        import tkinter as tk
    except Exception:
        return

    original_init = tk.Tk.__init__

    def patched_init(window, *args, **kwargs):
        original_init(window, *args, **kwargs)
        # PNG 负责窗口图像，ICO 同时设置默认类图标和当前窗口图标；两者缺一时
        # Windows 任务栏可能继续显示 python.exe 的通用图标。
        photo_applied = False
        try:
            if logo_path and os.path.isfile(logo_path) and not logo_path.lower().endswith(".ico"):
                image = tk.PhotoImage(file=logo_path)
                window.iconphoto(True, image)
                window._yuhanbopy_plugin_logo = image
                photo_applied = True
        except Exception:
            pass
        if sys.platform == "darwin":
            image_path = mac_icon_path or logo_path or icon_path
            if image_path != logo_path or not photo_applied:
                apply_macos_icon(image_path)
                # Tk 完成初始化后再次应用仅 ICO/ICNS 插件的原生回退。
                window.after_idle(lambda: apply_macos_icon(image_path))
        if sys.platform == "win32" and icon_path and os.path.isfile(icon_path):
            try:
                window.iconbitmap(default=icon_path)
                window.iconbitmap(icon_path)
                window._yuhanbopy_plugin_icon = icon_path
            except Exception:
                pass

    tk.Tk.__init__ = patched_init


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--script", required=True)
    parser.add_argument("--logo", default="")
    parser.add_argument("--icon", default="")
    parser.add_argument("--mac-icon", default="")
    parser.add_argument("--app-id", default="")
    parser.add_argument("--config", default="")
    parser.add_argument("--config-dir", default="")
    parser.add_argument("--plugin-dir", default="")
    options, plugin_args = parser.parse_known_args()

    script_dir = os.path.dirname(os.path.abspath(options.script))
    if not options.config and not os.environ.get('YUHANBOPY_PLUGIN_CONFIG_FILE'):
        from plugin_config_runtime import initialize_config
        initialize_config(script_dir)

    configure_windows_identity(options.app_id)
    if options.config:
        os.environ["YUHANBOPY_PLUGIN_CONFIG_FILE"] = os.path.abspath(options.config)
    if options.config_dir:
        os.environ["YUHANBOPY_PLUGIN_CONFIG_DIR"] = os.path.abspath(options.config_dir)
    install_tkinter_icon(options.logo, options.icon, options.mac_icon)
    # run_path 不会添加脚本目录；优先加载插件同目录模块，保持与直接运行脚本一致。
    sys.path.insert(0, script_dir)
    if options.plugin_dir:
        sys.path.insert(0, os.path.abspath(options.plugin_dir))
    sys.argv = [options.script, *plugin_args]
    runpy.run_path(options.script, run_name="__main__")


if __name__ == "__main__":
    main()
