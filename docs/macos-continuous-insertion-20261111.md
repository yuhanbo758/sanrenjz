# macOS 连续插入修复与本机安装验收

## 交付

- 本机版本：0.1.13，原生 arm64，安装到 `/Applications/三人聚智.app`。
- 基于已拉取的 Gitea `8e139f2` 工作区及上一轮权限误报修复；本次获得本地打包、安装和继续修复授权，未提交、推送或发布远端 Release。
- 最终构建：`dist/public-package-1794353536292-23341`；通过项目 `scripts/package-local.js --mac --arm64 --publish never` 生成 DMG、ZIP，并完成实际产物范围审计（6052 个文件）。
- 使用官方 Node 22.21.1 arm64 构建运行时，下载 SHA256 与 Node 官方清单相符。原应用和诊断版备份保留于 `/Applications/.sanrenjz-local-20261111/`；用户数据、插件和 Python 配置目录未替换。
- 安装包为 ad-hoc 本地签名，未公证。严格深度签名验证通过，安装版主程序、搜索页面、原生插入模块与最终源码逐字节一致，架构及 Info.plist 版本核验通过。
- 最终 DMG SHA256：`eb66c0ae6de64c4b15f7ec5c564c3e0b63034816172d1adcd44d415c632712cf`。

## 修复的缺陷

上一轮已修复 `execFile.error.message` 包含完整脚本、导致所有失败被误报为权限不足的问题。本次继续修复两处可导致连续使用失败的缺陷：

1. 原 JXA 在请求应用激活后，用 `NSThread.sleepForTimeInterval` 阻塞轮询前台应用。Apple 说明 `NSRunningApplication` 可变状态要等主运行循环处理后才更新；激活返回成功也只表示请求已发送。阻塞轮询可能一直读取旧状态，造成错误的焦点超时。现改为处理 `NSRunLoop`，同时以真实时间控制 1.5 秒激活预算和 120 毫秒稳定等待；保留粘贴前最后一次 PID 核验。`runUntilDate` 提前返回也不会使预算提前耗尽。
2. 搜索窗口的 blur/closed 回调原先访问全局 `searchWindow`，旧原生窗口的延迟事件可能关闭或清空后来创建的新窗口，并重置其钉住状态。现将回调绑定创建时的窗口，并核对其仍是当前窗口。

新增测试分别在旧实现上失败、修复后通过。这些缺陷与首次成功后再次使用失败的现象相符；旧版通用权限提示没有保留实际错误，不把历史每次失败都断言为同一触发点。

依据：[Apple NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication?language=objc)、[Apple Run Loop Management](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/RunLoopManagement/RunLoopManagement.html)。本机 SDK 对应证据为 `NSRunningApplication.h:54,146`、`NSThread.h:66`、`NSRunLoop.h:120,124`。

## 自动验证

- `tests/mac-text-insertion.test.js`：23 项通过，包括真实 execFile、真实 macOS JXA 错误与无按键桥接检查、运行循环缓存/提前返回/焦点变化、旧窗口延迟事件、忙状态及日志脱敏。
- `tests/merged-run-log-store.test.js`、`tests/merged-search-actions.test.js`：6 项通过，临时配置、隐藏 Electron 窗口，拦截实际剪贴板及粘贴副作用。
- 合计 29 项通过；开发/安装资源布局导入、JavaScript 语法、相对私有基线的 `git diff --check` 通过。

## 真实安装包验收

自动化定向键盘事件不能触发系统全局快捷键，因此由用户在 TextEdit 临时文档中操作实体 Alt+空格；搜索、选择片段与真实宿主 IPC 均走已安装应用。诊断阶段还完成了两次真实搜索窗插入，及安装版原生模块的受控插入检查，未将其混算为最终版本验收次数。

最终完整修复版安装并启动后，清空仅含本次测试片段的临时文档；用户重复五轮“Alt+空格 → 搜索 SJZQA20261111 → 回车”，每轮约间隔两秒。用户反馈五次均成功；随后通过 TextEdit 无障碍树读取正文，确认恰好五份以下内容，顺序、中文标点和换行完整，没有只成功第一次的问题：

```text
SJZQA20261111 中文连续插入、“引号”与换行。
```

本次验收覆盖本机 TextEdit 的五轮连续搜索与插入，不推定其他编辑器、安全输入框、休眠唤醒或系统重启场景均已测试。最终应用保持运行。

临时片段已从原片段目录移回任务 scratch，目录监控会刷新搜索缓存。用户 settings.json 的 SHA256 与测试开始前一致，原全局快捷键 Alt+Space 保留。本次未运行可选开发 Electron 实机 runner，未把开发身份的结果冒充安装版权限验收。
