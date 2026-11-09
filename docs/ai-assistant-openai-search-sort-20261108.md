# AI 助手 OpenAI 直连、模型搜索及排序

日期：2026-11-08。

## 用户可见变化

- 共享供应商更新、预设填充、模型标签、当前模型及搜索结果保留供应商分组，组内按显示名称 A–Z 排序，不区分大小写，数字采用自然顺序；同名时按模型 ID 排序。
- “余汉波AI助手”的独立下拉框原先主动跳过共享选择器。本次新增对原生 select 的兼容包装，复用既有搜索组件，覆盖顶部当前模型、设置页默认模型和快捷指令模型。
- 搜索支持名称、ID 和供应商；分组区分共享供应商与 OpenAI 等本插件直连来源。底层保留原生 select 的模型 ID 与 provider 信息，兼容快捷指令和程序化选择。
- 助手设置增加 OpenAI 官方直连 API Key 和“加载模型”。加载后立即保存模型目录并按名称排序；密钥在保存设置时通过宿主加密接口保存，留空保留已有密钥。
- OpenAI 直连内置 GPT-6 Astra、Luna、Sol；“加载模型”从官方目录获取当前模型，保留共享目录原有管理方式。
- 自定义模型的供应商增加 OpenAI 官方直连。选定直连模型后刷新列表会保留选择，避免被共享文本默认模型覆盖。

## 源码范围

- `app/plugin_runtime/ai-provider-manager.js`：排序工具、搜索选择器的原生 select 包装、程序化刷新与供应商名称展示。
- `app/software/sanrenjz.tools-ai/index.html`：OpenAI 设置入口、模型加载、三个模型选择器搜索、按 provider+ID 精确同步及直连选择保留。
- `app/software/sanrenjz.tools-ai/preload.js`：OpenAI 密钥状态与加密保存、官方模型目录获取、官方 Chat Completions 流式调用，保留上下文及文本/图片附件；连续解码 UTF-8 并按完整 SSE 行解析，避免分片丢字。
- 未改主程序、版本、依赖、真实用户设置或现有供应商密钥；未提交、推送或发布。

新 OpenAI 密钥使用插件命名空间下的 `direct-openai-api-key` 安全存储项，不写入普通 `ai-settings`。系统加密不可用时拒绝保存。

官方依据：[OpenAI 模型目录](https://developers.openai.com/api/docs/models)、[Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。账户实际可用模型、权限和额度以供应商返回为准。

## 测试与证据边界

执行：

```powershell
node --test tests/ai-assistant-openai.test.cjs tests/ai-assistant-electron.test.cjs tests/ai-provider-catalog-electron.test.cjs tests/ai-model-catalog.test.cjs
node tests/ai-provider-manager.test.js
node tests/ai-runtime.test.js
node tests/commander-router.test.js
node tests/commander-jev.test.js
```

10 项接口与隐藏 Electron 测试全部通过，模型解析/排序/搜索、共享运行时、总指挥本地路由与 Jev 回归通过。

真实助手 HTML 在隐藏 Electron 中加载，使用模拟服务和临时 appData/userData。验证三个搜索选择器、共享及本地列表排序、加载后排序、同 ID 跨供应商选择、刷新保留直连选择、快捷指令式程序化选择同步、密钥保存失败保留输入及成功后清空。

真实插件 preload 在隔离 VM 中验证 OpenAI 加密保存调用、目录加载、音频模型排除、模型 ID/上下文/图片载荷、按 3 字节分片的中文 SSE 完整解析、无密钥和 HTTP 401 报错。没有请求真实付费服务或读取真实密钥，不能据此认定用户账户权限和真实网络已验收。

父进程等待原生 Electron 退出后核验临时路径归属再清理。未打开或操作用户现有窗口。

JavaScript 语法及本任务范围 `git -c core.whitespace=cr-at-eol diff --check` 通过。

## 安装版同步

备份与最终哈希报告：

`%USERPROFILE%\.codex\artifacts\sanrenjz-assistant-models\20261108-214240\deployment.json`

共同步 6 个文件：

- `D:\RJ\sanrenjz\plugin_runtime\ai-provider-manager.js`
- `D:\RJ\sanrenjz\resources\app\plugin_runtime\ai-provider-manager.js`
- `D:\RJ\sanrenjz\plugins\sanrenjz.tools-ai\index.html`
- `D:\RJ\sanrenjz\plugins\sanrenjz.tools-ai\preload.js`
- `D:\RJ\sanrenjz\resources\app\software\sanrenjz.tools-ai\index.html`
- `D:\RJ\sanrenjz\resources\app\software\sanrenjz.tools-ai\preload.js`

同步前，助手文件与仓库 HEAD 一致，共享面板文件与上一轮部署哈希一致；没有覆盖额外安装文件修改。同步后 6 个文件与源码 SHA256 一致。

将 `AI_ASSISTANT_PLUGIN_DIR` 和 `AI_CATALOG_RUNTIME_DIR` 指向安装目录重跑，10 项测试通过。没有重启当前主程序或重载用户页面，需用户重新打开插件或重启程序加载新代码。

回滚可按备份中的相对路径恢复上述安装文件；仓库中只还原本任务改动，保留其他未提交工作。
