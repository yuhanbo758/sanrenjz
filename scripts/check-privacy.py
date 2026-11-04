#!/usr/bin/env python3
"""检查准确的 Git/暂存公开范围，仅输出位置，避免扫描本身泄漏凭据。"""
import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("privacy_scanner", ROOT / "scripts/privacy/scan_secrets.py")
scanner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = scanner
spec.loader.exec_module(scanner)


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args], stderr=subprocess.PIPE)


def load_policy(name, staged=False, optional=False):
    filename = f"config/{name}.json"
    if staged:
        try:
            data = git("show", f":{filename}")
        except subprocess.CalledProcessError:
            if optional:
                return None
            raise ValueError(f"索引缺少扫描策略：{filename}") from None
        return json.loads(data.decode("utf-8-sig"))
    source = ROOT / filename
    if optional and not source.exists():
        return None
    return json.loads(source.read_text(encoding="utf-8-sig"))


def load_allowlist(staged=False):
    policy = load_policy("privacy-allowlist", staged=staged, optional=True)
    if policy is None:
        return {}
    entries = policy["entries"]
    result = {}
    for entry in entries:
        if not entry.get("reason") or not re.fullmatch(r"[a-f0-9]{64}", entry["lineSha256"]):
            raise ValueError("隐私误报清单缺少复核原因或校验值")
        result[(entry["file"], entry["rule"], entry["lineSha256"])] = entry["reason"]
    return result


def scan_text(name, data):
    # 二进制不按文本解码；源码的 UTF-8/旧插件 GBK 均保留扫描覆盖。
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        content = data.decode("utf-16")
    else:
        if b"\x00" in data[:8192]:
            return []
        try:
            content = data.decode("utf-8-sig")
        except UnicodeDecodeError:
            content = data.decode("gb18030", errors="replace")
    lines = content.splitlines()
    findings = []
    for rule, _, pattern, severity, _ in scanner.COMPILED_RULES:
        if scanner.SEVERITY_LEVELS[severity] < scanner.SEVERITY_LEVELS["medium"]:
            continue
        for match in pattern.finditer(content):
            number = content[:match.start()].count("\n") + 1
            line = lines[number - 1] if number <= len(lines) else ""
            findings.append({"file": name, "line": number, "rule": rule, "severity": severity,
                             "lineSha256": hashlib.sha256(line.encode("utf-8")).hexdigest()})
    # 技能通用赋值规则不覆盖带引号的JSON键；补齐对象字面量中的凭据字段。
    quoted_credential = re.compile(r'''(?i)(['"])(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|pwd|secret|token|authorization|cookie)\1\s*:\s*(['"])([^'"\r\n]{6,})\2''')
    for match in quoted_credential.finditer(content):
        number = content[:match.start()].count("\n") + 1
        findings.append({"file": name, "line": number, "rule": "QUOTED-CREDENTIAL", "severity": "medium",
                         "lineSha256": hashlib.sha256(lines[number - 1].encode("utf-8")).hexdigest()})
    # 只查实际用户目录；通用 Users/Public、示例地址和许可证署名不作隐私误报。
    user_path = re.compile(r"(?i)[a-z]:[/\\]+Users[/\\]+(?!Public\b|Default\b|<|\$|example\b)[A-Za-z0-9_.-]+[/\\]")
    for number, line in enumerate(lines, 1):
        if user_path.search(line):
            findings.append({"file": name, "line": number, "rule": "PII-USER-PATH", "severity": "medium",
                             "lineSha256": hashlib.sha256(line.encode("utf-8")).hexdigest()})
    return findings


