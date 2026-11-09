# 效率插件更新保留运行资料与开发 Skill 调整

2026-11-08。用户明确要求插件更新自动保留 `.runtime`，并要求后续插件开发将代码、资源及可再生成文件优先放在插件内，配置目录保持精简。

## 行为与修改范围

- `app/plugin_store.js` 的 `replacePluginDirectory` 统一处理目录替换。先暂存新版代码，旧插件移至备份目录，再将原 `.runtime` 原地移入新版；提交后只删除旧代码。不会为了保留登录状态复制整份大缓存。
- `app/plugin-import.js` 的覆盖导入调用同一事务；商店 ZIP 经 `mergedHost.importArchive` 进入同一导入方法。启动时的内置插件版本/日期更新也使用同一事务。
- 包内 `.runtime` 不导入、不覆盖或合并本机会话；无本机会话的首次安装也忽略包内运行资料。用户插件迁移仍保留其已有 `.runtime`。入口不能指向被排除的 `.runtime` 文件。
- 复制、备份、运行目录转移及提交失败时恢复旧程序和会话；回滚本身失败保留恢复目录并返回位置。提交成功后的旧代码清理失败保留新版与会话并返回清理提示，避免不完整回滚。
- 运行中的插件继续拒绝覆盖，目标及 `.runtime` 链接或异常文件拒绝更新；不修改卸载语义、Python 插件更新、用户配置或业务数据库。
- `.gitignore` 排除效率插件的 `.runtime`。直接构建的 extraResources 明确排除该目录；公开包审计独立拒绝 `.runtime`。既有构建暂存复制器已经排除点号目录，新增测试核验其真实暂存结果。
- `AGENTS.md` 记录长期约定；electron-plugin-developer Skill 及宿主索引同步说明配置、固定代码、可再生成运行文件和重要业务数据的不同保存责任。用户文档、知识库、交易账本及凭据继续使用各自的数据和安全存储，不因“非配置”而成为随插件可清理的内容。

## 验证结果

- `node --test tests/plugin-runtime-update.test.js tests/merged-import.test.js`：15 项通过，其中 13 项覆盖运行资料保留、ZIP、版本升级、初次安装、占用、符号链接、复制失败、各阶段回滚、回滚失败恢复材料及清理失败。
- `node tests/plugin-store.test.js`：通过，保留原有版本/日期比较、不降级、沿用用户目录及用户插件迁移行为。
- `node tests/package-scope.test.js`：通过；实际暂存排除 `.runtime` 且不改动源文件，产物审计拒绝运行资料。另以当前 minimatch 实现核验直接构建的排除规则匹配目录和其中的文件。
- `node tests/reading-learning-profile-browser.test.js`：源码与安装副本各通过 7 项真实 Edge 隔离检查，包含执行真实目录更新后 HttpOnly Cookie 和 localStorage 继续可用；只访问本机 HTTP 服务，不测试真实阅读网站账号。
- Skill 的 `quick_validate.py`、`scripts/test_preload_template.cjs` 通过。JavaScript 语法检查及本次核心文件差异空白检查通过。

## 安装态与生效条件

已备份并同步 `D:/RJ/sanrenjz/resources/app/plugin-import.js` 和 `plugin_store.js`，两个安装模块 SHA256 均与源码一致。安装态 13 项更新专项测试通过；真实 Edge 隔离检查使用安装插件与安装态更新模块。未更新 ASAR、版本或依赖，未重启用户正在运行的宿主。

宿主模块在进程启动时加载，需重启“三人聚智”一次才会使用新逻辑。用户现有阅读学习插件 `.runtime` 及配置未参与测试或覆盖。

备份：仓库 `.codex_backups/plugin-runtime-update-20261108`，含原源码、原安装模块和原 Skill。回滚时恢复其中对应文件并重启宿主；保留安装插件的 `.runtime`。未提交、推送或发布，保留其他任务的未提交修改。未做 macOS/Linux 实机验证。
