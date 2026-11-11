# macOS 插件图标与 Dock 钉住修复

## 问题与修复

Python 插件没有宿主内置的图标生成步骤。旧 Windows 插件可能只有 `logo.ico`；Tk 的 PNG 加载分支会跳过 ICO，旧 bootstrap 又会在 Mac 上尝试 Windows 的 `iconbitmap`。现在 Mac/Linux 的 Tk 图像优先读取插件 PNG，缺少跨平台图像时使用宿主 PNG；Windows `iconbitmap` API 仅在 Windows 调用。Mac 对只有 ICO/ICNS 的插件另用标准库 ctypes 调用 Cocoa，只读设置原有图标，并在 Tk 初始化空闲时重新应用。未来再次迁入只有 ICO 的插件也能显示自身 Dock 图标；不需要 PyObjC。插件目录列表继续使用可读的原始图标。宿主不在启动、列表、导入时生成图片或安装依赖。

运行中的 Python/Tk 应用使用 PNG 即可设置 Dock 图标，不必为每个 Python 插件生成 `.icns`。Tk 初始化后保留 `PhotoImage` 引用并调用 `iconphoto`。这次没有给 Python 插件另建应用包，也没有更换解释器。

新插件制作时同时提供 `logo.png` 和 Windows 的 `logo.ico`，清单填写 `"logo": "logo.png"`。已有仅 ICO 插件可显式补齐 PNG：

```sh
python -B scripts/prepare-python-plugin-icons.py "/path/to/plugin-or-collection"
python -B scripts/prepare-python-plugin-icons.py "/path/to/plugin-or-collection" --apply
```

默认只检查，`--apply` 只新增缺失 PNG，不覆盖现有 PNG、ICO、清单或配置。macOS 使用系统 `sips`；其他系统的制作工具需要已有 Pillow，不会自动安装。转换保留原图分辨率，不把 32px 图像冒称为高分辨率资源。完全没有图标的插件使用宿主默认图标。

效率插件原来的 `BrowserWindow.icon` / `setSkipTaskbar` 不能在 Mac 上创建每个插件独立的 Dock 身份。新增小型 Cocoa 辅助进程，仅持有图标和身份，通过宿主创建的管道发送固定 `focus` / `close` 信号。原窗口、设置、账号及业务仍在原宿主中。

- 钉住与自动分离创建对应 Dock 图标；激活后恢复并聚焦对应窗口。
- 取消钉住、关闭插件或宿主退出时关闭辅助进程；宿主崩溃造成管道 EOF 时辅助进程自行退出。
- 辅助 `.app` 缓存在独立 userData 的 `runtime/mac-plugin-dock`，不写入签名宿主或插件程序目录。身份基于 `tools:` 稳定目录 ID。
- 快速取消后重新钉住以原子替换更新辅助二进制，避免覆写仍在退出的可执行映射。
- Mac `beforePack` 只编译当前原生 runner 的架构。二进制随 extraResources 分发，纳入现有 ad-hoc 签名检查；源码仓库忽略生成的 `app/native`。运行时不需要编译器或 Python。
- Windows 保持既有任务栏策略，Linux 不启动 Mac 辅助进程。

Mac 回归还发现 Python 导入器返回物理路径，与 `/var`、`/private/var` 别名不一致，会导致导入后条目缺失及运行中替换保护失效。现已对导入结果和活动入口使用物理路径匹配，稳定条目 ID 保持原目录命名。

## 本机验收

2026-11-09，Apple Silicon / arm64，Electron 25.9.8、Node 22.16.0、所选 Miniforge Python 3.14 / Tk 8.6.13。

