"""A real Windows pseudo-console for bounded local acceptance subprocesses."""

from __future__ import annotations

import codecs
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from typing import Pattern


class COORD(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class STARTUPINFO(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class STARTUPINFOEX(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFO), ("lpAttributeList", ctypes.c_void_p)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD),
    ]


class JOB_BASIC_LIMIT(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class JOB_EXTENDED_LIMIT(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOB_BASIC_LIMIT), ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_OSC = re.compile(r"\x1b\].*?(?:\x07|\x1b\\)", re.DOTALL)


def _plain(value: str, columns: int = 160, rows: int = 50) -> str:
    """Render the cursor/erase operations emitted by Windows console writes.

    ConPTY sends screen changes, so merely deleting CSI sequences can reorder
    or lose approval/status text. This small screen reader retains scrollback;
    it does not supply or alter application input.
    """
    screen = [[" "] * columns for _ in range(rows)]
    history = []
    row = column = index = 0
    saved = (0, 0)

    def scroll():
        nonlocal row
        while row >= rows:
            history.append("".join(screen.pop(0)).rstrip())
            screen.append([" "] * columns)
            row -= 1

    while index < len(value):
        character = value[index]
        if character == "\x1b":
            if index + 1 >= len(value):
                break
            if value[index + 1] == "]":
                match = _OSC.match(value, index)
                if not match:
                    break
                index = match.end()
                continue
            if value[index + 1] == "[":
                match = _CSI.match(value, index)
                if not match:
                    break
                sequence = match.group()
                command = sequence[-1]
                raw = sequence[2:-1].lstrip("?<>")
                try:
                    numbers = [int(part or "0") for part in raw.split(";")]
                except ValueError:
                    numbers = [0]
                amount = numbers[0] or 1
                if command in "Hf":
                    row = min(rows - 1, max(0, (numbers[0] or 1) - 1))
                    column = min(columns - 1, max(0, (numbers[1] if len(numbers) > 1 else 1) - 1))
                elif command == "A": row = max(0, row - amount)
                elif command == "B": row = min(rows - 1, row + amount)
                elif command == "C": column = min(columns - 1, column + amount)
                elif command == "D": column = max(0, column - amount)
                elif command == "G": column = min(columns - 1, amount - 1)
                elif command == "d": row = min(rows - 1, amount - 1)
                elif command == "J" and numbers[0] == 2:
                    history.extend("".join(line).rstrip() for line in screen if any(cell != " " for cell in line))
                    screen = [[" "] * columns for _ in range(rows)]
                elif command == "K":
                    start = 0 if numbers[0] in (1, 2) else column
                    end = column + 1 if numbers[0] == 1 else columns
                    screen[row][start:end] = [" "] * (end - start)
                elif command == "S":
                    for _ in range(amount):
                        history.append("".join(screen.pop(0)).rstrip())
                        screen.append([" "] * columns)
                index = match.end()
                continue
            if value[index + 1] == "7": saved = (row, column)
            elif value[index + 1] == "8": row, column = saved
            index += 3 if value[index + 1] in "()" else 2
            continue
        if character == "\r": column = 0
        elif character == "\n":
            row += 1
            column = 0
            scroll()
        elif character == "\b": column = max(0, column - 1)
        elif character == "\t": column = min(columns - 1, (column // 8 + 1) * 8)
        elif ord(character) >= 32:
            if column >= columns:
                row += 1
                column = 0
                scroll()
            screen[row][column] = character
            column += 1
        index += 1
    return "\n".join(history + ["".join(line).rstrip() for line in screen]).rstrip()


class ConsoleProcess:
    """Create a real TTY child and retain its output without replacing stdin."""

    def __init__(self, argv: list[str], *, cwd: Path, env: dict[str, str],
                 columns: int = 160, rows: int = 50):
        if os.name != "nt":
            raise NotImplementedError("This acceptance fixture requires Windows ConPTY")
        self.argv = list(argv)
        self.columns, self.rows = columns, rows
        self.cwd = Path(cwd).resolve()
        self._chunks: list[str] = []
        self._condition = threading.Condition()
        self._cursor = 0
        self._raw_cursor = 0
        self._closed = False
        self._process = None
        self._job = None
        self._console = wintypes.HANDLE()
        self._input = wintypes.HANDLE()
        self._output = wintypes.HANDLE()
        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        k = self._kernel
        handle_pointer = ctypes.POINTER(wintypes.HANDLE)
        k.CreatePipe.argtypes = [handle_pointer, handle_pointer, ctypes.c_void_p, wintypes.DWORD]
        k.CreatePipe.restype = wintypes.BOOL
        k.CreatePseudoConsole.argtypes = [COORD, wintypes.HANDLE, wintypes.HANDLE,
                                         wintypes.DWORD, handle_pointer]
        k.CreatePseudoConsole.restype = ctypes.c_long
        k.ClosePseudoConsole.argtypes = [wintypes.HANDLE]
        k.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wintypes.DWORD,
                                                       wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)]
        k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wintypes.DWORD, ctypes.c_size_t,
                                               ctypes.c_void_p, ctypes.c_size_t,
                                               ctypes.c_void_p, ctypes.c_void_p]
        k.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
        k.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p,
                                    ctypes.c_void_p, wintypes.BOOL, wintypes.DWORD,
                                    ctypes.c_void_p, wintypes.LPCWSTR,
                                    ctypes.POINTER(STARTUPINFOEX), ctypes.POINTER(PROCESS_INFORMATION)]
        k.CreateProcessW.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                              ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        k.WriteFile.argtypes = k.ReadFile.argtypes
        k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.WaitForSingleObject.restype = wintypes.DWORD
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                             ctypes.c_void_p, wintypes.DWORD]
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.ResumeThread.argtypes = [wintypes.HANDLE]
        k.ResumeThread.restype = wintypes.DWORD
        input_read, output_write = wintypes.HANDLE(), wintypes.HANDLE()
        attributes = None
        process = PROCESS_INFORMATION()
        try:
            self._check(k.CreatePipe(ctypes.byref(input_read), ctypes.byref(self._input), None, 0))
            self._check(k.CreatePipe(ctypes.byref(self._output), ctypes.byref(output_write), None, 0))
            hresult = k.CreatePseudoConsole(COORD(columns, rows), input_read, output_write,
                                            0, ctypes.byref(self._console))
            if hresult < 0:
                raise OSError(hresult, "CreatePseudoConsole failed")
            size = ctypes.c_size_t()
            k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
            attributes = ctypes.create_string_buffer(size.value)
            self._check(k.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)))
            self._check(k.UpdateProcThreadAttribute(attributes, 0, 0x00020016,
                                                    self._console, ctypes.sizeof(wintypes.HANDLE),
                                                    None, None))
            startup = STARTUPINFOEX()
            startup.StartupInfo.cb = ctypes.sizeof(startup)
            startup.lpAttributeList = ctypes.cast(attributes, ctypes.c_void_p)
            environment = ctypes.create_unicode_buffer(
                "\0".join(f"{key}={value}" for key, value in sorted(env.items(), key=lambda item: item[0].upper())) + "\0\0"
            )
            # A redirected controller can leave inherited CRT handles in the
            # client despite its attached pseudo-console. Bind actual console
            # devices before Python initializes its untouched stdin/stdout.
            comspec = env.get("ComSpec") or env.get("COMSPEC") or str(
                Path(env.get("SystemRoot") or env["SYSTEMROOT"]) / "System32" / "cmd.exe"
            )
            command = subprocess.list2cmdline(argv)
            command_line = ctypes.create_unicode_buffer(
                f'"{comspec}" /d /s /c "{command} <CONIN$ >CONOUT$ 2>&1"'
            )
            self._check(k.CreateProcessW(comspec, command_line, None, None, False,
                                         0x00080000 | 0x00000400 | 0x00000004,
                                         environment, str(self.cwd), ctypes.byref(startup),
                                         ctypes.byref(process)))
            self._process = process.hProcess
            self.pid = int(process.dwProcessId)
            self._job = k.CreateJobObjectW(None, None)
            self._check(self._job)
            limits = JOB_EXTENDED_LIMIT()
            limits.BasicLimitInformation.LimitFlags = 0x00002000
            self._check(k.SetInformationJobObject(self._job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
            self._check(k.AssignProcessToJobObject(self._job, self._process))
            self._reader = threading.Thread(target=self._read_output, daemon=True)
            self._reader.start()
            if k.ResumeThread(process.hThread) == 0xFFFFFFFF:
                self._check(False)
        except BaseException:
            self.close()
            raise
        finally:
            if process.hThread:
                k.CloseHandle(process.hThread)
            if attributes is not None:
                k.DeleteProcThreadAttributeList(attributes)
            if input_read:
                k.CloseHandle(input_read)
            if output_write:
                k.CloseHandle(output_write)

    def _check(self, result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())
        return result

    @property
    def raw_transcript(self) -> str:
        with self._condition:
            return "".join(self._chunks)

    @property
    def transcript(self) -> str:
        return _plain(self.raw_transcript, self.columns, self.rows)

    @property
    def returncode(self) -> int | None:
        if not self._process or self._kernel.WaitForSingleObject(self._process, 0) != 0:
            return None
        code = wintypes.DWORD()
        self._check(self._kernel.GetExitCodeProcess(self._process, ctypes.byref(code)))
        return int(code.value)

    def _read_output(self):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        buffer = ctypes.create_string_buffer(8192)
        count = wintypes.DWORD()
        while self._kernel.ReadFile(self._output, buffer, len(buffer), ctypes.byref(count), None):
            if not count.value:
                break
            chunk = decoder.decode(buffer.raw[:count.value])
            with self._condition:
                self._chunks.append(chunk)
                self._condition.notify_all()

    def send(self, text: str):
        data = text.encode("utf-8")
        written = wintypes.DWORD()
        self._check(self._kernel.WriteFile(self._input, data, len(data), ctypes.byref(written), None))
        if written.value != len(data):
            raise OSError("Partial pseudo-console input write")

    def send_line(self, text: str):
        self.send(text + "\r")

    def expect(self, pattern: str | Pattern[str], timeout: float = 20) -> str:
        expression = re.compile(pattern) if isinstance(pattern, str) else pattern
        deadline = time.monotonic() + timeout
        with self._condition:
            while True:
                raw = self.raw_transcript
                value = _CSI.sub("", _OSC.sub("", raw[self._raw_cursor:])).replace("\r", "")
                match = expression.search(value)
                if match:
                    result = value[:match.end()]
                    self._raw_cursor = len(raw)
                    return result
                remaining = deadline - time.monotonic()
                if remaining <= 0 or self.returncode is not None:
                    raise TimeoutError(f"Console did not reach {expression.pattern!r}; exit={self.returncode}; tail={value[-4000:]!r}")
                self._condition.wait(min(remaining, 0.2))

    def read_available(self) -> str:
        value = self.transcript
        result = value[self._cursor:]
        self._cursor = len(value)
        return result

    def wait(self, timeout: float = 20) -> int:
        if self._kernel.WaitForSingleObject(self._process, max(0, int(timeout * 1000))) != 0:
            raise TimeoutError("Console process did not exit before deadline")
        return self.returncode

    def close(self):
        if self._closed:
            return
        self._closed = True
        k = self._kernel
        if self._process and self.returncode is None:
            k.TerminateProcess(self._process, 125)
            k.WaitForSingleObject(self._process, 3000)
        if self._job:
            k.CloseHandle(self._job)
            self._job = None
        if self._console:
            k.ClosePseudoConsole(self._console)
            self._console = wintypes.HANDLE()
        if hasattr(self, "_reader"):
            self._reader.join(timeout=2)
        for handle in (self._input, self._output, self._process):
            if handle:
                k.CloseHandle(handle)
        self._process = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
