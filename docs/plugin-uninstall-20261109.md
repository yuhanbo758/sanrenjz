# 设置页插件卸载

## 行为与范围

- “设置 → 插件管理”在每行名称旁常显“卸载”，效率插件与 Python 插件使用同一入口；确认框展示实际删除路径和范围。
- 按统一稳定 ID 定位插件，删除实际插件目录及其中的 `.runtime`；独立 Python 脚本只删除自身。插件程序目录之外的配置与用户数据保留。
- 运行或启动中的插件须先关闭。同一 Python 目录有多个入口时，任一入口运行或启动中均阻止整目录卸载。
- 主进程校验目标是插件根的直接子项，并拒绝目录联接与越界路径。异步删除期间阻止重复卸载与再次启动，失败显示原因并恢复重试按钮。
- 卸载记录位于实际插件根的 `.uninstalled/`，文件名为插件标识的 SHA256，内容为空。先写记录再删文件，记录写入失败不删插件；删除部分失败仍保留记录，避免下次启动补齐旧包。
- 内置补齐读取卸载记录，重启不重新安装已卸载插件；用户仍可通过导入或商店主动重装。效率插件主动重装后仍可接受正常内置更新。
- 卸载后刷新管理、主页面、快捷搜索和超级面板目录。独立用户偏好保留。

## 涉及模块

- `index.html`、`merged-ui.css`：常显按钮、确认、忙碌及失败状态、响应式布局。
- `app/plugin-uninstall.js`：共享路径校验、删除锁、卸载记录与异步删除。
- `app/software_manager.js`、`app/python-manager.js`：两类插件定位及运行保护。
- `app/plugin_store.js`、`app/merged-host.js`：尊重卸载记录，统一刷新。
- `tests/merged-plugin-management*.js` / `.cjs`：父进程分配隔离目录，子进程退出后再清理。

## 验证

已通过：

```powershell
node --test tests/merged-plugin-uninstall.test.js tests/merged-plugin-management.test.js
node tests/plugin-store.test.js
node tests/plugin-management.test.js
node --test tests/python-manager.test.js tests/merged-settings-persistence.test.js tests/merged-settings-polish.test.js tests/merged-save-settings-effects.test.js tests/migration-plugin-import.test.js
```

共享卸载逻辑覆盖目录删除、独立数据保留、越界和联接拒绝、写入/删除失败、重复卸载/启动保护、多入口运行保护及安装态 Python 重启补齐。隐藏 Electron 使用临时合成插件验证取消、失败重试、两类插件卸载、跨类型及同类型同名保护、主页面与搜索刷新和两种窗口尺寸；没有执行真实插件业务。

截图及报告位于本地 `dist/merged-plugin-management-validation/`，控制台记录为 `dist/merged-plugin-management-console.log`。未改版本、未打包发布、未替换安装版或删除真实插件。
