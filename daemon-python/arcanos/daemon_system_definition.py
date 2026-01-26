"""
Daemon system definition and backend registry formatting helpers.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

DAEMON_SYSTEM_PROMPT_TEMPLATE = """# ARCANOS: Daemon System Definition

You are **ARCANOS** -- an operating intelligence running as a **daemon** on the user's machine. You are a **logic engine**, **decision shell**, and **command interface** for terminal, screen, voice, and backend-backed tasks.

You are not a generic chatbot. You execute, observe, and route.

---

## ENVIRONMENT

- Local: Terminal (PowerShell), screen capture, camera, microphone, TTS.
- Backend (when `BACKEND_URL` is set): see ## BACKEND. Assume a live backend when configured.

{{BACKEND_BLOCK}}

---

## DAEMON CAPABILITIES

| Capability | Description |
|------------|-------------|
| **run** | Execute terminal commands. **Sensitive** -- requires user confirmation when the backend confirmation gate is enabled. |
| **see** | Screen or camera capture + vision (local or via backend). |
| **voice** | One-shot microphone -> transcription -> chat. |
| **ptt** | Push-to-talk: hold to speak, optional screenshot. |
| **speak** | TTS of the last response. |
| **deep** / **backend** | Route this turn to the backend for stronger models or extra modules. |

---

## SENSITIVE ACTIONS & CONFIRMATION

- Sensitive (need user confirmation when the gate is on): `run`; in the future: `mouse_*`, `keyboard_*`, `focus_window`.
- The backend does not queue sensitive actions until the user confirms. The daemon shows "Do you confirm this action?" and the action summary; on yes it calls `/api/daemon/confirm-actions`.
- Non-sensitive (no confirmation): `see`, `notify`, `ping`, `get_status`, `get_stats`.
- Do not run destructive or high-impact commands without explicit user instruction or confirmation.

---

## UX BEHAVIOR

- Prefer Markdown, tables, or bullets when it helps.
- Clarify vague prompts before acting.
- When the user says "take control", "you drive", "handle it" -- treat as permission to use daemon tools and to chain multiple actions in one turn. Sensitive actions still go through the confirmation gate.

---

## ROUTING

- Local: Simple chat, run, see, voice when the backend is absent or routing/confidence keeps it local.
- Backend: Use `deep` / `backend` or high confidence so the request goes to `/api/ask`. The backend may emit daemon tools (`run_command`, `capture_screen`); `run_command` is sensitive and subject to the same confirmation gate.
"""

DEFAULT_BACKEND_BLOCK = """## BACKEND

When the daemon routes to the backend, it reaches the full ARCANOS stack.

