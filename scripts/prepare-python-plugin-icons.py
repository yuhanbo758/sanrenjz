"""显式制作/修复 Python 插件的 PNG 资源；宿主启动与导入不会调用此脚本。"""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile


def prepare(folder, apply=False):
    if folder.is_symlink() or not folder.is_dir():
        raise ValueError("插件目录不能是链接")
    png = folder / "logo.png"
    if png.exists():
        return "existing"
    ico = folder / "logo.ico"
    if not ico.is_file() or ico.is_symlink():
        return "missing"
    if not apply:
        return "needs-png"
    # 只补缺少的图片；先完整验证临时产物，既有图标及配置均不覆盖。
    with tempfile.TemporaryDirectory(prefix="sanrenjz-plugin-icon-") as temporary:
        output = Path(temporary) / "logo.png"
        if sys.platform == "darwin":
            subprocess.run(["/usr/bin/sips", "-s", "format", "png", str(ico), "--out", str(output)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        else:
            from PIL import Image  # 仅制作工具需要 Pillow；不自动安装依赖。
            with Image.open(ico) as image:
                image.save(output, format="PNG")
        data = output.read_bytes()
        if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or not all(struct.unpack(">II", data[16:24])):
            raise ValueError("转换未产生有效 PNG")
        with png.open("xb") as destination:
            destination.write(data)
    return "created"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="单插件目录或插件集合")
    parser.add_argument("--apply", action="store_true", help="补齐 PNG；默认只检查")
    args = parser.parse_args()
    root = args.root.absolute()
    if root.is_symlink():
        parser.error("拒绝链接目录")
    folders = [root] if (root / "settings.json").is_file() else sorted(
        item for item in root.iterdir() if item.is_dir() and not item.is_symlink() and (item / "settings.json").is_file())
    failed = False
    for folder in folders:
        try:
            status = prepare(folder, args.apply)
        except Exception as error:
            failed = True
            status = "error:" + type(error).__name__
        print(json.dumps({"plugin": folder.name, "status": status}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
