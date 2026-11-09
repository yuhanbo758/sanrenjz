# 双平台 Git 同步

GitHub 保存公开源码，家庭 Gitea 的同名私有仓库保存较完整的开发源码，包括非开源插件、未分类插件及其专用测试和脚本。两个仓库使用独立历史，不互相合并。

## GitHub

首次克隆或当前目录首次配置：

```powershell
git config core.hooksPath .githooks
```

在用户授权的提交推送任务中，先检查工作区，保留已有修改，按 `config/public-plugins.json` 确定公开范围。没有明确开源授权的新插件默认私有；不得为使检查通过而加入公开清单。私有专用测试、脚本和文档也应单独忽略。

```powershell
python -X utf8 scripts/check-privacy.py --git
node scripts/audit-public-scope.js
git add --all
python -X utf8 scripts/check-privacy.py --staged
git commit -m "优化：说明本次改动"
git push origin main
```

`pre-commit` 检查实际索引，`pre-push` 检查待公开提交历史及最终树，避免先提交敏感文件、下一提交删除后仍泄露历史。公开构建暂存目录继续由打包脚本和 CI 独立检查。原始扫描报告只存本机。

仅插件、文档或测试变动不会触发桌面安装包工作流；宿主变动仍进入检查。当前版本已有 Release 时仅同步源码，需发布时明确修改版本号后再走完整四平台验收，不覆写已发布版本。

## Gitea

```powershell
# 默认预览文件数量、大小和插件清单，不上传
python -X utf8 scripts/gitea-private-sync.py
# 当前任务已授权同步时执行
python -X utf8 scripts/gitea-private-sync.py --push
```

脚本创建或核对同名私有仓库并关闭 Actions。优先使用密码管理 `gitea/backup-token`，兼容 gitea-git-backup skill 已有的会话认证环境。凭据不写入源码、Git URL 或 Git 配置。其他设备需自行配置认证。

私有 Git 数据库在 `.git/gitea-private.git`，使用独立索引从当前工作区构建全量源码快照，公开工作区、分支和索引不切换。可重复执行，没有变化不产生新提交；不强推，发现其他设备提交则停止并要求先合并源码。

Gitea 不按公开插件名单过滤、不运行公开隐私扫描。备份包括插件源码、静态资源、`.enc` 程序及开发文档；排除依赖目录、Python 运行时、构建输出、本机运行会话、日志、数据库、私钥和环境凭据文件。需要运行时先按项目锁文件安装依赖；业务数据库、密码库和运行资料使用独立备份流程。

从 Gitea 恢复时可克隆到独立目录。该克隆含私有历史，**禁止直接修改远端后推往 GitHub**。需要继续公开开发时，另克隆干净的 GitHub 仓库，再复制所需源码，按公开范围重新检查、提交。
