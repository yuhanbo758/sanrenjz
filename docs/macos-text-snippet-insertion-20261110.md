# macOS 文本片段插入修复

## 根因与范围

快捷搜索选择文本片段直接调用宿主 `insert-content`，不经过插件 preload。原实现不区分平台，记录/恢复前台窗口使用 PowerShell 和 Win32，直接插入使用 Windows `SendKeys('^v')`，因此 macOS 缺少可执行的插入路径。

经本次确认修改宿主 `main.js` 和 `search-window.html`，增加 `app/mac-text-insertion.js` 及专用测试。保留工作区其他既有修改，不改变插件清单、片段目录、用户配置或宿主版本号。

## 实现

- macOS 在显示搜索窗口或超级面板之前，通过系统自带 `osascript` 的 JXA/AppKit 接口同步采样前台应用 PID。采样有超时；失败或采样到宿主自身时清空目标，不能沿用旧应用。
- 正文只写剪贴板，不放进命令行或 JXA 脚本。使用独立参数传递 PID，不通过 Shell 拼接命令。
- 通过 AppKit 恢复原应用，核对前台 PID，等待切换稳定后再次核对，然后用 CoreGraphics 发送带 Command 标志的 V 按下和释放。该实现不使用 System Events 或 Apple Events 自动化。
- 检查执行粘贴的系统进程是否具有辅助功能权限。权限、目标退出、焦点变化和进程超时均返回失败，不把仅复制或发送按键描述为目标应用已接收正文。
- 插入期间阻止重复请求覆盖剪贴板；临时隐藏窗口，成功后关闭搜索，失败恢复窗口并保留剪贴板内容。
- 搜索页面的 200 毫秒延迟失焦回调在执行中或已重新聚焦时不隐藏窗口，防止遮掉失败提示；普通失焦与钉住规则继续保留。
- Windows 保留原有 Ctrl+V 路径。其他系统自动插入返回明确的不支持提示，仍保留复制结果。

## 验证

- `node --test tests/mac-text-insertion.test.js`：10 项通过，覆盖采样失效、PID 快照、重复请求、子进程超时参数、JXA 按键序列及拒绝分支、真实宿主 IPC 的成功/失败/复制路径、Windows 与其他系统分支，以及搜索前采样顺序和延迟失焦竞态。
- JXA 测试运行的是实际脚本文本，但 AppKit、辅助功能和 CoreGraphics 使用替身；不能代表 macOS 原生 API、签名与系统授权已验收。
- `node --test tests/merged-search-actions.test.js`：Windows 隐藏 Electron 真实宿主回归通过，覆盖目录、PluginManager 功能分发、文本片段插入请求、失败反馈和中文输入法等。该回归拦截实际剪贴板与粘贴副作用。
- `node tests/main-runtime-paths.test.js`：开发目录及安装包 extraResources 模块导入通过，新模块由现有 `*.js` 打包规则包含。
- `node --check main.js`、`node --check app/mac-text-insertion.js`：语法检查通过。

本次环境为 Windows，未在 macOS 实机向 TextEdit、浏览器或其他外部应用执行粘贴。没有同步用户安装目录、打包、提交、推送或发布。

后续发布任务已安排 0.1.11：GitHub 仅提交本次修复和必要发布文件，原工作区其他任务改动保留。四个构建目标增加专用回归；两个 macOS runner 还检查原生 JXA 桥接、脚本语法、键盘事件创建及脚本正常退出，不向桌面发送按键。该检查不能替代用户应用实际接收正文的人工验收。macOS 安装包沿用 ad-hoc 签名，未公证。

原生 Apple Silicon runner 检查发现：JXA 中手动调用 `CFRelease` 后系统脚本以 `SIGSEGV` 退出。替身测试不能覆盖该桥接问题。实现已移除这条调用，键盘事件随短生命周期的 `osascript` 进程退出回收，继续保留原生事件创建、Command 标志及进程正常退出检查。

## macOS 验收与交付

本修复涉及宿主，单独更新文本片段插件不足以生效，需要后续发布包含本修复的新宿主版本。

1. 更新并重启宿主；在「系统设置 → 隐私与安全性 → 辅助功能」允许三人聚智。若系统额外列出执行脚本的进程，按实际提示确认授权归属。拒绝权限时应显示中文错误且保留正文。
2. 在 TextEdit 的可编辑文档中放置光标，呼出快捷搜索，筛选并选择含中文、换行、引号的片段，分别用回车和鼠标执行，确认正文出现在原光标位置。
3. 在浏览器普通输入框及富文本编辑器重复验证。安全输入框和应用自身禁止粘贴的控件不作为普通插入目标。
4. 覆盖钉住搜索窗口、权限撤销、原应用退出、恢复焦点期间切到另一应用及快速重复选择；失败时不得向其他应用发按键，提示可见且正文仍可手动粘贴。

接口依据：[Apple NSWorkspace.frontmostApplication](https://developer.apple.com/documentation/appkit/nsworkspace/frontmostapplication)、[Apple CGEventCreateKeyboardEvent](https://developer.apple.com/documentation/coregraphics/cgevent/init(keyboardeventsource:virtualkey:keydown:))、[Apple CGEventPost](https://developer.apple.com/documentation/coregraphics/cgevent/post(tap:))。
