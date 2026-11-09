# AI 语音输入法新增 OpenAI 官方入口

日期：2026-11-08。

## 行为与使用方式

“AI 模型”下拉列表增加“OpenAI 语音识别（官方 API）”。选择后填写 OpenAI API Key，点击“保存设置”，即可录音或导入音频进行转写。默认模型为 `gpt-transcribe`，官方地址预设为 `https://api.openai.com/v1`；插件按文件上传方式调用 `/audio/transcriptions`。

需要共享 GPT-6 Luna 润色时，选择“共享 AI 模型处理语音”，处理模型选择 GPT-6 Luna，语音识别来源选择新增的“OpenAI 官方语音识别”。两种入口使用同一份 OpenAI 加密密钥，不重复配置。

“共享目录中的音频模型”只复用共享配置中已添加且声明音频输入的可用直连模型，不代表所有供应商的全部语音模型。已过滤已知不能通过当前接口识别音频的普通 MiMo 模型及 OpenCode 音频选项；MiMo 专用 ASR、OpenAI 专用转写等可用直连模型仍可列出。

官方依据：[OpenAI 文件转写](https://developers.openai.com/api/docs/guides/speech-to-text)、[GPT-Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)。

## 实现范围

- 插件 `index.html`：增加独立模型入口、API Key 输入和默认转写模型；在共享语音来源中增加官方 OpenAI。
- 插件 `renderer.js`：增加默认模型设置、密钥状态显示、保存失败重试和空密钥拦截；连接直接转写与共享文本处理两条流程。
- 插件 `preload.js`：复用宿主已有 `plugin-secret-get/set` 加密接口；只向页面返回是否已保存，不回传密钥；系统加密不可用时拒绝写入；请求固定发送到官方转写接口。
- API Key 不写入普通插件 settings，不加入局域网配置同步载荷，也不复制其他供应商的密钥。
- 未改主程序、共享运行时、版本、依赖及用户当前设置。未提交或推送。

## 验证结果

```powershell
node --check app/software/sanrenjz-tools-speech_input/renderer.js
node --check app/software/sanrenjz-tools-speech_input/preload.js
node --test tests/speech-input-transcription.test.cjs tests/speech-input-isolated.test.cjs
```

源码和安装目录分别执行，均为 7 个测试通过。覆盖：

- 隐藏 Electron 中实际选择 OpenAI 入口、默认模型、填写并保存测试密钥、普通设置不含测试密钥、保存失败保留输入、留空保留已有密钥。
- OpenAI 独立转写及转写后交给共享文本模型；空密钥时不发送请求。
- 官方转写 URL、multipart 文件上传、默认转写模型、服务错误传回。
- 不支持的普通文本模型、加密存储不可用及无效共享音频模型被拒绝。
- MiMo 旧有音频聊天请求、原工作台与快捷键、620/800 像素布局回归。

另已只读检查安装版 `resources/app.asar`，确认具备本功能复用的两个密钥 IPC。仅测试夹具使用虚构密钥；没有读取用户 OpenAI API Key，也没有调用真实付费模型。

## 安装版同步与回滚

已备份并同步三个插件文件到：

`D:\RJ\sanrenjz\plugins\sanrenjz-tools-speech_input`

三个源文件与安装文件 SHA256 一致。备份和同步报告：

`%USERPROFILE%\.codex\artifacts\sanrenjz-speech-fix\20261108-152053-openai\deployment.json`

没有操作用户原有窗口或重启主程序；实际运行中的页面须重新打开以加载新文件。真实麦克风、真实 API Key 权限及额度未验收。

回滚时可用该备份目录中的 `index.html`、`renderer.js`、`preload.js` 恢复安装插件；仓库中仅还原本任务对应修改，保留其他任务改动。