- 用户安装目录中 26 个 Python 插件：12 个仅 ICO、13 个已有 PNG、1 个没有图标。已只为 12 个仅 ICO 插件新增 PNG；未执行这些插件的业务入口。
- `node build/prepare-native.cjs arm64`：clang 编译、ad-hoc 签名成功。
- `node --test tests/mac-dock-electron.test.js tests/mac-dock.test.js tests/mac-dock-native.test.js tests/python-manager.test.js tests/python-manager-regression.test.js tests/plugin-management.test.js tests/package-scope.test.js tests/build-assets.test.cjs`：28 通过，3 个 Windows 专属用例跳过。
- `python -B tests/python-plugin-icons.test.py`：3 通过，覆盖平台 API、显式补齐与资源保留、真实隐藏 Tk 初始化。通过 Cocoa 读取系统应用图像，确认 PNG 路径的 Dock 图像像素尺寸与插件 PNG 一致；另以宿主 1024px PNG 作为 Tk 回退、256px 插件 ICO 作为原生图标，确认系统 Dock 最终使用插件 ICO。
- 原生 Dock 测试验证两个不同 Bundle ID 和应用名、PNG/ICO 加载、LaunchServices 激活到对应宿主回调、快速重新钉住、EOF 正常退出。
- Electron 集成测试在父进程分配的临时 userData 下使用隐藏空插件窗口，覆盖手动钉住、自动分离、取消和关闭。等待 Electron 与 Dock 子进程退出后才清理临时目录。

以上为第一阶段的 Mac 原生自动验收，当时只补齐了已安装 Python 插件资源，尚未替换 `/Applications` 中的旧宿主。后续安装复查与当前状态如下。未验证 Intel Mac 或 Windows 实机；版本号未改，未提交、推送或发布。

## 安装态复查与修复

用户反馈 Python 图标已显示，效率插件钉住后仍无图标。复查确认实际运行的 `/Applications/三人聚智.app` 不含 `resources/app/plugin_runtime/mac-dock.js` 和 `resources/app/native/mac-dock-helper`，仍是旧版；第一阶段源码改动没有进入本机运行包。

已完成以下处理：

- 使用 `SANRENJZ_ADHOC_BUILD=1 CSC_IDENTITY_AUTO_DISCOVERY=false node scripts/package-local.js --mac --arm64 --dir --publish never` 构建本机安装包。本地构建参数新增接受且仅接受显式 `--publish never`，内部 builder 也固定此值。
- 构建暂存隐私扫描：508 个文件，0 个未复核发现、0 个范围错误。完整包签名校验通过，为 ad-hoc、未公证。
- 增加安装包 Dock 资源与架构门禁，缺模块、缺辅助程序、不可执行或架构不符直接失败。
- 增加真实打包宿主的隔离验收：在临时 userData 创建无业务空插件，经 `unified:run` 与钉住 IPC 启动真实辅助进程，取消钉住后等待其退出。完整安装包 smoke 的 26 项断言通过，宿主退出码为 0。
- `tests/mac-dock*.test.js`、`tests/packaged-runtime-probe.test.cjs`、`tests/package-scope.test.js` 共 17 项通过。
- 停止旧宿主后备份旧 `.app`，将签名校验通过的新包安装至原路径。备份与安装凭据在本机 `dist/local-dock-install-receipt.json`，不进入 Git。
- 安装前后核对宿主设置字节不变、效率插件 40 个、Python 插件 26 个，独立用户数据不搬移。
- 使用安装态界面打开“结构化数据工作台”，实际点击钉住后按钮变为“已钉住”。系统应用清单出现独立的同名运行应用；NSRunningApplication 确认其独立 Bundle ID 和 regular 激活策略（值 0）。已将此插件保留在钉住状态供用户查看。
- 安装的管理器、Dock JS 模块和原生辅助程序均与验收包 SHA256 一致，安装后再次通过 `codesign --verify --deep --strict`。

系统 Dock 自身的辅助功能树读取超时，未将其截图作为外观验收证据；安装态界面操作、独立应用注册、原生 Dock 策略和进程存活均已核验。

公开范围检查另发现当前基线 Git 索引包含私有插件，现有隐私门禁未通过；未擅自重写索引或历史。此结果不构成本次修复可公开发布的验收证明，原始扫描内容不纳入文档。

## 依据

- [Electron：Mac Dock](https://www.electronjs.org/docs/latest/tutorial/macos-dock)：每个 Electron 应用只有一个 Dock 实例。
- [Apple：applicationIconImage](https://developer.apple.com/documentation/appkit/nsapplication/applicationiconimage)：应用运行时图标。
- [Apple：NSImage init(contentsOfFile:)](https://developer.apple.com/documentation/appkit/nsimage/init%28contentsoffile%3A%29)：只读加载已有图像。
