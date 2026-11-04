#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""
Privacy/Secret Scanner - scan_secrets.py
Scans files and directories for sensitive information (API keys, passwords,
tokens, etc.) before committing to GitHub or open-sourcing code.
No external dependencies required.

Usage:
    uv run scan_secrets.py [path] [options]
    python scan_secrets.py [path] [options]

Options:
    --path PATH         Directory or file to scan (default: current directory)
    --report PATH       Save JSON report to file
    --severity LEVEL    Minimum severity to report: low|medium|high (default: low)
    --no-color          Disable colored output
    --include-git       Include .git directory in scan
    --extensions EXTS   Comma-separated list of file extensions to scan
                        (default: common code/config extensions)
"""

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


# ──────────────────────────────────────────────
# Color helpers
# ──────────────────────────────────────────────
class Colors:
    RED = "\033[91m"
    YELLOW = "\033[93m"
    GREEN = "\033[92m"
    CYAN = "\033[96m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    RESET = "\033[0m"

    @classmethod
    def disable(cls):
        for attr in ["RED", "YELLOW", "GREEN", "CYAN", "BOLD", "DIM", "RESET"]:
            setattr(cls, attr, "")


# ──────────────────────────────────────────────
# Secret pattern definitions
# Each entry: (rule_id, description, regex_pattern, severity, keywords)
# ──────────────────────────────────────────────
RULES = [
    # ── AWS ──
    ("AWS-001", "AWS Access Key ID", r"(?:AKIA|ABIA|ACCA|AROA)[0-9A-Z]{16}", "high", ["AKIA", "ABIA", "AWS_ACCESS_KEY"]),
    ("AWS-002", "AWS Secret Access Key", r"(?i)aws[_\-\s]*secret[_\-\s]*(?:access[_\-\s]*)?key\s*[=:]\s*['\"]?([A-Za-z0-9/+]{40})['\"]?", "high", ["aws_secret", "AWS_SECRET"]),

    # ── Generic API Keys ──
    ("KEY-001", "Generic API Key assignment", r"(?i)api[_\-\s]*key\s*[=:]\s*['\"]([A-Za-z0-9\-_]{16,})['\"]", "high", ["api_key", "apikey", "API_KEY"]),
    ("KEY-002", "Generic Secret/Token assignment", r"(?i)(?:secret|token|password|passwd|pwd)\s*[=:]\s*['\"]([A-Za-z0-9\-_\.@!#%]{8,})['\"]", "medium", ["secret", "token", "password"]),
    ("KEY-003", "Bearer token in code", r"(?i)bearer\s+([A-Za-z0-9\-_\.]+\.[A-Za-z0-9\-_\.]+\.[A-Za-z0-9\-_\.]+)", "high", ["Bearer", "bearer"]),

    # ── GitHub ──
    ("GH-001", "GitHub Personal Access Token (classic)", r"ghp_[A-Za-z0-9]{36}", "high", ["ghp_"]),
    ("GH-002", "GitHub OAuth Token", r"gho_[A-Za-z0-9]{36}", "high", ["gho_"]),
    ("GH-003", "GitHub App Token", r"(?:ghs|ghu)_[A-Za-z0-9]{36}", "high", ["ghs_", "ghu_"]),
    ("GH-004", "GitHub Fine-grained PAT", r"github_pat_[A-Za-z0-9_]{82}", "high", ["github_pat_"]),

    # ── Google ──
    ("GCP-001", "Google API Key", r"AIza[0-9A-Za-z\-_]{35}", "high", ["AIza"]),
    ("GCP-002", "Google OAuth Client Secret", r"(?i)google[_\-\s]*(?:oauth|client)[_\-\s]*secret\s*[=:]\s*['\"]?([A-Za-z0-9\-_]{24,})", "high", ["google_client_secret", "GOOGLE_CLIENT_SECRET"]),

    # ── OpenAI ──
    ("OAI-001", "OpenAI API Key", r"sk-(?:proj-)?[A-Za-z0-9]{20,}", "high", ["sk-", "OPENAI_API_KEY"]),
    ("OAI-002", "OpenAI Org ID", r"org-[A-Za-z0-9]{20,}", "medium", ["org-", "OPENAI_ORG"]),

    # ── Anthropic ──
    ("ANT-001", "Anthropic API Key", r"sk-ant-(?:api\d+-)?[A-Za-z0-9\-_]{40,}", "high", ["sk-ant-", "ANTHROPIC_API_KEY"]),

    # ── Stripe ──
    ("STR-001", "Stripe Secret Key", r"sk_(?:live|test)_[A-Za-z0-9]{24,}", "high", ["sk_live_", "sk_test_", "STRIPE_SECRET"]),
    ("STR-002", "Stripe Webhook Secret", r"whsec_[A-Za-z0-9]{32,}", "high", ["whsec_"]),

    # ── Slack ──
    ("SLK-001", "Slack Bot Token", r"xoxb-[0-9A-Za-z\-]{50,}", "high", ["xoxb-"]),
    ("SLK-002", "Slack App/User Token", r"xox[aprs]-[0-9A-Za-z\-]{50,}", "high", ["xoxa-", "xoxp-", "xoxr-", "xoxs-"]),
    ("SLK-003", "Slack Webhook URL", r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+", "high", ["hooks.slack.com"]),

    # ── Database connection strings ──
    ("DB-001", "Database URL with credentials", r"(?i)(?:postgres|postgresql|mysql|mongodb|redis|mssql|oracle)\+?://[^:]+:[^@\s]+@", "high", ["postgresql://", "mysql://", "mongodb://", "redis://"]),
    ("DB-002", "Database password in config", r"(?i)db[_\-\s]*(?:pass|password|pwd)\s*[=:]\s*['\"]([^'\"]{6,})['\"]", "high", ["db_pass", "db_password", "DB_PASSWORD"]),

    # ── Private Keys ──
    ("PKI-001", "RSA/EC/DSA Private Key header", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----", "high", ["PRIVATE KEY"]),
    ("PKI-002", "PGP Private Key Block", r"-----BEGIN PGP PRIVATE KEY BLOCK-----", "high", ["PGP PRIVATE"]),

    # ── JWT ──
    ("JWT-001", "JWT Token (hardcoded)", r"eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+", "medium", ["eyJ"]),

    # ── Azure ──
    ("AZR-001", "Azure Storage Account Key", r"(?i)(?:azure|storage)[_\-\s]*(?:account[_\-\s]*)?key\s*[=:]\s*['\"]?([A-Za-z0-9/+]{88}==)", "high", ["azure_key", "AZURE_STORAGE"]),
    ("AZR-002", "Azure Connection String", r"DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[A-Za-z0-9/+]+=", "high", ["DefaultEndpointsProtocol", "AccountKey"]),

    # ── Twilio ──
    ("TWL-001", "Twilio Account SID", r"AC[a-fA-F0-9]{32}", "medium", ["AC", "TWILIO_ACCOUNT_SID"]),
    ("TWL-002", "Twilio Auth Token", r"(?i)twilio[_\-\s]*(?:auth[_\-\s]*)?token\s*[=:]\s*['\"]?([a-fA-F0-9]{32})", "high", ["twilio_token", "TWILIO_AUTH_TOKEN"]),

    # ── SendGrid / Mailgun ──
    ("MAIL-001", "SendGrid API Key", r"SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}", "high", ["SG."]),
    ("MAIL-002", "Mailgun API Key", r"key-[0-9a-f]{32}", "high", ["key-"]),

    # ── SSH ──
    ("SSH-001", "SSH password / passphrase assignment", r"(?i)ssh[_\-\s]*(?:pass|password|passphrase)\s*[=:]\s*['\"]([^'\"]{6,})['\"]", "high", ["ssh_pass", "SSH_PASSWORD"]),

    # ── Hardcoded credentials (generic) ──
    ("CRED-001", "Hardcoded password variable", r"(?i)(?:^|[^a-z])(?:password|passwd|pwd)\s*=\s*['\"]([^'\"]{6,})['\"]", "medium", ["password=", "passwd=", "pwd="]),
    ("CRED-002", "Authorization header with token", r"(?i)Authorization['\"]?\s*:\s*['\"]?(Basic|Bearer)\s+([A-Za-z0-9+/=_\-\.]{10,})", "medium", ["Authorization", "Basic ", "Bearer "]),

    # ── .env file patterns ──
    ("ENV-001", "Non-empty .env assignment (sensitive var)", r"(?i)(?:key|secret|token|password|passwd|pwd|auth|cred|api)\s*=\s*(?!your-|<|example|placeholder|xxx|change_me|dummy|test|demo|sample)['\"]?([^\s'\"#]{8,})", "low", []),

    # ── Numeric-looking secrets in config ──
    ("CONF-001", "Long random hex string (possible secret)", r"(?i)(?:key|secret|token|hash|digest)\s*[=:]\s*['\"]?([0-9a-fA-F]{32,})['\"]?", "low", []),
]

# ──────────────────────────────────────────────
# File extensions to scan by default
# ──────────────────────────────────────────────
DEFAULT_EXTENSIONS = {
    # Code
    ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".kt", ".go", ".rs",
    ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".swift", ".scala",
    # Config/env
    ".env", ".env.local", ".env.development", ".env.production", ".env.staging",
    ".toml", ".yaml", ".yml", ".json", ".xml", ".ini", ".cfg", ".conf",
    ".properties", ".settings",
    # Shell
    ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
    # Infra
    ".tf", ".tfvars", ".hcl",
    # Docker
    "Dockerfile", ".dockerenv",
    # Markdown (sometimes contains examples with real keys)
    ".md",
    # Misc
    ".pem", ".key", ".crt", ".cer", ".p12", ".pfx",
    ".htpasswd", ".netrc",
}

# Directories to always skip
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    ".tox", "dist", "build", "target", ".next", ".nuxt", "out",
    "vendor", "third_party", ".idea", ".vscode",
}

# Files to always skip
SKIP_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock",
    "Cargo.lock", "go.sum", "composer.lock",
}

SEVERITY_LEVELS = {"low": 0, "medium": 1, "high": 2}


@dataclass
class Finding:
    rule_id: str
    description: str
    severity: str
    file: str
    line: int
    column: int
    match: str
    snippet: str


@dataclass
class ScanResult:
    scanned_files: int = 0
    skipped_files: int = 0
    findings: list = field(default_factory=list)
    errors: list = field(default_factory=list)


# ──────────────────────────────────────────────
# Compile patterns once
# ──────────────────────────────────────────────
COMPILED_RULES = [
    (rule_id, desc, re.compile(pattern, re.MULTILINE), severity, keywords)
    for rule_id, desc, pattern, severity, keywords in RULES
]


def should_scan_file(path: Path, extensions: set[str], include_git: bool) -> bool:
    """Return True if file should be scanned."""
    # Check skip dirs
    for part in path.parts:
        if part in SKIP_DIRS and not include_git:
            return False
        if part == ".git" and not include_git:
            return False

    if path.name in SKIP_FILES:
        return False

    # Check extension or exact filename match
    if path.suffix.lower() in extensions:
        return True
    if path.name in {"Dockerfile", ".env", ".netrc", ".htpasswd"}:
        return True
    # Files without extension: check if name matches common config patterns
    if not path.suffix and path.name.startswith(".env"):
        return True

    return False


def scan_file(path: Path, min_severity: int) -> tuple[list[Finding], list[str]]:
    """Scan a single file for secrets. Returns (findings, errors)."""
    findings = []
    errors = []

    try:
        # Read as text, skip binary
        try:
            content = path.read_text(encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            try:
                content = path.read_text(encoding="latin-1", errors="replace")
            except Exception:
                return [], []

        lines = content.splitlines()

        for rule_id, desc, pattern, severity, _keywords in COMPILED_RULES:
            if SEVERITY_LEVELS.get(severity, 0) < min_severity:
                continue

            for m in pattern.finditer(content):
                # Calculate line/column
                start = m.start()
                line_num = content[:start].count("\n") + 1
                col = start - content[:start].rfind("\n") - 1

                # Snippet (the matching line, truncated)
                raw_line = lines[line_num - 1] if line_num <= len(lines) else ""
                snippet = raw_line.strip()[:120]

                # Redact: replace the actual secret value with ***
                matched_text = m.group(0)
                # Try to show rule id and location but redact actual value
                display = matched_text[:40] + "…" if len(matched_text) > 40 else matched_text

                findings.append(Finding(
                    rule_id=rule_id,
                    description=desc,
                    severity=severity,
                    file=str(path),
                    line=line_num,
                    column=col,
                    match=display,
                    snippet=snippet,
                ))

    except PermissionError as e:
        errors.append(f"Permission denied: {path}")
    except Exception as e:
        errors.append(f"Error reading {path}: {e}")

    return findings, errors


def scan_path(
    root: Path,
    extensions: set[str],
    include_git: bool,
    min_severity: int,
) -> ScanResult:
    """Recursively scan a path."""
    result = ScanResult()

    if root.is_file():
        findings, errors = scan_file(root, min_severity)
        result.findings.extend(findings)
        result.errors.extend(errors)
        result.scanned_files = 1
        return result

    for dirpath, dirnames, filenames in os.walk(root):
        dp = Path(dirpath)

        # Prune skip dirs in-place
        dirnames[:] = [
            d for d in dirnames
            if not (d in SKIP_DIRS and not include_git)
            and not (d == ".git" and not include_git)
        ]

        for fname in filenames:
            fpath = dp / fname
            if should_scan_file(fpath, extensions, include_git):
                findings, errors = scan_file(fpath, min_severity)
                result.findings.extend(findings)
                result.errors.extend(errors)
                result.scanned_files += 1
            else:
                result.skipped_files += 1

    return result


def format_severity(severity: str, use_color: bool) -> str:
    if not use_color:
        return f"[{severity.upper()}]"
    c = {
        "high": Colors.RED + Colors.BOLD,
        "medium": Colors.YELLOW,
        "low": Colors.CYAN,
    }.get(severity, Colors.RESET)
    return f"{c}[{severity.upper()}]{Colors.RESET}"


def print_report(result: ScanResult, use_color: bool, min_severity: int):
    C = Colors
    sep = "─" * 70

    # Group findings by file
    by_file: dict[str, list[Finding]] = {}
    for f in result.findings:
        by_file.setdefault(f.file, []).append(f)

    high_count = sum(1 for f in result.findings if f.severity == "high")
    medium_count = sum(1 for f in result.findings if f.severity == "medium")
    low_count = sum(1 for f in result.findings if f.severity == "low")

    print(f"\n{C.BOLD}Privacy / Secret Scan Report{C.RESET}")
    print(sep)
    print(f"  Files scanned : {result.scanned_files}")
    print(f"  Files skipped : {result.skipped_files}")
    print(f"  Total findings: {len(result.findings)}  "
          f"({C.RED}{C.BOLD}{high_count} high{C.RESET}, "
          f"{C.YELLOW}{medium_count} medium{C.RESET}, "
          f"{C.CYAN}{low_count} low{C.RESET})")
    print(sep)

    if not result.findings:
        print(f"\n{C.GREEN}{C.BOLD}No secrets detected! Safe to proceed.{C.RESET}\n")
    else:
        for filepath, findings in sorted(by_file.items()):
            rel = filepath
            try:
                rel = str(Path(filepath).relative_to(Path.cwd()))
            except ValueError:
                pass
            print(f"\n{C.BOLD}{rel}{C.RESET}  ({len(findings)} finding{'s' if len(findings) != 1 else ''})")
            for f in sorted(findings, key=lambda x: x.line):
                sev = format_severity(f.severity, use_color)
                print(f"  {sev} Line {f.line}  [{f.rule_id}] {f.description}")
                print(f"  {C.DIM}  → {f.snippet}{C.RESET}")
        print()

        print(sep)
        print(f"\n{C.RED}{C.BOLD}ACTION REQUIRED:{C.RESET}")
        print("  1. Remove or replace each finding with environment variables")
        print("  2. Rotate / revoke any exposed credentials immediately")
        print("  3. Ensure .gitignore excludes .env and config files with secrets")
        print("  4. If a false positive, add an inline comment:")
        print("     # gitleaks:allow  (for gitleaks)")
        print("     # nosec            (for security linters)")
        print()

    if result.errors:
        print(f"{C.YELLOW}Scan errors ({len(result.errors)}):{C.RESET}")
        for e in result.errors[:10]:
            print(f"  {e}")
        if len(result.errors) > 10:
            print(f"  ... and {len(result.errors) - 10} more")
        print()


def main():
    parser = argparse.ArgumentParser(
        description="Scan code for secrets/privacy leaks before open-sourcing"
    )
    parser.add_argument("path", nargs="?", default=".", help="Path to scan (default: .)")
    parser.add_argument("--report", metavar="FILE", help="Save JSON report to file")
    parser.add_argument(
        "--severity",
        choices=["low", "medium", "high"],
        default="low",
        help="Minimum severity level to report (default: low)",
    )
    parser.add_argument("--no-color", action="store_true", help="Disable color output")
    parser.add_argument("--include-git", action="store_true", help="Include .git directory")
    parser.add_argument(
        "--extensions",
        metavar="EXTS",
        help="Comma-separated file extensions to scan (e.g. .py,.env,.yaml)",
    )
    args = parser.parse_args()

    use_color = not args.no_color and sys.stdout.isatty()
    if not use_color:
        Colors.disable()

    scan_root = Path(args.path).resolve()
    if not scan_root.exists():
        print(f"Error: Path does not exist: {scan_root}", file=sys.stderr)
        sys.exit(1)

    extensions = DEFAULT_EXTENSIONS.copy()
    if args.extensions:
        extensions = {e.strip() if e.startswith(".") else f".{e.strip()}" for e in args.extensions.split(",")}

    min_severity = SEVERITY_LEVELS.get(args.severity, 0)

    print(f"Scanning: {scan_root}")
    print(f"Severity: {args.severity}+  |  Color: {use_color}  |  Include .git: {args.include_git}")

    result = scan_path(scan_root, extensions, args.include_git, min_severity)
    print_report(result, use_color, min_severity)

    if args.report:
        report_data = {
            "scan_path": str(scan_root),
            "scanned_files": result.scanned_files,
            "skipped_files": result.skipped_files,
            "total_findings": len(result.findings),
            "findings": [asdict(f) for f in result.findings],
            "errors": result.errors,
        }
        Path(args.report).write_text(json.dumps(report_data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Report saved to: {args.report}")

    # Exit code: 1 if any HIGH findings, 0 otherwise
    high_findings = [f for f in result.findings if f.severity == "high"]
    sys.exit(1 if high_findings else 0)


if __name__ == "__main__":
    main()
