"""业务项目内的统一凭据查询入口。

本文件由 password-manager skill 嵌入项目。业务代码只能调用这里公开的函数，
不得自行连接凭据数据库，也不得在源码中写入真实账号或密码。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


# 中央 skill 位于当前 Windows 用户的 Codex skills 目录，不依赖环境变量。
_MANAGER_SCRIPT = (
    Path.home() / ".codex" / "skills" / "password-manager" / "scripts" / "password_manager.py"
)
_manager_module: ModuleType | None = None


def _load_manager() -> ModuleType:
    """加载中央密码管理模块；只缓存代码模块，不缓存任何解密后的凭据。"""

    global _manager_module
    if _manager_module is not None:
        return _manager_module
    if not _MANAGER_SCRIPT.is_file():
        raise RuntimeError(f"未找到 password-manager skill：{_MANAGER_SCRIPT}")

    spec = importlib.util.spec_from_file_location("codex_password_manager_runtime", _MANAGER_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 password-manager skill")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _manager_module = module
    return module


def check_account(
    column_name: str,
    project_name: str,
    account_name: str = "default",
) -> str:
    """运行时查询 username 或 password，调用习惯兼容 yuhanboxl.check_account。"""

    field = column_name.strip().lower()
    if field not in {"username", "password"}:
        raise ValueError("column_name 只允许 username 或 password")
    manager = _load_manager()
    return manager.check_account(field, project_name, account_name)


def get_login_credentials(
    project_name: str,
    account_name: str = "default",
) -> tuple[str, str]:
    """一次查询并返回登录所需的用户名和密码，避免重复访问数据库。"""

    manager = _load_manager()
    credential = manager.get_credential(project_name, account_name)
    return str(credential["username"]), str(credential["password"])