def public_scope_errors(names, staged=False):
    errors = []
    private = load_policy("private-plugins", staged=staged)
    public = load_policy("public-plugins", staged=staged)
    forbidden = {".git", "node_modules", "dist", "runtime", "user-data", "plugin-data", "plugin-configs", "python-plugin-configs", "migration-backups"}
    for name in names:
        parts = name.split("/")
        private_name = parts[-1].lower()
        private_env = private_name == ".env" or private_name.startswith(".env.") and private_name != ".env.example"
        if any(part in forbidden for part in parts) or private_env or name == "settings.json" or private_name in {"account-token.bin", "cookies", "login data"} or private_name.endswith("-secrets.bin"):
            errors.append({"file": name, "rule": "PRIVATE-DATA-PATH"})
        if re.search(r"(?i)\.(?:pem|key|pfx|p12|keystore|jks|db|sqlite3?|log)$", name):
            errors.append({"file": name, "rule": "CREDENTIAL-OR-USER-FILE"})
        for engine, directory in (("tools", "software"), ("python", "python-software")):
            if len(parts) >= 3 and parts[:2] == ["app", directory] and parts[2] not in public[engine]:
                errors.append({"file": name, "rule": "UNLISTED-PLUGIN"})
            if any(item in parts for item in private[engine]):
                errors.append({"file": name, "rule": "PRIVATE-PLUGIN"})
    required = {f"app/python-software/{item}/settings.json" for item in public["python"]}
    for missing in sorted(required.difference(names)):
        errors.append({"file": missing, "rule": "MISSING-PUBLIC-MANIFEST"})
    return errors


def template_errors(contents):
    errors = []
    for name, data in contents.items():
        if not re.fullmatch(r"app/python-software/[^/]+/settings\.json", name):
            continue
        try:
            metadata = json.loads(data.decode("utf-8-sig"))
            filename = metadata.get("config_file", "config.json")
            if not isinstance(filename, str) or Path(filename).name != filename or not filename.endswith(".json"):
                raise ValueError("非法配置文件名")
            config = name.rsplit("/", 1)[0] + "/" + filename
            # 公开仓库和暂存只能携带空模板，业务默认值由插件代码提供。
            if json.loads(contents[config].decode("utf-8-sig")) != {}:
                errors.append({"file": config, "rule": "NONEMPTY-PYTHON-CONFIG"})
        except (ValueError, KeyError, UnicodeError):
            errors.append({"file": name, "rule": "INVALID-PYTHON-CONFIG-TEMPLATE"})
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--git", action="store_true", help="扫描受跟踪与未忽略的文件（默认）")
    parser.add_argument("--staged", action="store_true", help="读取索引字节，提交前核对实际内容")
    parser.add_argument("--target", type=Path, help="扫描公开构建暂存目录，不扫描依赖")
    args = parser.parse_args()
    if args.target and args.staged:
        parser.error("--target不能与--staged组合")
    allowlist = load_allowlist(staged=args.staged)
    if args.target:
        target = args.target.resolve()
        files = sorted(file for file in target.rglob("*") if file.is_file() and "node_modules" not in file.relative_to(target).parts)
        names = [file.relative_to(target).as_posix() for file in files]
        readers = [(name, lambda file=file: file.read_bytes()) for name, file in zip(names, files)]
    else:
        options = ["ls-files", "-z", "--cached"]
        if not args.staged:
            options += ["--others", "--exclude-standard"]
        names = sorted(set(name.decode("utf-8") for name in git(*options).split(b"\0") if name))
        readers = [(name, (lambda name=name: git("show", f":{name}")) if args.staged else (lambda name=name: (ROOT / name).read_bytes())) for name in names]
    errors = public_scope_errors(names, staged=args.staged)
    findings = []
    reviewed = 0
    templates = {}
    for name, read in readers:
        try:
            data = read()
            if name.startswith("app/python-software/") and name.endswith(".json"):
                templates[name] = data
            for finding in scan_text(name, data):
                key = (finding["file"], finding["rule"], finding["lineSha256"])
                if key in allowlist:
                    reviewed += 1
                else:
                    findings.append(finding)
        except (OSError, UnicodeError, subprocess.CalledProcessError) as error:
            errors.append({"file": name, "rule": "READ-FAILED", "type": type(error).__name__})
    errors.extend(template_errors(templates))
    print(json.dumps({"files": len(names), "reviewedFixtureFindings": reviewed, "findings": findings, "errors": errors}, ensure_ascii=False, indent=2))
    return 1 if findings or errors else 0


if __name__ == "__main__":
    sys.exit(main())
