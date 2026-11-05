"""隐私检查必须拦截真实形状的凭据，且不能把索引与工作区混淆。"""
import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("public_privacy", Path(__file__).resolve().parents[1] / "scripts/check-privacy.py")
privacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(privacy)


class PrivacyTest(unittest.TestCase):
    def test_html_key_is_scanned(self):
        value = "x" * 24
        data = ("<script>const api_" + "key = '" + value + "';</script>").encode()
        findings = privacy.scan_text("example.html", data)
        self.assertTrue(any(item["rule"] == "KEY-001" for item in findings))
        self.assertNotIn(value, json.dumps(findings))

    def test_unicode_and_cjs(self):
        data = ("// 中文\nconst pass" + "word = '" + "x" * 12 + "';").encode()
        findings = privacy.scan_text("script.cjs", data)
        self.assertTrue(any(item["line"] == 2 for item in findings))

    def test_personal_path(self):
        data = ("C:" + "/Users/" + "private-user/project/file.js").encode()
        self.assertEqual(privacy.scan_text("file.js", data)[0]["rule"], "PII-USER-PATH")
        self.assertEqual(privacy.scan_text("file.js", b"C:/Users/Public/Documents"), [])

    def test_binary_skipped(self):
        self.assertEqual(privacy.scan_text("icon.png", b"\x89PNG\x00"), [])

    def test_utf16_and_quoted_json(self):
        data = json.dumps({"pass" + "word": "x" * 12}).encode("utf-16")
        self.assertTrue(any(item["rule"] == "QUOTED-CREDENTIAL" for item in privacy.scan_text("config.json", data)))

    def test_nonempty_python_config_blocked(self):
        manifest = "app/python-software/example/settings.json"
        config = "app/python-software/example/config.json"
        files = {manifest: b'{"config_file":"config.json"}', config: b'{}'}
        self.assertEqual(privacy.template_errors(files), [])
        files[config] = b'{"email":"person@example.com"}'
        self.assertEqual(privacy.template_errors(files)[0]["rule"], "NONEMPTY-PYTHON-CONFIG")
        del files[config]
        self.assertEqual(privacy.template_errors(files)[0]["rule"], "INVALID-PYTHON-CONFIG-TEMPLATE")

    def test_fingerprint_changes(self):
        prefix = "token = '"
        first = privacy.scan_text("fixture.js", (prefix + "a" * 12 + "'").encode())[0]
        second = privacy.scan_text("fixture.js", (prefix + "b" * 12 + "'").encode())[0]
        self.assertNotEqual(first["lineSha256"], second["lineSha256"])

    def test_private_paths_and_missing_manifest(self):
        names = [".env", "runtime/file.txt", "account-token.bin", "signing.pfx", "app/python-software/small_qmt_app/main.py"]
        rules = {item["rule"] for item in privacy.public_scope_errors(names)}
        self.assertTrue({"PRIVATE-DATA-PATH", "PRIVATE-PLUGIN", "CREDENTIAL-OR-USER-FILE", "MISSING-PUBLIC-MANIFEST"}.issubset(rules))

    def test_avatar_data_path_blocks_binary_without_blocking_modules(self):
        avatar_paths = ["account-avatar/avatar.json", "nested/account-avatar/photo.png", "nested/Account-Avatar/screenshot.png"]
        modules = ["app/account-avatar.js", "app/account-avatar-store.js"]
        rejected = {item["file"] for item in privacy.public_scope_errors(avatar_paths + modules) if item["rule"] == "PRIVATE-DATA-PATH"}
        self.assertEqual(rejected, set(avatar_paths))
        # 二进制照片没有可扫描文本，必须由目录范围检查拦截。
        self.assertEqual(privacy.scan_text(avatar_paths[1], b"\x89PNG\x00\x01\x02"), [])

    def test_staged_avatar_photo_and_manifest_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="sanrenjz-privacy-") as directory:
            root = Path(directory)
            (root / "config").mkdir()
            for name in ("public", "private"):
                (root / f"config/{name}-plugins.json").write_text(json.dumps({"tools": [], "python": []}), encoding="utf-8")
            (root / "account-avatar").mkdir()
            (root / "account-avatar/avatar.json").write_text('{"version":1}', encoding="utf-8")
            photo = b"\x89PNG\x00\x01\x02"
            (root / "account-avatar/photo.png").write_bytes(photo)
            (root / "app").mkdir()
            for module in ("account-avatar.js", "account-avatar-store.js"):
                (root / "app" / module).write_text("module.exports={};", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            output = io.StringIO()
            with patch.object(privacy, "ROOT", root), contextlib.redirect_stdout(output), patch.object(sys, "argv", ["check-privacy.py", "--staged"]):
                self.assertEqual(privacy.main(), 1)
            report = json.loads(output.getvalue())
            self.assertEqual(report["findings"], [])
            self.assertEqual({item["file"] for item in report["errors"]}, {"account-avatar/avatar.json", "account-avatar/photo.png"})
            self.assertEqual((root / "account-avatar/photo.png").read_bytes(), photo)

    def test_gitignore_excludes_avatar_directories_only(self):
        policy = privacy.ROOT / ".gitignore"
        with tempfile.TemporaryDirectory(prefix="sanrenjz-privacy-") as directory:
            root = Path(directory)
            (root / ".gitignore").write_bytes(policy.read_bytes())
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            # 不创建或读取真实照片；check-ignore直接核对不存在的合成路径。
            for name in ("account-avatar/avatar.json", "nested/account-avatar/photo.png", "app/software/public-tool/account-avatar/screenshot.png"):
                result = subprocess.run(["git", "-C", str(root), "check-ignore", "--no-index", "--quiet", name])
                self.assertEqual(result.returncode, 0, name)
            for name in ("app/account-avatar.js", "app/account-avatar-store.js"):
                result = subprocess.run(["git", "-C", str(root), "check-ignore", "--no-index", "--quiet", name])
                self.assertEqual(result.returncode, 1, name)

    def test_staged_reads_index(self):
        with tempfile.TemporaryDirectory(prefix="sanrenjz-privacy-") as directory:
            root = Path(directory)
            (root / "config").mkdir()
            for name in ("public", "private"):
                (root / f"config/{name}-plugins.json").write_text(json.dumps({"tools": [], "python": []}), encoding="utf-8")
            source = root / "fixture.js"
            source.write_text("console.log('safe');\n", encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            source.write_text("const api_" + "key = '" + "x" * 24 + "';\n", encoding="utf-8")
            with patch.object(privacy, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
                with patch.object(sys, "argv", ["check-privacy.py", "--staged"]):
                    self.assertEqual(privacy.main(), 0)
                with patch.object(sys, "argv", ["check-privacy.py", "--git"]):
                    self.assertEqual(privacy.main(), 1)

    def test_allowlist_requires_reason(self):
        with tempfile.TemporaryDirectory(prefix="sanrenjz-privacy-") as directory:
            root = Path(directory)
            (root / "config").mkdir()
            (root / "config/privacy-allowlist.json").write_text(json.dumps({"entries": [{"file": "fixture.js", "rule": "KEY-001", "lineSha256": hashlib.sha256(b"fixture").hexdigest()}]}), encoding="utf-8")
            with patch.object(privacy, "ROOT", root), self.assertRaises(ValueError):
                privacy.load_allowlist()

    def test_staged_policy_ignores_unstaged_allowlist(self):
        with tempfile.TemporaryDirectory(prefix="sanrenjz-privacy-") as directory:
            root = Path(directory)
            (root / "config").mkdir()
            for name in ("public", "private"):
                (root / f"config/{name}-plugins.json").write_text(json.dumps({"tools": [], "python": []}), encoding="utf-8")
            data = ("api_" + "key = '" + "x" * 24 + "'").encode()
            (root / "fixture.js").write_bytes(data)
            policy_file = root / "config/privacy-allowlist.json"
            policy_file.write_text('{"entries":[]}', encoding="utf-8")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            finding = privacy.scan_text("fixture.js", data)[0]
            policy_file.write_text(json.dumps({"entries": [{"file": "fixture.js", "rule": finding["rule"], "lineSha256": finding["lineSha256"], "reason": "unit fixture"}]}), encoding="utf-8")
            with patch.object(privacy, "ROOT", root), contextlib.redirect_stdout(io.StringIO()):
                with patch.object(sys, "argv", ["check-privacy.py", "--staged"]):
                    self.assertEqual(privacy.main(), 1)
                with patch.object(sys, "argv", ["check-privacy.py", "--git"]):
                    self.assertEqual(privacy.main(), 0)


if __name__ == "__main__":
    unittest.main()
