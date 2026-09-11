#!/usr/bin/env python3
"""Stamp every shipped command, skill and tool with the kit VERSION, then write MANIFEST.sha256.

Run from content/enterprise-sdd-agents:  python3 tests/stamp-kit.py serpens-sdd-starter [...]
Idempotent: an existing serpens-version stamp is rewritten in place, never duplicated.
"""
import hashlib
import pathlib
import re
import sys


def stamped_files(root: pathlib.Path):
    out = list((root / "commands").glob("*.md"))
    out += sorted((root / "skills").glob("*/SKILL.md"))
    return sorted(out)


def stamp_markdown(text: str, version: str) -> str:
    if not text.startswith("---\n"):
        raise SystemExit("markdown file has no frontmatter")
    end = text.index("\n---\n", 3) + 1
    head, rest = text[:end], text[end:]
    line = f"serpens-version: {version}"
    if re.search(r"^serpens-version: .*$", head, re.M):
        head = re.sub(r"^serpens-version: .*$", line, head, count=1, flags=re.M)
    else:
        head = head.rstrip("\n") + "\n" + line + "\n"
    return head + rest


def stamp_script(text: str, version: str, comment: str) -> str:
    line = f"{comment} serpens-version: {version}"
    lines = text.split("\n")
    at = 1 if lines and lines[0].startswith("#!") else 0
    pat = re.compile(rf"^{re.escape(comment)} serpens-version: ")
    for i, existing in enumerate(lines[: at + 2]):
        if pat.match(existing):
            lines[i] = line
            return "\n".join(lines)
    lines.insert(at, line)
    return "\n".join(lines)


for kit_arg in sys.argv[1:]:
    kit = pathlib.Path(kit_arg)
    version = (kit / "VERSION").read_text().strip()
    manifest = []
    for path in stamped_files(kit):
        text = path.read_text()
        if path.suffix == ".md":
            new = stamp_markdown(text, version)
        else:
            new = stamp_script(text, version, "//" if path.suffix == ".mjs" else "#")
        if new != text:
            path.write_text(new)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        manifest.append(f"{digest}  {path.relative_to(kit)}")
    (kit / "MANIFEST.sha256").write_text("\n".join(manifest) + "\n")
    print(f"{kit}: stamped {len(manifest)} file(s) as {version}")
