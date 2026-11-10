# 0.1.13 macOS 连续插入修复

- 仅从脚本实际错误输出识别权限拒绝，避免完整命令中的标记导致误报；分别显示焦点恢复、目标退出、超时等失败原因。
- 激活目标应用后通过主运行循环等待 AppKit 更新状态，保留真实时间超时与粘贴前 PID 核验。
- 搜索窗口回调绑定创建时窗口，避免旧窗口延迟事件关闭或清空新搜索窗。
- 失败诊断进入现有有界日志，仅包含固定错误类型和进程状态，不记录正文、剪贴板或原始执行命令。
- Windows 的 Ctrl+V 插入分支保持原实现。发布前必须通过 Windows 完整功能回归，以及 Windows x64、macOS x64、macOS arm64、Linux x64 四目标构建与安装包隔离运行验收。

本机 macOS 验证：23 项专项、6 项搜索和日志回归通过；最终安装版通过实体快捷键连续五次向 TextEdit 插入，已读取实际正文核对五份内容完整。该验收不代表所有编辑器或安全输入框均已测试。

接口依据：[Apple NSRunningApplication](https://developer.apple.com/documentation/appkit/nsrunningapplication?language=objc)、[Apple Run Loop Management](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Multithreading/RunLoopManagement/RunLoopManagement.html)。macOS 构建使用 ad-hoc 签名，未公证。
