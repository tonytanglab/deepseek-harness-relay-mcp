#!/usr/bin/env python3
"""Build a strict UTF-8 manifest for a bounded DeepSeek Harness task."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys


TEXT_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".html", ".java",
    ".js", ".json", ".jsx", ".kt", ".md", ".mjs", ".py", ".rs", ".scss",
    ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
DEFAULT_PATHS = ("AGENTS.md", "README.md", "CHANGELOG.md", "docs")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", help="Repository root containing the delegated task")
    parser.add_argument(
        "--path",
        action="append",
        dest="paths",
        help="Relative file or directory to include; repeatable",
    )
    parser.add_argument("--baseline-label", default="current-worktree")
    parser.add_argument("--max-bytes", type=int, default=2_000_000)
    return parser.parse_args()


def ensure_within(root: Path, candidate: Path) -> Path:
    resolved = candidate.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path escapes workspace: {candidate}") from exc
    return resolved


def iter_files(root: Path, requested: list[str]) -> list[Path]:
    found: set[Path] = set()
    for item in requested:
        target = ensure_within(root, root / item)
        if target.is_file():
            if target.suffix.lower() in TEXT_SUFFIXES:
                found.add(target)
            continue
        for candidate in target.rglob("*"):
            if candidate.is_file() and candidate.suffix.lower() in TEXT_SUFFIXES:
                found.add(ensure_within(root, candidate))
    return sorted(found, key=lambda value: value.relative_to(root).as_posix())


def describe_file(root: Path, path: Path, max_bytes: int) -> dict[str, object]:
    raw = path.read_bytes()
    relative = path.relative_to(root).as_posix()
    if len(raw) > max_bytes:
        raise ValueError(f"file exceeds --max-bytes: {relative}")
    if raw.startswith(b"\xef\xbb\xbf"):
        raise ValueError(f"UTF-8 BOM is forbidden: {relative}")
    content = raw.decode("utf-8", errors="strict")
    if "\r" in content:
        raise ValueError(f"CR line ending is forbidden: {relative}")
    return {
        "path": relative,
        "bytes": len(raw),
        "lines": len(content.splitlines()),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def main() -> int:
    args = parse_args()
    root = Path(args.workspace).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("workspace must be a directory")
    requested = args.paths or list(DEFAULT_PATHS)
    files = [describe_file(root, path, args.max_bytes) for path in iter_files(root, requested)]
    payload = {
        "schemaVersion": 1,
        "baselineLabel": args.baseline_label,
        "workspaceRoot": str(root),
        "includedPaths": requested,
        "fileCount": len(files),
        "files": files,
    }
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