- Endpoints: `POST /api/ask` (core logic, module routing, daemon tools), `POST /api/vision`, `POST /api/transcribe`, `GET /api/daemon/commands`, `POST /api/daemon/confirm-actions`.
- Module routing (via `/api/ask`): `ARCANOS:WRITE`, `ARCANOS:BUILD`, `ARCANOS:RESEARCH`, `ARCANOS:AUDIT`, `ARCANOS:SIM`, `ARCANOS:BOOKING`, `ARCANOS:GUIDE`, `ARCANOS:TRACKER`.
- Core systems: `CLEAR 2.0` (audit engine), `HRC` (Hallucination-Resistant Core; modes: `HRC:STRICT`, `HRC:LENIENT`, `HRC:SILENTFAIL`, `HRC->CLEAR`).
- Daemon tools (from backend): `run_command`, `capture_screen`. `run_command` is sensitive and requires user confirmation before the backend queues it.
"""


def build_daemon_system_prompt(backend_block: str) -> str:
    """
    Purpose: Assemble the daemon system prompt with the provided backend block.
    Inputs/Outputs: backend_block string; returns the full prompt string.
    Edge cases: If the placeholder is missing, appends the backend block at the end.
    """
    if "{{BACKEND_BLOCK}}" in DAEMON_SYSTEM_PROMPT_TEMPLATE:
        # //audit assumption: placeholder present; risk: missing backend block; invariant: replace placeholder; strategy: string replace.
        return DAEMON_SYSTEM_PROMPT_TEMPLATE.replace("{{BACKEND_BLOCK}}", backend_block.strip())

    # //audit assumption: placeholder missing; risk: backend block omitted; invariant: append block; strategy: fallback append.
    return f"{DAEMON_SYSTEM_PROMPT_TEMPLATE.rstrip()}\n\n{backend_block.strip()}"


def format_registry_for_prompt(registry: Mapping[str, Any]) -> str:
    """
    Purpose: Render backend registry JSON into a Markdown BACKEND block for the daemon prompt.
    Inputs/Outputs: registry mapping; returns a Markdown string.
    Edge cases: Missing registry fields produce empty sections.
    """
    endpoints = registry.get("endpoints")
    modules = registry.get("modules")
    daemon_tools = registry.get("daemonTools")
    core_systems = registry.get("core")

    def _to_list(value: Any) -> list[Any]:
        """Safely convert a value to a list, handling None and non-sequence types."""
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            return list(value)
        return []

    endpoints_list = _to_list(registry.get("endpoints"))
    modules_list = _to_list(registry.get("modules"))
    tools_list = _to_list(registry.get("daemonTools"))
    core_list = _to_list(registry.get("core"))

    lines: list[str] = [
        "## BACKEND",
        "",
        "When the daemon routes to the backend, it reaches the full ARCANOS stack."
    ]

    if endpoints_list:
        # //audit assumption: endpoints list present; risk: missing fields; invariant: render list; strategy: build table.
        lines.extend(["", "Endpoints:", "| Method | Path | Description |", "| --- | --- | --- |"])
        for entry in endpoints_list:
            if not isinstance(entry, Mapping):
                # //audit assumption: invalid endpoint entry; risk: bad prompt; invariant: skip entry; strategy: continue.
                continue
            method = str(entry.get("method", "")).upper()
            path = str(entry.get("path", ""))
            description = str(entry.get("description", ""))
            lines.append(f"| {method} | {path} | {description} |")

    if modules_list:
        # //audit assumption: modules list present; risk: missing fields; invariant: render list; strategy: build table.
        lines.extend(["", "Modules:", "| ID | Description | Route | Actions |", "| --- | --- | --- | --- |"])
        for entry in modules_list:
            if not isinstance(entry, Mapping):
                # //audit assumption: invalid module entry; risk: bad prompt; invariant: skip entry; strategy: continue.
                continue
            module_id = str(entry.get("id", ""))
            description = str(entry.get("description", "") or "")
            route = str(entry.get("route", "") or "")
            actions_value = entry.get("actions")
            actions = ""
            if isinstance(actions_value, Sequence) and not isinstance(actions_value, (str, bytes)):
                # //audit assumption: actions list is iterable; risk: wrong type; invariant: string list; strategy: join strings.
                actions = ", ".join(str(item) for item in actions_value)
            lines.append(f"| {module_id} | {description} | {route} | {actions} |")

    if tools_list:
        # //audit assumption: daemon tools list present; risk: missing fields; invariant: render list; strategy: build table.
        lines.extend(["", "Daemon tools:", "| Name | Description | Sensitive |", "| --- | --- | --- |"])
        for entry in tools_list:
            if not isinstance(entry, Mapping):
                # //audit assumption: invalid tool entry; risk: bad prompt; invariant: skip entry; strategy: continue.
                continue
            name = str(entry.get("name", ""))
            description = str(entry.get("description", ""))
            sensitive_flag = bool(entry.get("sensitive", False))
            # //audit assumption: sensitive flag boolean; risk: wrong type; invariant: yes/no string; strategy: coerce boolean.
            if sensitive_flag:
                # //audit assumption: sensitive flag true; risk: mislabel; invariant: "yes"; strategy: set yes.
                sensitive = "yes"
            else:
                # //audit assumption: sensitive flag false; risk: mislabel; invariant: "no"; strategy: set no.
                sensitive = "no"
            lines.append(f"| {name} | {description} | {sensitive} |")

    if core_list:
        # //audit assumption: core systems list present; risk: missing fields; invariant: render list; strategy: build bullets.
        lines.append("")
        lines.append("Core systems:")
        for entry in core_list:
            if not isinstance(entry, Mapping):
                # //audit assumption: invalid core entry; risk: bad prompt; invariant: skip entry; strategy: continue.
                continue
            core_id = str(entry.get("id", ""))
            description = str(entry.get("description", ""))
            modes_value = entry.get("modes")
            modes = ""
            if isinstance(modes_value, Sequence) and not isinstance(modes_value, (str, bytes)):
                # //audit assumption: modes list is iterable; risk: wrong type; invariant: string list; strategy: join strings.
                modes = ", ".join(str(item) for item in modes_value)

            if modes:
                # //audit assumption: modes present; risk: cluttered output; invariant: suffix included; strategy: append suffix.
                modes_suffix = f" (modes: {modes})"
            else:
                # //audit assumption: no modes present; risk: missing detail; invariant: no suffix; strategy: empty suffix.
                modes_suffix = ""
            lines.append(f"- {core_id}: {description}{modes_suffix}")

    return "\n".join(lines)

