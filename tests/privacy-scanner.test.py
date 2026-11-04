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
