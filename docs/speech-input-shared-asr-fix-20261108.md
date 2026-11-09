# AI 语音输入法共享模式转写配置修复

日期：2026-11-08。

## 已确认的原因

- 用户实际弹窗为“语音处理失败：OpenAI 兼容 API URL 未配置”。
- 当前插件选择 `shared-model`，处理模型为 `opencode:openai / gpt-6-luna`，转写来源为 `openai-compatible`。
- 当前活跃兼容配置的地址、密钥及语音模型均为空。只核对字段是否存在，未输出配置内容或密钥。
- 来源项目与本项目的语音插件在修复前没有源码差异；旧应用的插件存储存在完整语音配置，新应用缺少这部分配置。
- 共享模式仍需要语音转写阶段，但原界面隐藏了所有语音服务配置，无法在当前模式下补齐。
- 官方 GPT-6 Luna 文档列明不支持音频输入；OpenAI 文件转写使用独立模型与 `/audio/transcriptions` 接口。不能把当前共享文字模型的选择当作完整语音配置。

参考：[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[OpenAI 文件转写](https://developers.openai.com/api/docs/guides/speech-to-text)。

## 修改

- `app/software/sanrenjz-tools-speech_input/renderer.js`：共享模式显示所选语音来源的配置；切换来源与兼容配置时刷新状态，填写时提示待保存；保存、开始录音和导入转写时检查缺少字段，配置不完整时不申请麦克风、不发送音频。
- `app/software/sanrenjz-tools-speech_input/index.html`：解释转写与共享文本处理的两步关系，补充可直接操作的配置状态和 OpenAI 转写配置说明。
- `app/software/sanrenjz-tools-speech_input/preload.js`：普通兼容配置与共享音频配置共用专用转写模型上传逻辑；支持 `gpt-transcribe`，兼容既有转写模型；继续保留 MiMo 等音频聊天请求。
- 不修改主程序、插件版本或共享模型选择，不迁移旧版密钥或其他设置。

## 验证

源码执行：

```powershell
node --check app/software/sanrenjz-tools-speech_input/renderer.js
node --check app/software/sanrenjz-tools-speech_input/preload.js
node --test tests/speech-input-transcription.test.cjs tests/speech-input-isolated.test.cjs
```

4 个测试全部通过，包括：

1. 隐藏 Electron 中实际切换四种语音来源及配置区；验证空配置在录音、导入转写前拦截；补齐测试配置后转写再调用共享模型；原有工作台、快捷键和旧设置迁移回归；620/800 像素布局。
2. OpenAI 专用模型使用 multipart 文件上传，普通兼容配置及共享音频配置使用同一转写接口；兼容三种 API 地址写法。
3. MiMo 原有请求格式不变。
4. 拒绝空音频并传回服务错误。

父进程创建临时 appData/userData，等待原生 Electron 退出后核验归属并清理。测试不注册真实键盘钩子，不启动 LAN 服务、不操作真实插件存储，也不请求真实模型。

本任务文件执行 `git -c core.whitespace=cr-at-eol diff --check` 通过。工作区原有改动保留，未提交或推送。

## 安装版同步

目标：`D:\RJ\sanrenjz\plugins\sanrenjz-tools-speech_input`。

已备份并同步 `index.html`、`renderer.js`、`preload.js`，三个文件的源文件和安装文件 SHA256 一致。同步前安装文件与仓库 HEAD 的相应文件一致。

备份与哈希记录：`%USERPROFILE%\.codex\artifacts\sanrenjz-speech-fix\20261108-145934\deployment.json`。

设置 `SPEECH_INPUT_PLUGIN_DIR` 指向上述安装目录后，重新执行同一组测试，4 个全部通过。

## 实际使用边界

- 未重启或重载用户当前运行中的三人聚智进程；已驻留的插件需要退出主程序后重新打开才能加载新文件。
- 当前真实转写配置仍为空；本次修复使配置可以直接填写并提前报告缺项，没有虚构可用服务。
- 未获旧版 MiMo 配置迁移授权，因此未导入旧版配置。
- 若全程使用 OpenAI，仍须为第一步配置能够调用 OpenAI 转写接口的 API 地址、API Key 和转写模型。当前共享 GPT-6 选择保留为第二步。
- 未进行真实麦克风和付费 API 验收；隔离回归通过不等于真实服务已可调用。

回滚可将备份目录中的三个文件复制回安装插件目录，并恢复仓库中本任务对应的改动；应保留其他任务的工作区修改。
