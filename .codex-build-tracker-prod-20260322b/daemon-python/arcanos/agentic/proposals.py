from __future__ import annotations

import re
from dataclasses import dataclass

from ..config import Config


_DIFF_FENCE = re.compile(r"```diff[^\n]*\n(.*?)```", re.DOTALL)
_BASH_FENCE = re.compile(r"```bash[^\n]*\n(.*?)```", re.DOTALL)
_PATCH_TOKEN = re.compile(rf"{re.escape(Config.PATCH_TOKEN_START)}\s*\n(.*?)\n{re.escape(Config.PATCH_TOKEN_END)}", re.DOTALL)

_DIFF_LINE_OK = re.compile(
    r"^(diff --git |index |--- |\+\+\+ |@@|[ +-]|\\ No newline at end of file|old mode|new mode|deleted file mode|new file mode|similarity index|rename from|rename to)"
)

@dataclass
class PatchProposal:
    patch_text: str

@dataclass
class CommandProposal:
    command: str
    reason: str = ""


def extract_patch_blocks(text: str) -> list[PatchProposal]:
    patches: list[str] = []

    for m in _PATCH_TOKEN.finditer(text):
        patches.append(m.group(1).strip() + "\n")

    for m in _DIFF_FENCE.finditer(text):
        patches.append(m.group(1).strip() + "\n")

    # raw diff --git blocks
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].startswith("diff --git "):
            block = [lines[i]]
            i += 1
            while i < len(lines) and _DIFF_LINE_OK.match(lines[i]):
                block.append(lines[i])
                i += 1
            patches.append("\n".join(block).strip() + "\n")
            continue
        i += 1

    seen = set()
    out: list[PatchProposal] = []
    for p in patches:
        key = p.strip()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(PatchProposal(patch_text=p))
    return out


def extract_command_blocks(text: str) -> list[CommandProposal]:
    cmds: list[CommandProposal] = []

    for m in _BASH_FENCE.finditer(text):
        block = m.group(1).strip()
        if not block:
            continue
        first = block.splitlines()[0].strip()
        if first:
            cmds.append(CommandProposal(command=first, reason="bash block"))

    lines = text.splitlines()
    for idx, line in enumerate(lines):
        if line.strip().lower() == "command:" and idx + 1 < len(lines):
            cmd = lines[idx + 1].strip()
            if cmd:
                cmds.append(CommandProposal(command=cmd, reason="Command: suggestion"))

    seen = set()
    out: list[CommandProposal] = []
    for c in cmds:
        k = c.command.strip()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out
