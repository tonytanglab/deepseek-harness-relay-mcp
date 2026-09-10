#!/usr/bin/env python3
"""Build a path-reference-only contract for a bounded DeepSeek Harness task."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


PERMISSION_MODES = ("read-only", "workspace-write", "danger-full-access")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("workspace", help="Authorized Harness workspace root")
    parser.add_argument(
        "--path",
        action="append",
        dest="paths",
        required=True,
        help="Review target relative to the workspace; repeatable",
    )
    parser.add_argument(
        "--context-path",
        action="append",
        required=True,
        help="Relative workspace path Harness may search and read for supporting evidence; repeatable; use . for the workspace root",
    )
    parser.add_argument(
        "--scope",
        required=True,
        help="Single-line review or implementation scope; never paste source text here",
    )
    parser.add_argument(
        "--exclude-path",
        action="append",
        default=[],
        help="Relative path excluded from the delegated scope; repeatable",
    )
    parser.add_argument(
        "--write-path",
        action="append",
        default=[],
        help="Relative path Harness may modify; repeatable and valid only for a write-capable mode",
    )
    parser.add_argument("--permission-mode", choices=PERMISSION_MODES, default="read-only")
    return parser.parse_args()


def normalize_location(root: Path, value: str, *, must_exist: bool) -> str:
    if not value or "\0" in value:
        raise ValueError("locations must be non-empty and contain no NUL")
    resolved = (root / value).resolve(strict=must_exist)
    try:
        relative = resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"path escapes workspace: {value}") from exc
    return relative.as_posix() or "."


def normalize_locations(root: Path, values: list[str], *, must_exist: bool) -> list[str]:
    return list(dict.fromkeys(normalize_location(root, value, must_exist=must_exist) for value in values))


def validate_scope(value: str) -> str:
    scope = value.strip()
    if not scope:
        raise ValueError("--scope must not be empty")
    if len(scope) > 2_000:
        raise ValueError("--scope exceeds 2000 characters")
    if "\n" in scope or "\r" in scope or "```" in scope:
        raise ValueError("--scope must be concise single-line instructions, not embedded source text")
    return scope


def contains_path(parent: str, child: str) -> bool:
    if os.name == "nt":
        parent = parent.casefold()
        child = child.casefold()
    return parent == "." or child == parent or child.startswith(f"{parent}/")


def main() -> int:
    args = parse_args()
    root = Path(args.workspace).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("workspace must be a directory")

    if args.permission_mode == "read-only" and args.write_path:
        raise ValueError("--write-path is forbidden in read-only mode")
    if args.permission_mode != "read-only" and not args.write_path:
        raise ValueError("write-capable modes require at least one --write-path")

    review_targets = normalize_locations(root, args.paths, must_exist=True)
    context_read_scope = normalize_locations(root, args.context_path, must_exist=True)
    excluded_paths = normalize_locations(root, args.exclude_path, must_exist=False)
    write_scope = normalize_locations(root, args.write_path, must_exist=False)
    for target in review_targets:
        if not any(contains_path(context, target) for context in context_read_scope):
            raise ValueError(f"review target is outside context read scope: {target}")
        if any(contains_path(excluded, target) for excluded in excluded_paths):
            raise ValueError(f"review target is excluded: {target}")
    for target in write_scope:
        if not any(contains_path(context, target) for context in context_read_scope):
            raise ValueError(f"write path is outside context read scope: {target}")

    payload = {
        "schemaVersion": 3,
        "sourceTransferPolicy": "path-reference-only",
        "workspaceRoot": str(root),
        "permissionMode": args.permission_mode,
        "scope": validate_scope(args.scope),
        "reviewTargets": review_targets,
        "contextReadScope": context_read_scope,
        "excludedPaths": excluded_paths,
        "writeScope": write_scope,
        "scopeEnforcement": "instruction-only",
    }
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
