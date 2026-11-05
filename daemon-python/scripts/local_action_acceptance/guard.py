"""Child-process network containment and metadata-only operation observations."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import time


def _is_asyncio_wakeup(event: str, args: tuple, host: str, port: int) -> bool:
    """Recognize only Windows asyncio's actual stdlib socketpair self-wakeup."""
    if os.name != "nt" or host != "127.0.0.1":
        return False
    socket_module = sys.modules.get("socket")
    proactor_module = sys.modules.get("asyncio.proactor_events")
    socketpair = getattr(socket_module, "socketpair", None)
    proactor = getattr(proactor_module, "BaseProactorEventLoop", None)
    make_pipe = getattr(proactor, "_make_self_pipe", None)
    frame = sys._getframe(2)
    if (
        frame.f_code is not getattr(socketpair, "__code__", None)
        or frame.f_back is None
        or frame.f_back.f_code is not getattr(make_pipe, "__code__", None)
    ):
        return False
    listener = frame.f_locals.get("lsock")
    if event == "socket.bind":
        return port == 0 and listener is args[0]
    client = frame.f_locals.get("csock")
    return (
        event == "socket.connect" and client is args[0] and listener is not None
        and listener.getsockname()[:2] == (host, port)
    )


def install() -> None:
    log = Path(os.environ["ACCEPTANCE_NETWORK_LOG"])
    ports = {int(item) for item in os.environ.get("ACCEPTANCE_ALLOWED_PORTS", "").split(",") if item}

    def record(data: dict) -> None:
        data.update(pid=os.getpid(), time_ns=time.time_ns())
        with log.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(data, ensure_ascii=False) + "\n")

    def hook(event: str, args: tuple) -> None:
        if event == "builtins.input":
            # Readiness metadata only: never capture the prompt or input value.
            record({"event": event})
        elif event in {"socket.connect", "socket.bind"}:
            address = args[1]
            host, port = (str(address[0]), int(address[1])) if isinstance(address, tuple) else ("non-IP", -1)
            wakeup = _is_asyncio_wakeup(event, args, host, port)
            allowed = (host == "127.0.0.1" and port in ports) or wakeup
            record({"event": event, "host": host, "port": port, "allowed": allowed,
                    **({"purpose": "asyncio_wakeup"} if wakeup else {})})
            if not allowed:
                raise PermissionError("Acceptance fixture blocked a non-fixture socket")
        elif event == "socket.getaddrinfo":
            host = str(args[0])
            allowed = host == "127.0.0.1"
            record({"event": event, "host": host, "allowed": allowed})
            if not allowed:
                raise PermissionError("Acceptance fixture blocked non-loopback name resolution")
        elif event == "subprocess.Popen":
            executable, argv, cwd, _env = args
            canonical = json.dumps(argv, ensure_ascii=False, default=str)
            observed_executable = executable or (argv[0] if isinstance(argv, (list, tuple)) and argv else "<shell-command>")
            record({"event": event, "executable": Path(str(observed_executable)).name,
                    "argv_sha256": hashlib.sha256(canonical.encode()).hexdigest(),
                    "cwd": str(cwd) if cwd else None})

    sys.addaudithook(hook)
    record({"event": "guard_installed", "allowed_ports": sorted(ports), "stdin_isatty": sys.stdin.isatty()})
    fault = os.environ.get("ACCEPTANCE_FAULT_BOOTSTRAP")
    if fault:
        record({"event": "injected_fault_bootstrap", "fixture_sha256": hashlib.sha256(Path(fault).read_bytes()).hexdigest()})
        runpy.run_path(fault, run_name="acceptance_fault_bootstrap")
