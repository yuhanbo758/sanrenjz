# macOS 文本插入权限误报修复

## 同步基线

修改前通过外部 Gitea skill 的钥匙串凭据助手完成 fetch，并在独立 `.git/gitea-private.git` 中从 `082fef0` 快进到远端 `8e139f2c2c330d2ef13975e199c54fc20b6d2fd8`。更新前工作区与私有基线树相同，没有覆盖本机独有修改。私有提交没有合并到另一 Git 数据库；本次未提交、推送或发布。查询确认 Gitea 仓库为私有，Actions 关闭。

## 根因

远端最新版 `app/mac-text-insertion.js` 仍把 `stderr + error.message` 拼接后搜索 `MAC_ACCESSIBILITY`。Node `execFile` 的错误消息包含完整执行命令，而 `-e` 参数中传入的脚本源码本身就含有全部错误标记。因此，焦点恢复失败、目标退出、进程超时等失败会优先被误判为权限不足。

原测试将错误消息简化为单个错误码，没有覆盖真实命令回显。本次先加入真实非零退出子进程回归，确认旧实现失败，再修改代码。本机 JXA 真实输出带有 `execution error: Error: Error: … (-2700)`，解析已兼容重复的 Error 前缀。

## 修改

- 仅接受 stderr 中完整的预期错误行，绝不从含有命令和脚本源码的 `error.message` 推断权限。
- 分开处理权限拒绝、目标退出、焦点恢复失败、焦点变化、超时、进程信号退出、未知脚本失败及未确认输出。只有真实权限错误才显示授权指引。
- 粘贴失败继续保留剪贴板和搜索窗口；焦点恢复操作的提示不再声称正文已复制。
- 将固定字段诊断接入现有统一日志，以 `tools:host-text-insertion` 标识，显示名称“文本插入（主程序）”。记录错误码、操作类型、目标 PID、退出码、信号及原生错误编号，不记录原始命令、stderr、片段标题、正文或剪贴板内容。日志通知失败不得遮盖插入结果。
- 保持原生按键、焦点保护、忙状态、Windows 插入路径和插件清单不变。

## 验证

测试使用本机 Electron 自带 Node 18.15.0（`ELECTRON_RUN_AS_NODE=1`），没有安装依赖：

- `--test tests/mac-text-insertion.test.js`：18 项，含真实 execFile 错误、真实 macOS JXA 错误、原生事件创建（不发送）、连续五次成功/失败交替、诊断脱敏与宿主日志接线、失败后解除忙状态和跨平台 IPC。
- `--test tests/merged-run-log-store.test.js tests/merged-search-actions.test.js`：6 项，含临时配置及隐藏窗口中的真实 Electron 搜索界面、失败反馈和统一日志筛选等回归；拦截剪贴板及粘贴副作用。
- `tests/main-runtime-paths.test.js`：开发目录和安装包 extraResources 导入检查通过。
- `--check main.js`、`--check app/mac-text-insertion.js` 及相对 Gitea 同步基线的 `git diff --check` 通过。

## 验证边界与交付

本次修复已确认的错误分类缺陷，未把“重启后仅第一次成功”的底层触发点推断为已修复；新的错误类型和日志用于在真实失败时进一步定位。连续五次测试使用受控的成功/焦点失败结果，不等于五次向真实外部编辑器粘贴成功。本次未向真实用户窗口发送按键。

修复保留在项目源码，未替换 `/Applications/三人聚智.app`，未修改版本号、构建安装包或发布。此改动涉及宿主，后续发布必须安排包含本修复的新宿主版本及四目标构建验收，不能只更新文本片段插件。

后续本机打包安装、运行循环与搜索窗口生命周期修复、真实连续五次插入验收见 [2026-11-11 验收记录](macos-continuous-insertion-20261111.md)。
