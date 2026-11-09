"""验证公开推送不能夹带已删除的敏感历史，私有范围保留非开源插件。"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


guard = module('guard', 'github-git-guard.py')
backup = module('backup', 'gitea-private-sync.py')


class DualGitTests(unittest.TestCase):
    def test_private_candidates_include_unclassified_plugins(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            keep = ['app/software/private-plugin/main.js', 'app/python-software/new-private/main.enc',
                    'tests/private-feature.test.js', 'scripts/private-python/tool.py', '.github/workflows/package.yml']
            skip = ['app/software/private-plugin/.runtime/session.json', 'node_modules/pkg/index.js',
                    '.git/gitea-private.git/objects/file', 'dist/output.zip', '.env', 'plugin-data/user.db']
            for name in keep + skip:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('fixture', encoding='utf8')
            self.assertEqual(set(backup.candidates(root)), set(keep))

    def test_public_history_is_scanned_even_when_head_is_clean(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def git(*args):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null',
                    '-c', 'user.name=Test', '-c', 'user.email=test@example.com', *args], cwd=root).decode().strip()
            git('init', '--initial-branch=main')
            for name in ['scripts/check-privacy.py', 'scripts/privacy/scan_secrets.py']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
            (root / 'config').mkdir()
            for kind in ['public', 'private']:
                (root / f'config/{kind}-plugins.json').write_text(json.dumps({'tools': [], 'python': []}))
            file = root / 'fixture.js'
            file.write_text('// clean baseline')
            git('add', '.')
            git('commit', '-qm', 'baseline')
            baseline = git('rev-parse', 'HEAD')
            # 动态构造只用于隔离测试的秘密形状，不在测试源码放入真实凭据。
            file.write_text('const api_' + 'key = ' + repr('z' * 24) + ';')
            git('add', '.')
            git('commit', '-qm', 'sensitive intermediate fixture')
            file.write_text('// clean head')
            git('add', '.')
            git('commit', '-qm', 'remove fixture')
            head = git('rev-parse', 'HEAD')
            updates = f'refs/heads/main {head} refs/heads/main {baseline}\n'
            with patch.object(guard, 'ROOT', root), patch.object(sys, 'argv',
                 ['guard', '--push', 'origin', 'https://github.com/yuhanbo758/sanrenjz.git']), \
                 patch.object(sys, 'stdin', io.StringIO(updates)), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(subprocess.CalledProcessError):
                    guard.main()
            # 门禁使用独立临时索引，不能污染原索引或工作区。
            self.assertEqual(git('status', '--porcelain'), '')
            self.assertEqual(git('rev-parse', 'HEAD'), head)

    def test_public_guard_refuses_private_remote(self):
        with patch.object(sys, 'argv', ['guard', '--push', 'gitea', 'http://private.invalid/repo.git']):
            with self.assertRaises(ValueError):
                guard.main()


if __name__ == '__main__':
    unittest.main()
