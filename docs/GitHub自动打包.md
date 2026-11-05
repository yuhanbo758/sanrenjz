# GitHub 多平台自动打包发布

推送到 `main`，或在 Actions 手动运行“多平台自动打包发布”，会检查当前公开源码并构建四个目标。只有四个目标的构建、隐私审计和原生运行验收全部通过，发布任务才会向 [GitHub Releases](https://github.com/yuhanbo758/sanrenjz/releases) 上传安装包及校验文件。

当前配置版本为 `0.1.9`。本说明描述发布流程，具体平台是否成功以对应 Actions 运行和 Release 的来源提交为准，不提前代表各平台构建、安装或业务功能已经完成验收。

## 构建目标与下载文件

| 目标 | Runner | 安装包 |
| --- | --- | --- |
| Windows x64 | `windows-2022` | NSIS `.exe` |
| macOS Intel x64 | `macos-15-intel` | `.dmg`、`.zip` |
| macOS Apple Silicon arm64 | `macos-15` | `.dmg`、`.zip` |
| Linux x64 | `ubuntu-22.04` | `.AppImage`、`.tar.gz` |

每个版本合计 7 个安装包。Release 还包含 `SHA256SUMS.txt` 和 `release-manifest.json`，共 9 个下载资产。文件名包含版本、平台和架构，macOS 的 Intel 与 Apple Silicon 文件不会互相覆盖。当前 `0.1.7` 使用正常 Release，`prerelease=false` 并设为 **Latest**；只有维护者显式使用先行版本号时才发布 **Pre-release**。

## 检查与构建顺序

1. 检出同一提交，运行隐私检查单测、`scripts/check-privacy.py --git` 和公开插件范围审计，确认版本有效并判定正式或预览通道。
2. 四个原生 runner 分别准备 Node.js 22、Python 3.11 和同架构 Electron。Python 仅作为 CI 编译工具，不随安装包分发。
3. 执行 `npm ci --ignore-scripts`，单独安装 Electron，再通过 `electron-builder install-app-deps --arch <架构>` 重建 SQLite 等原生模块，避免先为宿主 Node 编译旧版 SQLite。
4. 检查高分辨率 PNG、ICO、ICNS 和 DMG 背景等构建资源，运行产物收集和发布规则的隔离测试。Windows runner 另执行完整合并功能、快捷键和中文控制台回归；联网下载 Python 的测试默认跳过。
5. 通过 `scripts/package-local.js` 按公开允许清单创建独立暂存目录，执行对应平台、架构的构建。所有 electron-builder 调用固定使用 `--publish never`，不在构建阶段发布。
6. 扫描本次唯一公开暂存目录，并检查实际解包文件、ASAR、原生模块和架构。macOS 只允许包内合法链接，包外链接或私有内容会阻止收集。
7. 在本机架构运行打包后的程序，使用全新临时 profile 检查版本、平台架构、SQLite、40+4 插件目录、默认无 Python、两类菜单、统一日志、设置保存和正常退出。Linux 在 Xvfb 中运行，只有此隔离验收进程使用 `--no-sandbox`，产品默认启动参数不改变。
8. 本平台验收成功后，只收集明确的安装包、SHA256 与无个人路径的构建信息，上传对应 Actions Artifact。四个目标全部成功后，发布任务重新核对版本、来源提交、平台架构、安装包集合和校验值，再按版本通道创建 Release。

工作流默认权限为 `contents: read`，只有发布任务使用 `contents: write`。不需要开发者个人 Token、模型密钥或真实用户配置。原始日志、扫描报告、临时 profile、整个 `dist/` 和个人包均不作为下载资产上传。

macOS 构建对本次创建的 DMG 设备卸载“资源忙”错误执行有限延迟重试，其他设备或错误直接沿用原处理；达到上限仍会阻止发布。该构建兼容逻辑不会进入应用安装包。

## 版本与发布保护

版本由维护者手动更新，`package.json` 和 `package-lock.json` 必须一致。例如，从当前版本准备下一个修订版时，可运行：

```powershell
npm version patch --no-git-tag-version
```

审阅代码、运行检查后再提交推送。工作流不自动修改版本或提交代码，也不沿用旧产品的更新通道。应用内仅在用户主动操作时检查本仓库的正式 Release，不自动下载或安装。

公开标签和资产不可被新提交覆盖。已有同名标签或资产与本次提交、内容不一致时，发布应停止；维护者须确认差异并升级版本，不能删除已公开版本后强行替换。手动在其他分支运行可以验证构建，只有 `main` 允许发布。

草稿创建后使用服务端响应中的 Release ID 上传、校验和公开，避免新草稿尚未出现在列表或标签查询中时误判失败。同一提交的未完成草稿可核验后继续上传缺少的资产；不同提交或不同内容必须使用新版本，失败材料保留供检查。

## 下载与校验

面向用户的下载入口为 [GitHub Releases](https://github.com/yuhanbo758/sanrenjz/releases)。选择与设备匹配的平台和架构文件，同时下载 `SHA256SUMS.txt`，比较其中对应文件的校验值。`release-manifest.json` 记录来源提交、平台架构及产物信息。

Windows PowerShell 示例：

```powershell
Get-FileHash -LiteralPath .\sanrenjz-0.1.9-win-x64.exe -Algorithm SHA256
```

macOS 可使用 `shasum -a 256 <下载文件>`，Linux 可使用 `sha256sum <下载文件>`。只下载一个平台文件时，比较清单中该文件对应的行即可。

Actions Artifacts 保留 30 天，作为构建过程的临时产物；对外安装包通过 Release 下载。Actions 成功意味着声明的构建和隔离检查通过，不替代现有安装覆盖升级、系统权限、真实设备和业务任务验收。

## 公开范围与平台限制

默认包采用 `config/public-plugins.json` 的 40 个效率插件和 4 个 Python 插件允许清单。私有插件及专用资料只保留在开发机；真实配置、Cookie、授权值、运行日志和按需 Python 运行时均不进入 Git 或公开包。公开 Python 配置仅保留 `{}` 空模板。

Windows 保持安装目录下的 `plugins/`、`python-plugins/`。macOS/Linux 使用新应用用户数据目录下的同名插件目录，避免修改 `.app` 的签名内容或写入 AppImage 只读挂载。已有 Windows 配置与本地私有文件不因构建或烟测而迁移、删除或覆盖。

GitHub 正常发布通道与系统代码签名分别管理。当前 Windows 未提供正式代码签名；macOS 仅采用 ad-hoc 签名，没有 Developer ID 和 Apple 公证，不代表 Gatekeeper、局域网隐私身份或用户授权已经通过验证。macOS/Linux 保留手动选择 Python 解释器能力，不提供一键安装 Python；平台签名、安装升级与目标设备验收仍需独立完成。
