#!/usr/bin/env python3
"""独立 Git 数据库备份完整开发源码，不把私有提交接入 GitHub 历史。"""
import argparse
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.runtime', '.cache', '.downloads',
             '.venv', 'venv', 'logs', 'coverage', '.pytest_cache', '.mypy_cache'}
SKIP_ROOTS = {'dist', 'build-output', 'runtime', 'python', 'plugins', 'python-plugins',
              'user-data', 'plugin-data', 'plugin-configs', 'python-plugin-configs',
              'migration-backups', '.codex_backups', 'privacy-reports', '.tmp', 'temp',
              'account-avatar'}
SKIP_SUFFIXES = {'.log', '.tmp', '.temp', '.pyc', '.db', '.sqlite', '.sqlite3', '.pem',
                 '.key', '.pfx', '.p12', '.keystore', '.jks', '.exe', '.dmg', '.appimage',
                 '.bak', '.backup', '.old'}


def candidates(root):
    for folder, dirs, files in os.walk(root, followlinks=False):
        current = Path(folder)
        dirs[:] = sorted(name for name in dirs if name.lower() not in SKIP_DIRS
                         and not (current == root and name.lower() in SKIP_ROOTS)
                         and not (current / name).is_symlink()
                         and not getattr(current / name, 'is_junction', lambda: False)())
        for name in sorted(files):
            file = current / name
            if file.is_symlink() or file.suffix.lower() in SKIP_SUFFIXES:
                continue
            if name.lower() in {'.git', '.env', 'cookies', 'login data', 'account-token.bin'}:
                continue
            if name.lower().endswith('-secrets.bin') or name.startswith('.env.') and name != '.env.example':
                continue
            yield file.relative_to(root).as_posix()


def credentials():
    # 优先统一密码管理；兼容 Gitea skill 已配置的会话环境，不落盘秘密。
    from credential_provider import get_login_credentials
    try:
        return (*get_login_credentials('gitea', 'backup-token'), True)
    except KeyError:
        pass
    token = os.environ.get('GITEA_BACKUP_TOKEN')
    secret = token or os.environ.get('GITEA_BACKUP_PASSWORD')
    if not secret:
        raise RuntimeError('请配置 gitea/backup-token 凭据或现有 Gitea skill 认证环境')
    return os.environ.get('GITEA_BACKUP_USER', ''), secret, bool(token)


