# 三人聚智

效率工具与 Python 程序管理的合并应用。以原效率工具为主框架，保留全局搜索、超级面板、窗口管理、插件存储和程序小店，增加独立的 Python 管理模块。

当前配置版本为 **0.1.9**，公开仓库为 [yuhanbo758/sanrenjz](https://github.com/yuhanbo758/sanrenjz)，正式版安装包入口为 [GitHub Releases](https://github.com/yuhanbo758/sanrenjz/releases)。只有对应的多平台构建及检查全部通过才会发布。两个来源项目保持独立；仓库修复是否包含在已发布包中，以 Release 来源提交为准。

## 使用

- 默认进入“效率工具”；切换“py程序”后，共用搜索框会保留查询词。全局快捷搜索可以找到两种插件。
- 点击“打开插件”，添加单个 Python 文件、Python 插件文件夹、效率插件文件夹或 ZIP。导入不会自动运行。
- Python 默认未配置，安装包不含 Python。到“设置 → Python 环境”添加解释器、检查本机环境或一键安装。
- 自选解释器支持 Python 3.9 及以上。Windows x64 一键安装使用官方 PythonCore 3.14.10 完整运行时，安装在应用目录的 `runtime/python`，不修改系统 PATH。
- 用户选择的解释器不兼容某个插件时，需要选择该插件支持的解释器；不会静默更换。缺少依赖时先列出安装计划，经确认后安装到所选环境。
- “设置 → 插件管理”统一管理效率工具和 Python 插件，可按类型筛选；显示与自启动独立保存，隐藏后仍可在管理列表恢复。勾选自启动在下次启动主程序时生效。
- Python 环境页按当前解释器、环境获取、候选和诊断分组；候选标记当前使用，检查/安装有进度和取消反馈。常规设置支持 Python 插件配置目录的更改、打开和恢复默认，独立即时保存。
- 插件和环境页的操作即时生效，点击“完成”退出；常规偏好和快捷键点击“保存设置”生效。切换设置页保留尚未保存的输入。
- 快捷搜索按不同查询词的匹配数量优先排序；匹配数量相同时，保留插件、命令、片段的类型优先级。
- 日志可以从 Python 卡片或环境设置打开。分享日志前检查程序自身输出是否包含个人信息。
- 顶部“日志”在两类页面常显，统一查看效率插件和 Python 程序的当前会话日志，支持类型与插件筛选、实时追加、刷新和导出当前筛选。
- “设置 → 数据导入”支持从旧效率工具和 Python 程序管理导入插件、配置及插件偏好，可自动检测或手动选择旧版目录。先备份、只补缺少项，保留现有配置并列出冲突；不迁移登录状态、全局快捷键或旧自启动设置，也不复制整套 Python 环境。
- 头像菜单中的“检查更新”只检查本项目的正式 Release，按系统和架构选择安装包，下载及打开安装前均校验大小与 SHA256；检查不会自动下载或安装。Windows 显式启动安装，macOS 打开 DMG，Linux 定位 AppImage，由用户完成替换。
- 程序小店与主界面共用内置商店会话，支持 HttpOnly Cookie 登录；两类会员独立查询。服务暂时不可用时显示待确认并支持刷新，避免将网络故障当成退出登录。

快捷键录入支持直接点击 `Alt+Space` 预设；保存时检查组合键占用，失败保留原设置。Windows 启动器会设置当前控制台 UTF-8。

## 本地开发与打包

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npx --no-install electron-builder install-app-deps
npm start
npm run test:merge
npm run audit:privacy
npm run audit:public
npm run build-win
```

本地安装包输出在 `dist/public-package-时间戳/`。所有 electron-builder 调用均强制使用 `--publish never`，本地构建不会推送 Git 或上传 Release。

GitHub Actions 配置为推送 `main` 或手动运行时构建 Windows x64、macOS Intel x64、macOS Apple Silicon arm64 和 Linux x64。四个目标的构建、隐私审计及原生隔离运行检查全部通过后，独立发布任务才会按版本通道创建 Release，稳定版本正常发布并设为 Latest，上传 7 个安装包、SHA256 清单和来源清单。版本由维护者手动更新，不自动递增，不覆盖已有公开标签或资产，也不启用旧产品更新通道；详情见 [GitHub 自动打包](docs/GitHub自动打包.md)。

Windows 提供 NSIS EXE；两种 macOS 架构分别提供 DMG 和 ZIP；Linux 提供 AppImage 和 tar.gz。当前包没有 Windows 正式代码签名，macOS 仅采用 ad-hoc 签名、未经 Developer ID 签名及 Apple 公证。构建结果以对应 Actions 运行和 Release 来源提交为准，不代表安装升级、Gatekeeper 或真实设备权限已完成验收。

扫描命令、精确误报复核及原始报告保护规则见 [隐私保护](docs/隐私保护.md)。

默认包只包含 `config/public-plugins.json` 允许的 40 个效率插件和 4 个 Python 插件。私有插件、真实配置、日志、迁移备份及可下载运行时排除 Git 和默认包。

明确选择私有插件制作个人包：

```powershell
npm run build:personal -- --win --include tools:插件目录名,python:插件目录名
```

只允许 `config/private-plugins.json` 已登记的目录；个人包不上传。不要把公开包和个人包混用。

macOS/Linux 保留手动解释器支持，不提供一键安装 Python。四目标会在对应架构 runner 上检查实际打包程序；目标设备安装、升级与平台权限仍需独立验证。

## 数据与兼容

- 主设置位于系统应用数据目录下的 `sanrenjz/settings.json`，与旧应用隔离。
- 效率插件开发目录 `app/software`，Python 插件开发目录 `app/python-software`；Windows 安装态继续使用安装目录下的 `plugins` 和 `python-plugins`，macOS/Linux 使用新应用用户数据目录下的同名目录，避免修改应用签名内容或 AppImage 只读挂载。
- 效率插件数据默认在用户数据目录的 `plugin-data`；Python 配置默认在 `python-plugin-configs`，也可选择其他独立目录。
- 保留 `plugin.json`、Python `settings.json`、旧 Python 配置环境变量及 `.enc` 格式。标准 Windows VBS 启动器读取新应用所选环境；自定义启动器不会被静默覆盖，迁移报告会明确提示。
- NSIS 升级保留两类插件、旧配置目录和按需安装的 Python，失败时保留升级备份。

来源记录在本地 `docs/merge-baseline.json`；架构说明见 [合并架构](docs/合并架构.md)，验证证据见 [验收报告](docs/验收报告.md)。

0.1.1 快捷键及日志修复细节见 [修复验证](docs/修复验证-0.1.1.md)。

0.1.2 将 Python 插件整合到“设置 → 插件管理”，支持按类型筛选、显示、自启动、日志和移除；验证见 [插件管理整合](docs/修复验证-0.1.2.md)。

0.1.3 优化设置界面、Python 环境反馈和配置目录管理，并修复快捷搜索多词排序；验证见 [更新记录](docs/更新验证-0.1.3.md)。

0.1.4 全面回归并修复 Python 流式日志、启动失败传递、中文输入法搜索及设置并发保存问题；验证见 [全面回归记录](docs/全面回归-0.1.4.md)。

0.1.5 压缩顶部两行导航，在“Python 环境”左侧增加“日志”快捷入口；验证见 [导航优化记录](docs/导航优化-0.1.5.md)。

0.1.6 将日志入口扩展到效率工具页面，并统一两类日志采集、筛选和导出；验证见 [统一日志记录](docs/统一日志-0.1.6.md)。

0.1.8 增加独立正式版更新检查、HttpOnly Cookie 登录同步，以及“设置 → 数据导入”；实现及本地修复边界见 [修复记录](docs/更新登录与数据导入修复-2026-11-05.md)，发布范围见 [0.1.8 发布说明](docs/发布说明-0.1.8.md)。

0.1.9 修复默认头像资源与重启后的显示，支持在客户端选择本机头像、恢复程序 logo；完善旧插件程序识别和导入，支持用户自行安装的非开源插件。数据和图片仅留在用户本机，公开安装包继续排除私有插件及 Python 运行时，详见 [0.1.9 发布说明](docs/发布说明-0.1.9.md)。
