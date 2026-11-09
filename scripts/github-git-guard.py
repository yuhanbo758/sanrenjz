#!/usr/bin/env python3
"""GitHub 提交与推送门禁；逐个扫描待公开提交，避免历史中夹带私有文件。"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def git(*args, env=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, env=env).decode().strip()


def scan(env=None):
    env = dict(os.environ if env is None else env)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    subprocess.run([sys.executable, '-X', 'utf8', str(ROOT / 'scripts/check-privacy.py'), '--staged'],
                   cwd=ROOT, env=env, check=True)


def main():
    if sys.argv[1:] == ['--staged']:
        scan()
        return
    if len(sys.argv) != 4 or sys.argv[1] != '--push':
        raise ValueError('使用 --staged 或 --push <remote> <url>')
    # 本仓库只向固定的公开 GitHub 地址推送；私有历史在另一个 Git 数据库中。
    url = sys.argv[3].removesuffix('.git').rstrip('/')
    if url not in ('https://github.com/yuhanbo758/sanrenjz', 'git@github.com:yuhanbo758/sanrenjz'):
        raise ValueError('公开仓库仅允许推送既定 GitHub 地址；Gitea 请使用独立私有同步脚本')
    commits = set()
    for line in sys.stdin:
        local_ref, local_sha, remote_ref, remote_sha = line.split()
        if set(local_sha) == {'0'}:
            continue
        args = ['rev-list', local_sha]
        if set(remote_sha) != {'0'}:
            args.append('^' + remote_sha)
        else:
            args += ['--not', '--remotes=origin']
        commits.update(git(*args).splitlines())
        # 即使没有新增提交，也验证最终公开树。
        commits.add(git('rev-parse', local_sha + '^{commit}'))
    with tempfile.TemporaryDirectory(prefix='sanrenjz-public-index-') as folder:
        env = os.environ.copy()
        env['GIT_INDEX_FILE'] = str(Path(folder) / 'index')
        for commit in sorted(commits):
            git('read-tree', commit, env=env)
            print('检查公开提交：' + commit, flush=True)
            scan(env)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print('GitHub 隐私检查未通过：' + str(error), file=sys.stderr)
        sys.exit(1)
