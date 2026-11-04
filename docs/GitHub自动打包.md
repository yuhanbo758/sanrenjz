# GitHub 自动打包

推送到 `main` 或在 Actions 手动运行“Windows 自动打包”，会构建当前版本的 Windows x64 公开安装包。工作流只读取仓库，不修改版本号，不创建标签或 GitHub Release，不启用主程序自动更新。

## 执行步骤

1. 检出代码后，在安装依赖前运行 `scripts/check-privacy.py --git`。
2. 使用 Node.js 22、Python 3.11 和 Windows 2022 runner。Python 仅作为 CI 编译与测试工具，不随安装包分发。
3. 执行 `npm ci --ignore-scripts`，单独下载 Electron，再通过 `electron-builder install-app-deps` 按 Electron ABI 重建 SQLite 等原生模块，避免先为宿主 Node 编译旧版 SQLite。
4. 运行隐私、公开插件范围、合并功能、快捷键及中文控制台测试。联网下载 Python 的验收测试默认跳过，测试使用隔离配置。
5. 运行 `npm run build-win -- --x64`。该命令经过公开清单暂存，并固定使用 `--publish never`，不从开发目录直接打包。
6. 再对本次唯一公开暂存目录执行内容隐私扫描，并二次审计解包结果，确认没有私有插件、用户数据或 Python 运行时；只收集本次唯一公开安装包。

所有步骤成功后，Actions 页面会提供 `sanrenjz-windows-x64-<运行编号>` 产物，保留 30 天。压缩包内包含安装 EXE、`SHA256SUMS.txt` 和不含本机绝对路径的 `build-info.json`。工作流不上传整个 `dist/`，也不上传原始隐私扫描报告、测试用户数据或构建缓存。

## 查看和校验

打开仓库的 **Actions → Windows 自动打包 → 对应运行 → Artifacts** 下载产物。Windows PowerShell 可用 `Get-FileHash -Algorithm SHA256 <安装包路径>` 校验，与 `SHA256SUMS.txt` 对照。Actions 的绿色结果表示云端构建和所列检查通过，不能替代真实安装、升级和业务功能验收。

## 公开范围和平台限制

默认安装包采用 `config/public-plugins.json` 允许清单。私有插件仍只保留在开发机；CI 不调用 `build:personal`，不需要开发者账号、模型密钥或用户配置。

首轮仅启用已验收的 Windows x64。macOS/Linux 的源码构建入口保留；扩展 Actions 前应先补齐对应平台的高分辨率图标、macOS DMG 资源与签名策略，并在对应架构 runner 验证原生依赖。当前没有 macOS/Linux 的云端成功构建或实机验收声明。
