"""Real PowerShell TerminalController acceptance, without CLI approval claims."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _child(config_path: Path) -> int:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    case_root = Path(config["case_root"]).resolve()
    source_root = Path(config["source_root"]).resolve()
    from arcanos.config import Config
    from arcanos.terminal import TerminalController
    import arcanos.terminal as terminal_module
    Path(terminal_module.__file__).resolve().relative_to(source_root)
    Path(Config.DATA_DIR).resolve().relative_to(case_root)
    assert Config.RUN_ELEVATED is False
    assert Config.COMMAND_WHITELIST == [config["whitelist"]]
    controller = TerminalController()
    executable = shutil.which(config["shell"])
    if not executable:
        raise RuntimeError("Required Windows shell is unavailable")
    observed = []
    popen_code = subprocess.Popen.__init__.__code__
    previous_profile = sys.getprofile()

    def observe_native_process(frame, event, _argument):
        if event == "return" and frame.f_code is popen_code:
            process = frame.f_locals.get("self")
            if getattr(process, "pid", None) is not None:
                observed.append(process)

    sentinel = Path(config["sentinel"])
    before = sentinel.exists()
    assert before is False
    result = {"classification": "REAL_POWERSHELL_POLICY_COMPONENT" if config["shell"] == "powershell" else "REAL_CMD_POLICY_COMPONENT",
              "pid": os.getpid(), "parent_pid": os.getppid(), "shell": config["shell"],
              "explicit_shell_executable": executable, "command_sha256": _digest(config["command"]),
              "command_length": len(config["command"]), "elevated_requested": False,
              "instrumentation": "read-only profile observation of real Popen objects; no process/return-value replacement",
              "exit_code": None, "exception_category": None}
    sys.setprofile(observe_native_process)
    try:
        try:
            stdout, stderr, exit_code = controller.execute(
                config["command"], shell=executable, timeout=20,
                check_safety=True, elevated=False,
            )
            result.update(exit_code=exit_code, stdout_sha256=_digest(stdout or ""),
                          stderr_sha256=_digest(stderr or ""), stderr_empty=not stderr,
                          output_intact=(stdout or "") == config.get("expected_output"))
        except ValueError:
            result["exception_category"] = "policy_rejected"
        except TimeoutError:
            result["exception_category"] = "timeout"
        except Exception:
            result["exception_category"] = "execution_error"
    finally:
        sys.setprofile(previous_profile)
    result["native_processes"] = [
        {"pid": process.pid, "exit_code": process.poll(),
         "executable": str(process.args[0]) if isinstance(process.args, (list, tuple)) else str(process.args),
         "args_sha256": _digest(json.dumps(process.args, ensure_ascii=False, default=str))}
        for process in observed
    ]
    result["native_popen_count"] = len(observed)
    result["all_native_processes_exited"] = all(process.poll() is not None for process in observed)
    result["sentinel_existed_before"] = before
    result["sentinel_exists_after"] = sentinel.exists()
    Path(config["receipt"]).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def run(case_root: Path, source_root: Path) -> dict:
    from .common import clean_env, read_jsonl, run_child, write_json
    case_root, source_root = case_root.resolve(), source_root.resolve()
    case_root.mkdir(parents=True, exist_ok=True)
    cases = []
    safe = [
        ("ordinary_argument", "Write-Output ordinary", "ordinary"),
        ("ordinary_multiple_arguments", "Write-Output first second", "first\nsecond"),
        ("double_quoted_parentheses", 'Write-Output "literal(parentheses)"', "literal(parentheses)"),
        ("single_quoted_parentheses", "Write-Output '(Get-Date)'", "(Get-Date)"),
        ("single_quoted_substitution_literal", "Write-Output '$(Get-Date)'", "$(Get-Date)"),
        ("single_quoted_operators_literal", "Write-Output 'left;right&literal'", "left;right&literal"),
        ("double_quoted_space", 'Write-Output "plain quoted value"', "plain quoted value"),
    ]
    unsafe = [
        ("unquoted_grouping", "Write-Output (Get-Date)"),
        ("nested_grouping", "Write-Output ((Get-Date))"),
        ("array_expression", "Write-Output @(Get-Date)"),
        ("grouped_file_creation", "Write-Output ({payload})"),
        ("semicolon_chain", "Write-Output ordinary; {payload}"),
        ("pipeline", "Write-Output ordinary | Set-Content -Path '{sentinel}'"),
        ("substitution", "Write-Output $({payload})"),
        ("quoted_substitution", 'Write-Output "$(Get-Date)"'),
        ("ambiguous_backslash_quote", 'Write-Output \\" ; {payload} ; \\"'),
        ("ambiguous_backtick_quote", 'Write-Output `" ; {payload} ; `"'),
        ("prefix_confusion", "Write-OutputSuffix ordinary"),
    ]
    definitions = [(name, command, output, True, "powershell", "Write-Output") for name, command, output in safe]
    definitions += [(name, command, None, False, "powershell", "Write-Output") for name, command in unsafe]
    definitions.append(("actual_cmd_ordinary_control", "echo cmd-acceptance", "cmd-acceptance", True, "cmd", "echo"))
    definitions.extend([
        ("hashtable_file_creation", "Write-Output @{p=New-Item -Path '{sentinel}' -ItemType File}",
         None, False, "powershell", "Write-Output"),
        ("single_quoted_hashtable_literal", "Write-Output '@{p=New-Item}'",
         "@{p=New-Item}", True, "powershell", "Write-Output"),
        ("double_quoted_hashtable_literal", 'Write-Output "@{p=New-Item}"',
         "@{p=New-Item}", True, "powershell", "Write-Output"),
    ])
    for index, (name, template, expected_output, allowed, shell, whitelist) in enumerate(definitions, 1):
        root = case_root / f"s{index:02d}"
        workspace = root / "workspace"
        workspace.mkdir(parents=True)
        sentinel = workspace / ("sentinel.txt" if name == "hashtable_file_creation" else "must-not-be-created.txt")
        quoted_path = sentinel.as_posix().replace("'", "''")
        payload = f"New-Item -ItemType File -Path '{quoted_path}' -Force"
        command = template.replace("{payload}", payload).replace("{sentinel}", quoted_path)
        receipt_file = root / "result.json"
        config = {"case_root": str(root), "source_root": str(source_root), "command": command,
                  "expected_output": expected_output, "shell": shell, "whitelist": whitelist,
                  "sentinel": str(sentinel), "receipt": str(receipt_file)}
        config_path = root / "request.json"
        config_path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        env = clean_env(root, source_root, extra={"COMMAND_WHITELIST": whitelist, "ARCANOS_SHELL": shell})
        completed = run_child([sys.executable, "-u", str(Path(__file__).resolve()), "--child", str(config_path)],
                              cwd=workspace, env=env, timeout=30)
        case = {"name": name, "expected": "real_execution" if allowed else "blocked_before_native_launch",
                "child_pid": completed["pid"], "child_exit_code": completed["exit_code"], "status": "FAIL"}
        if completed["exit_code"] == 0 and receipt_file.exists():
            result = json.loads(receipt_file.read_text(encoding="utf-8"))
            case["result"] = result
            events = read_jsonl(root / "logs/network.jsonl")
            native_events = [event for event in events if event.get("event") == "subprocess.Popen"]
            case["guard_popen_count"] = len(native_events)
            case["guard_event_sha256"] = _digest(json.dumps(events, sort_keys=True))
            case["sentinel_absent"] = not sentinel.exists()
            if allowed:
                passed = (result["exit_code"] == 0 and result["exception_category"] is None
                          and result["output_intact"] and result["stderr_empty"]
                          and result["native_popen_count"] == len(native_events) == 1)
            else:
                passed = (result["exception_category"] == "policy_rejected" and result["exit_code"] is None
                          and result["native_popen_count"] == len(native_events) == 0)
            case["status"] = "PASS" if passed and case["sentinel_absent"] and result["all_native_processes_exited"] else "FAIL"
        else:
            case["failure_category"] = "child_did_not_complete"
            case["child_output_sha256"] = _digest(completed["stdout"] + completed["stderr"])
        cases.append(case)
    receipt = {"suite": "powershell", "classification": "REAL_POWERSHELL_POLICY_COMPONENT",
               "scope": "real TerminalController.execute; no CLI human approval claim; no subprocess mock",
               "source_terminal_sha256": hashlib.sha256((source_root / "daemon-python/arcanos/terminal.py").read_bytes()).hexdigest(),
               "cases": cases, "case_count": len(cases),
               "passed": sum(case["status"] == "PASS" for case in cases),
               "failed": sum(case["status"] == "FAIL" for case in cases),
               "real_provider_calls": 0, "production_changes": 0, "elevated_requests": 0,
               "all_child_processes_exited": all(case["child_exit_code"] == 0 for case in cases),
               "all_native_processes_exited": all(case.get("result", {}).get("all_native_processes_exited", False) for case in cases)}
    write_json(case_root / "powershell-receipt.json", receipt)
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", type=Path, required=True)
    raise SystemExit(_child(parser.parse_args().child))