def api(base, route, auth, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(base + '/api/v1/' + route, data=data,
              headers={'Authorization': auth, 'Content-Type': 'application/json'},
              method=method or ('GET' if data is None else 'POST'))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # 服务响应可能包含敏感上下文；错误只打印状态码。
        raise RuntimeError(f'Gitea API HTTP {error.code}') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--push', action='store_true', help='创建/核验私有仓库、提交并推送；默认只预览范围')
    args = parser.parse_args()
    names = list(candidates(ROOT))
    sizes = [(ROOT / name).stat().st_size for name in names]
    print(json.dumps({'files': len(names), 'bytes': sum(sizes), 'largestBytes': max(sizes, default=0),
                      'toolsPlugins': sorted({n.split('/')[2] for n in names if n.startswith('app/software/')}),
                      'pythonPlugins': sorted({n.split('/')[2] for n in names if n.startswith('app/python-software/')})}, ensure_ascii=False))
    if not args.push:
        return
    user, secret, token = credentials()
    base = os.environ.get('GITEA_BACKUP_URL', 'http://192.168.31.143:10082').rstrip('/')
    parsed = urllib.parse.urlsplit(base)
    if parsed.username or parsed.password or parsed.hostname not in {'192.168.31.143'}:
        raise RuntimeError('只允许既定家庭 Gitea 地址，且 URL 不得包含凭据')
    basic = base64.b64encode(f'{user}:{secret}'.encode()).decode()
    auth = 'token ' + secret if token else 'Basic ' + basic
    owner = api(base, 'user', auth)['login']
    route = 'repos/' + urllib.parse.quote(owner, safe='') + '/sanrenjz'
    try:
        repository = api(base, route, auth)
    except RuntimeError as error:
        if str(error) != 'Gitea API HTTP 404':
            raise
        repository = api(base, 'user/repos', auth, {'name': 'sanrenjz', 'private': True,
                         'auto_init': False, 'description': '三人聚智完整开发源码私有备份（包含非开源插件）'})
    if repository.get('private') is not True:
        raise RuntimeError('目标不是私有仓库，停止上传')
    api(base, route, auth, {'has_actions': False}, method='PATCH')
    repository = api(base, route, auth)
    if repository.get('private') is not True or repository.get('has_actions') is not False:
        raise RuntimeError('未能确认私有仓库且 Actions 已禁用')
    public_git = Path(subprocess.check_output(['git', 'rev-parse', '--absolute-git-dir'], cwd=ROOT).decode().strip())
    private_git = public_git / 'gitea-private.git'
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    # 只在子进程配置中传入认证头，不使用含秘密的 URL 或命令参数。
    env.update({'GIT_CONFIG_COUNT': '2', 'GIT_CONFIG_KEY_0': 'http.extraHeader',
                'GIT_CONFIG_VALUE_0': 'Authorization: Basic ' + base64.b64encode(f'{owner}:{secret}'.encode()).decode(),
                'GIT_CONFIG_KEY_1': 'credential.helper', 'GIT_CONFIG_VALUE_1': '',
                'GIT_TERMINAL_PROMPT': '0', 'GIT_LITERAL_PATHSPECS': '1'})
    def git(*values, data=None, allowed=(0,)):
        command = ['git', '--git-dir=' + str(private_git), '--work-tree=' + str(ROOT), *values]
        result = subprocess.run(command, cwd=ROOT, env=env, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode not in allowed:
            raise RuntimeError('私有 Git 操作失败：' + values[0] + f'（退出码 {result.returncode}）')
        return result.stdout.decode().strip()
    if not private_git.exists():
        result = subprocess.run(['git', 'init', '--bare', '--initial-branch=main', str(private_git)],
                                cwd=ROOT, capture_output=True)
        if result.returncode:
            raise RuntimeError('初始化独立私有 Git 数据库失败')
        git('config', 'core.bare', 'false')
        git('config', 'core.hooksPath', str(private_git / 'disabled-hooks'))
        git('config', 'user.name', subprocess.check_output(['git', 'config', 'user.name'], cwd=ROOT).decode().strip())
        git('config', 'user.email', subprocess.check_output(['git', 'config', 'user.email'], cwd=ROOT).decode().strip())
    remote = base + '/' + urllib.parse.quote(owner, safe='') + '/sanrenjz.git'
    git('config', 'remote.origin.url', remote)
    git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    git('fetch', 'origin')
    local = git('rev-parse', '--verify', 'refs/heads/main', allowed=(0, 128))
    remote_head = git('rev-parse', '--verify', 'refs/remotes/origin/main', allowed=(0, 128))
    if remote_head and local and remote_head != local:
        try:
            git('merge-base', '--is-ancestor', remote_head, local)
        except RuntimeError:
            raise RuntimeError('Gitea main 有其他设备改动；先核对合并，禁止覆盖') from None
    if remote_head and not local:
        git('update-ref', 'refs/heads/main', remote_head)
    # 从空索引构建全量快照，使删除也能同步；绝不切换公共工作树或共享对象。
    git('read-tree', '--empty')
    git('add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul', data=('\0'.join(names) + '\0').encode())
    tree = git('write-tree')
    prior = git('rev-parse', '--verify', 'refs/heads/main', allowed=(0, 128))
    prior_tree = git('rev-parse', prior + '^{tree}') if prior else ''
    if tree != prior_tree:
        parents = ['-p', prior] if prior else []
        commit = git('commit-tree', tree, *parents, '-m', 'backup: sync complete private project sources')
        git('update-ref', 'refs/heads/main', commit, prior or '0' * 40)
    git('push', 'origin', 'refs/heads/main:refs/heads/main')
    head = git('rev-parse', 'refs/heads/main')
    actual = git('ls-remote', 'origin', 'refs/heads/main').split()[0]
    if actual != head:
        raise RuntimeError('远端私有提交校验失败')
    print(json.dumps({'url': repository['html_url'], 'commit': head, 'private': True, 'actions': False}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
