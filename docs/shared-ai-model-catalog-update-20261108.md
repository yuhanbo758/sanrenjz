# 共享 AI 供应商模型目录更新

日期：2026-11-08。用户已明确授权修改共享运行时并同步安装版。

## 使用方式

重启三人聚智，打开共享 AI 供应商配置，在新增或编辑供应商表单中点击“测试”右侧的“更新模型”。填写的新密钥优先使用；编辑已保存供应商且地址未变时，可直接复用已有密钥。

更新结果先进入模型列表草稿，核对后点击“保存供应商”生效。获取时不要求预先填写模型，不修改持久化配置或密钥。

相同 ID 保留原有自定义名称、能力及接口类型；供应商未返回的旧模型从草稿中移除。模型目录可见不等于真实调用权限、额度或接口能力均已验证，可继续使用已有“测试”按钮检查。

## 实现

- `app/plugin_runtime/ai-provider-manager.js`：新增“更新模型”按钮、进度与待保存提示；失败保留原列表；等待期间切换供应商、预设或修改表单时丢弃旧结果，避免覆盖新输入。
- `app/plugin_runtime/ai-runtime.js`：新增 `listProviderModels`，支持 OpenAI 兼容及 Anthropic 目录、模型归一化、分页去重、超时与错误处理。OpenCode 托管供应商继续通过既有模型同步接口处理。
- 保留供应商 Base URL 前缀，例如智谱 `/api/paas/v4`、百炼 `/compatible-mode/v1`、OpenRouter `/api/v1`，不限定 OpenAI 域名。
- 根据接口采用 Bearer、Anthropic 的 `x-api-key` 或 MiMo 的 `api-key` 鉴权。复用已有密钥时校验原地址；目录请求拒绝重定向，不回显原始服务响应或密钥。
- 优先采用返回的输入模态。未提供能力元数据的新模型保守地按文本处理，专用 ASR 模型按音频处理；不根据“多模态”名称认定支持图片或音频。
- 过滤明确不适用于当前接口的嵌入、重排、图片生成、视频生成、语音合成及实时专用模型；普通实时流不属于本功能新增范围。
- 未开放标准模型目录或返回不兼容格式的供应商会明确报告失败，保留手工维护入口。并非每个供应商都提供可查询目录，不能保证任意自定义网关均可自动获取。

参考官方协议：[OpenAI Models](https://developers.openai.com/api/reference/resources/models/methods/list)、[Claude Models](https://platform.claude.com/docs/en/api/typescript/models/list)、[DeepSeek Models](https://api-docs.deepseek.com/api/list-models/)、[OpenRouter Models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)。

## 验证

执行：

```powershell
node --test tests/ai-model-catalog.test.cjs tests/ai-provider-catalog-electron.test.cjs
node tests/ai-provider-manager.test.js
node tests/ai-runtime.test.js
```

新增 6 项目录及 Electron 测试通过，原有目录解析和共享运行时测试通过。覆盖本地真实 HTTP、兼容前缀、鉴权、分页去重、OpenCode 路由、元数据归一化、专用任务过滤、401/403/404/405/429/500、HTML 页面、空目录、超时及分页循环。

隐藏 Electron 中实际点击按钮验证：位置在“测试”右侧、重复点击拦截、更新后待保存、保存后生效、自定义元数据保留、错误不覆盖、切换供应商和修改输入时旧结果失效；480/700 像素布局通过。

父进程创建临时 appData/userData；不加载私有业务插件，不使用真实密钥，不请求真实供应商服务；等待原生 Electron 退出后核验临时目录归属再清理。

两文件 JavaScript 语法检查和本任务范围 `git -c core.whitespace=cr-at-eol diff --check` 通过。现有工作区改动保留，未提交、推送或发布。

## 安装版同步

共享运行时在主程序启动时从 resources 复制到插件运行目录，因此两个位置均已同步，避免重启后被旧资源覆盖：

- `D:\RJ\sanrenjz\plugin_runtime`
- `D:\RJ\sanrenjz\resources\app\plugin_runtime`

各同步 `ai-runtime.js`、`ai-provider-manager.js`，共 4 个文件；SHA256 与当前源码一致。安装文件同步前与仓库 HEAD 基线一致。

备份及最终哈希记录：`%USERPROFILE%\.codex\artifacts\sanrenjz-model-catalog\20261108-160430\deployment.json`。

测试设置 `AI_CATALOG_RUNTIME_DIR` 指向安装目录重跑，6 项目录与隐藏 Electron 测试通过。未重启用户当前运行进程，未更改现有供应商配置或密钥，未进行真实供应商账户验收。

回滚可按备份目录的两个相对路径恢复上述 4 个安装文件；仓库只还原本任务修改，保留原有未提交工作。
