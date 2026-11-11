# Windows 开机弹出 Electron 欢迎页修复

## 原因与现场证据

- Windows 当前用户 `Software\Microsoft\Windows\CurrentVersion\Run` 同时存在安装版和开发版启动项。
- `electron.app.三人聚智` 正确指向 `D:\RJ\sanrenjz\三人聚智.exe`。
- `electron.app.Electron` 错误指向本仓库的 `node_modules\electron\dist\electron.exe`，没有应用入口参数；现场主进程命令行也只有该可执行文件，显示 Electron 默认欢迎页。
- 开发版和安装版共用宿主设置，已保存 `autoStart=true`。旧逻辑在应用启动时无条件使用 `process.execPath` 注册自启动，因此开发版运行也会把裸 Electron 注册到系统。保存自启动选项也存在相同问题。

## 修改

- `app/login-startup.js` 统一生成系统自启动参数，仅安装版返回可执行文件路径和空参数列表。
- `main.js` 在开发版启动时跳过系统自启动注册；开发版尝试变更自启动选项时明确提示到安装版设置，并保留原设置、快捷键和系统状态。
- 安装版继续使用同一套参数查询、注册及回滚系统自启动，保留原有保存事务。
- 本机错误启动项已单独备份到 `.codex_backups/startup-electron-20261110/startup-entry.json` 后删除；正确的安装版启动项保留。测试后再次查询，错误项未重新出现。

## 验证

- `node --check main.js` 通过。
- `node --test tests/merged-save-settings-effects.test.js`：4 项通过，含开发版继承自启动偏好、开发版保存拦截、安装版事务回滚与启动失败容错。Electron 使用临时用户目录、隐藏窗口、临时空插件目录和模拟系统接口，阻断账号会话外网。
- `node --test --test-concurrency=1 tests/main-runtime-paths.test.js tests/merged-settings-persistence.test.js tests/package-scope.test.js`：3 项通过，覆盖开发/安装资源加载、设置持久化及公开包范围。
- 初次修复阶段未替换安装版；随后按用户追加授权完成下述安装版同步。未重启 Windows、打包、发布、提交或推送。

## 安装版同步与复核（2026-11-10）

- 目标：`D:\RJ\sanrenjz`。安装版保持原有 `0.1.9` 版本号，仅同步自启动修复，不发布新版本。
- 安装版主程序与当前源码另有商店浏览器实现差异，因此以安装版原有 `main.js` 为基础，仅应用本次自启动补丁。部署变更限于 `resources/app.asar` 中的 `main.js` 和新增 `resources/app/login-startup.js`。
- 原始 ASAR、主程序文本、宿主设置、自启动项及校验报告保留在 `D:\RJ\sanrenjz\host-deploy-backups\startup-2026-11-09T23-45-01-616Z`。
- ASAR 保留原有其他条目、拆包标记及元数据，3,145 个其他打包文件逐一进行 SHA256 比较通过，保留安装版既有逻辑和资源。
- Windows Restart Manager 的正常退出请求返回 351，未强制中断备份。用户从托盘退出后确认备份子进程已结束，但宿主及鼠标监听仍残留，随后仅结束该安装版残留进程并替换文件。

### 真实安装版隔离验收

直接运行安装目录中的 `三人聚智.exe`，使用临时用户目录、临时插件安装根和隐藏窗口；不启用会跳过系统自启动的 `SANRENJZ_ACCEPTANCE`。11 项断言全部通过：

1. 加载真正安装版主页面，标题为“三人聚智”，`app.isPackaged=true`。
2. 可执行文件路径正确，用户设置与真实配置隔离，窗口隐藏。
3. `getLoginItemSettings` 返回 `openAtLogin=true`、`executableWillLaunchAtLogin=true`。
4. `launchItems` 指向 `D:\RJ\sanrenjz\三人聚智.exe`，参数为空，`enabled=true`。
5. 通过实际设置 IPC 关闭再开启自启动，系统状态随之改变，最终恢复开启。
6. 临时配置保存与系统状态一致，未启动备份、交易或其他业务插件。
7. 测试进程正常退出，退出码 0；父进程确认结束后清理临时目录。

完整断言记录：备份目录中的 `installed-startup-probe.json`。

### 原配置正常启动

- 从 Windows Run 项读取并校验原始启动命令，使用安装版 EXE、不带入口或调试参数启动。未使用临时用户目录或验收环境。
- 正常启动后仅有一个安装版主进程，开发目录的 Electron 进程为 0，错误的 `electron.app.Electron` 启动项不存在。
- 宿主 `settings.json` 与部署前逐字节摘要一致，`autoStart=true`。对插件目录及独立 Python 配置目录中 595 个程序、清单和配置文件比较 SHA256，无修改、缺失或新增；排除可变运行目录、日志和依赖缓存。
- 界面核验显示真实安装版主页面，AI 语音输入法及备份工具按原偏好恢复启动；这仅确认插件恢复，不代表备份任务已完成。
- 自启动注册与同一命令的真实启动已验证，未注销或重启 Windows，不能表述为已完成真实开机实测。
- 正常启动记录：备份目录中的 `normal-start.json`、`normal-start-check.json`、`preserved-files.check.json`。

## 回滚

仅回退本次 `main.js`、新增模块及相关测试改动，保留工作区原有修改。若确需恢复错误启动项，可按本地备份中的键名、类型和值单独恢复，不导入或覆盖整个 Run 键。

安装版回滚须先退出宿主，再将上述部署备份内的 `app.asar` 恢复至 `resources/app.asar`，移除本次新增的 `resources/app/login-startup.js`。保留当前用户配置、插件和数据，不整目录覆盖安装版，也不需要恢复错误的 Electron 启动项。
