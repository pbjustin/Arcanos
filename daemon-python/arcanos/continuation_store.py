"""Bounded, user-protected continuation coordinates and cross-process claims."""

from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import re
import stat
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from uuid import UUID

from .action_plan_execution_journal import _secure_path

MAX_RECOVERY_RECORDS = 8
MAX_RECOVERY_BYTES = 2 * 1024 * 1024
MAX_QUESTION_BYTES = 128 * 1024
_HEADER = b"ARCANOS-CONTINUATION-DPAPI-1\n"
_ENTROPY = b"arcanos:conversation-recovery:v1"
_STATES = {"pending", "ready", "recorded", "displaying", "delivered", "terminal"}
_THREAD_LOCKS: dict[tuple[str, int], threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


class ContinuationStorageError(RuntimeError):
    """Protected recovery data is unavailable, untrusted, full or not writable."""


class _DataBlob(ctypes.Structure):
    """Native DPAPI byte buffer; its data never becomes a filename or log field."""

    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _blob(value: bytes) -> tuple[_DataBlob, Any]:
    """Keep a native input buffer alive for the complete DPAPI operation."""
    buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
    return _DataBlob(len(value), buffer), buffer


def _dpapi(value: bytes, *, decrypt: bool) -> bytes:
    """Use current-user DPAPI with integrity checking and no interactive prompts."""
    if os.name != "nt":
        raise ContinuationStorageError("Protected continuation storage requires Windows.")
    try:
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        operation = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
        operation.argtypes = [ctypes.POINTER(_DataBlob), ctypes.c_void_p,
                              ctypes.POINTER(_DataBlob), ctypes.c_void_p,
                              ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(_DataBlob)]
        operation.restype = ctypes.c_int
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        source, source_buffer = _blob(value)
        entropy, entropy_buffer = _blob(_ENTROPY)
        output = _DataBlob()
        # Never use CRYPTPROTECT_LOCAL_MACHINE: another Windows user must not decrypt.
        if not operation(ctypes.byref(source), None, ctypes.byref(entropy), None, None,
                         0x1, ctypes.byref(output)):
            raise ContinuationStorageError("Protected continuation data could not be verified.")
        try:
            return ctypes.string_at(output.pbData, output.cbData)
        finally:
            kernel32.LocalFree(output.pbData)
    except (AttributeError, OSError, ValueError):
        raise ContinuationStorageError("Protected continuation data could not be verified.") from None


def _current_user_sid() -> str:
    """Resolve a stable Windows account SID, independent of process/session IDs."""
    if os.name != "nt":
        raise ContinuationStorageError("Protected continuation storage requires Windows.")
    try:
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
        advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                               wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x8, ctypes.byref(token)):
            raise OSError
        try:
            size = wintypes.DWORD()
            advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
            if not size.value or size.value > 65536:
                raise OSError
            user = ctypes.create_string_buffer(size.value)
            if not advapi32.GetTokenInformation(token, 1, user, size, ctypes.byref(size)):
                raise OSError
            sid = ctypes.cast(user, ctypes.POINTER(ctypes.c_void_p)).contents.value
            text = ctypes.c_wchar_p()
            if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
                raise OSError
            try:
                return str(text.value)
            finally:
                kernel32.LocalFree(ctypes.cast(text, ctypes.c_void_p))
        finally:
            kernel32.CloseHandle(token)
    except (AttributeError, OSError, ValueError):
        raise ContinuationStorageError("The Windows recovery identity is unavailable.") from None


def _check_path(path: Path, *, directory: bool, missing: bool = False) -> None:
    """Reject symlinks, junctions, hardlinks and unexpected file kinds before I/O."""
    try:
        for candidate in (path, *path.parents):
            try:
                details = candidate.lstat()
            except FileNotFoundError:
                if candidate == path and missing:
                    continue
                raise
            if stat.S_ISLNK(details.st_mode) or getattr(details, "st_file_attributes", 0) & 0x400:
                raise OSError
            if candidate == path:
                expected = stat.S_ISDIR(details.st_mode) if directory else stat.S_ISREG(details.st_mode)
                if not expected or (not directory and details.st_nlink != 1):
                    raise OSError
    except OSError:
        raise ContinuationStorageError("The recovery storage path is not private and regular.") from None


def _atomic_replace(source: Path, destination: Path) -> None:
    """Commit an already-fsynced ciphertext file with Windows write-through rename."""
    try:
        if os.name == "nt":
            operation = ctypes.WinDLL("kernel32", use_last_error=True).MoveFileExW
            operation.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
            operation.restype = ctypes.c_int
            if not operation(str(source), str(destination), 0x1 | 0x8):
                raise OSError
        else:
            os.replace(source, destination)
    except (AttributeError, OSError):
        raise ContinuationStorageError("Protected continuation data could not be committed.") from None


def _valid_record(record: Any) -> bool:
    """Validate closed recovery metadata without treating stored session IDs as authority."""
    if not isinstance(record, dict):
        return False
    required = {"job_id", "job_read_token", "question", "session_id", "created_at", "backend_identity", "state", "_slot"}
    allowed = required | {"expires_at", "result", "accounted", "audit_recorded"}
    if not required <= record.keys() or not record.keys() <= allowed:
        return False
    try:
        if str(UUID(record["job_id"])) != record["job_id"]:
            return False
    except (ValueError, TypeError, AttributeError):
        return False
    if not isinstance(record["job_read_token"], str) or re.fullmatch(r"v1\.[A-Za-z0-9_-]{43}", record["job_read_token"]) is None:
        return False
    if not isinstance(record["backend_identity"], str) or re.fullmatch(r"[0-9a-f]{64}", record["backend_identity"]) is None:
        return False
    if not isinstance(record["question"], str) or not record["question"].strip():
        return False
    try:
        if len(record["question"].encode("utf-8")) > MAX_QUESTION_BYTES:
            return False
    except UnicodeError:
        return False
    if not isinstance(record["session_id"], str) or not 0 < len(record["session_id"]) <= 128:
        return False
    if type(record["_slot"]) is not int or not 0 <= record["_slot"] < MAX_RECOVERY_RECORDS:
        return False
    if not isinstance(record["state"], str) or record["state"] not in _STATES:
        return False
    for key in ("created_at", "expires_at"):
        value = record.get(key)
        if value is None and key == "expires_at":
            continue
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            return False
    if any(type(record[key]) is not bool for key in ("accounted", "audit_recorded") if key in record):
        return False
    return True


class ContinuationStore:
    """One encrypted eight-record snapshot, with fixed-size OS coordination locks."""

    def __init__(self, data_dir: Path, backend_identity: str) -> None:
        """Bind storage to this Windows user and an authenticated backend fingerprint."""
        if not isinstance(backend_identity, str) or re.fullmatch(r"[0-9a-f]{64}", backend_identity) is None:
            raise ContinuationStorageError("The recovery backend identity is invalid.")
        self.backend_identity = backend_identity
        self.owner_sid = _current_user_sid()
        self.directory = Path(data_dir).absolute() / "conversation-recovery"
        self.path = self.directory / "pending.dpapi"
        self.lock_path = self.directory / "coordination.lock"
        self._temporary_path = self.directory / "pending.replace"
        try:
            _check_path(self.directory.parent, directory=True)
            _check_path(self.directory, directory=True, missing=True)
            self.directory.mkdir(exist_ok=True)
            _secure_path(self.directory, directory=True)
            for candidate in (self.path, self.lock_path, self._temporary_path):
                _check_path(candidate, directory=False, missing=True)
                if candidate.exists():
                    limit = 10 if candidate == self.lock_path else MAX_RECOVERY_BYTES
                    if candidate.stat().st_size > limit:
                        raise OSError
                    _secure_path(candidate, directory=False)
            fd = os.open(self.lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_BINARY", 0), 0o600)
            os.close(fd)
            _secure_path(self.lock_path, directory=False)
        except (OSError, RuntimeError):
            raise ContinuationStorageError("Protected continuation storage is unavailable.") from None

    @contextmanager
    def _byte_lock(self, offset: int, *, wait: bool = False) -> Iterator[bool]:
        """Acquire one bounded byte-range lock; the OS releases it on process death."""
        import msvcrt
        key = (str(self.lock_path).casefold(), offset)
        with _THREAD_LOCKS_GUARD:
            local = _THREAD_LOCKS.setdefault(key, threading.Lock())
        acquired = local.acquire(timeout=2.0) if wait else local.acquire(blocking=False)
        if not acquired:
            yield False
            return
        fd = None
        locked = False
        body_entered = False
        try:
            _check_path(self.lock_path, directory=False)
            if self.lock_path.stat().st_size > 10:
                raise OSError
            fd = os.open(self.lock_path, os.O_RDWR | getattr(os, "O_BINARY", 0))
            deadline = time.monotonic() + (2.0 if wait else 0.0)
            while True:
                try:
                    os.lseek(fd, offset, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.025)
            body_entered = True
            yield locked
        except OSError:
            if body_entered:
                raise
            raise ContinuationStorageError("Recovery coordination is unavailable.") from None
        finally:
            try:
                if fd is not None and locked:
                    os.lseek(fd, offset, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            finally:
                try:
                    if fd is not None:
                        os.close(fd)
                finally:
                    local.release()

    @contextmanager
    def _transaction(self) -> Iterator[list[dict[str, Any]]]:
        """Serialize bounded snapshot reads and writes across processes and threads."""
        with self._byte_lock(0, wait=True) as acquired:
            if not acquired:
                raise ContinuationStorageError("Recovery storage is busy.")
            yield self._read()

    @contextmanager
    def _monitor_mutex(self) -> Iterator[bool]:
        """Claim this user's backend monitor across Windows sessions and processes."""
        from ctypes import wintypes

        class SecurityAttributes(ctypes.Structure):
            """Restrict the named kernel object to the current Windows account."""

            _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                        ("bInheritHandle", wintypes.BOOL)]

        identity = "\0".join((str(self.directory).casefold(), self.owner_sid, self.backend_identity))
        name = "Global\\ARCANOSConversationRecovery-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()
        # Win32 mutex ownership is recursive within one thread. A local nonrecursive
        # lock keeps two controllers in that thread from both becoming the leader.
        with _THREAD_LOCKS_GUARD:
            local = _THREAD_LOCKS.setdefault((name, -1), threading.Lock())
        if not local.acquire(blocking=False):
            yield False
            return
        handle = None
        descriptor = ctypes.c_void_p()
        acquired = False
        body_entered = False
        kernel32 = None
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
            advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
                wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
            advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
            kernel32.CreateMutexW.argtypes = [ctypes.POINTER(SecurityAttributes), wintypes.BOOL, wintypes.LPCWSTR]
            kernel32.CreateMutexW.restype = wintypes.HANDLE
            kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel32.WaitForSingleObject.restype = wintypes.DWORD
            kernel32.ReleaseMutex.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.LocalFree.argtypes = [ctypes.c_void_p]
            if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    "D:P(A;;GA;;;" + self.owner_sid + ")", 1, ctypes.byref(descriptor), None):
                raise OSError
            attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
            handle = kernel32.CreateMutexW(ctypes.byref(attributes), False, name)
            if not handle:
                raise OSError
            status = kernel32.WaitForSingleObject(handle, 0)
            if status not in (0, 0x80, 0x102):  # owned, abandoned owner, or immediate timeout
                raise OSError
            acquired = status in (0, 0x80)
            body_entered = True
            yield acquired
        except (AttributeError, OSError, ValueError):
            if body_entered:
                raise
            raise ContinuationStorageError("Recovery coordination is unavailable.") from None
        finally:
            if kernel32 is not None:
                if handle:
                    if acquired:
                        kernel32.ReleaseMutex(handle)
                    kernel32.CloseHandle(handle)
                if descriptor:
                    kernel32.LocalFree(descriptor)
            local.release()

    def _read(self) -> list[dict[str, Any]]:
        """Decrypt and validate a whole snapshot, refusing corruption without overwriting it."""
        try:
            _check_path(self.path, directory=False, missing=True)
            if not self.path.exists():
                return []
            if self.path.stat().st_size > MAX_RECOVERY_BYTES:
                raise ValueError
            encrypted = self.path.read_bytes()
            if not encrypted.startswith(_HEADER):
                raise ValueError
            plaintext = _dpapi(encrypted[len(_HEADER):], decrypt=True)
            if len(plaintext) > MAX_RECOVERY_BYTES:
                raise ValueError
            payload = json.loads(plaintext)
            if not isinstance(payload, dict) or set(payload) != {"version", "owner_sid", "records"}:
                raise ValueError
            records = payload["records"]
            if payload["version"] != 1 or payload["owner_sid"] != self.owner_sid:
                raise ValueError
            if not isinstance(records, list) or len(records) > MAX_RECOVERY_RECORDS:
                raise ValueError
            if not all(_valid_record(record) for record in records):
                raise ValueError
            if len({record["_slot"] for record in records}) != len(records):
                raise ValueError
            if len({(record["backend_identity"], record["job_id"]) for record in records}) != len(records):
                raise ValueError
            return records
        except (OSError, ValueError, TypeError, UnicodeError, ContinuationStorageError):
            raise ContinuationStorageError("Protected continuation data is unavailable or untrusted.") from None

    def _write(self, records: list[dict[str, Any]]) -> None:
        """Write ciphertext only, fsync it, then atomically replace the old snapshot."""
        try:
            if len(records) > MAX_RECOVERY_RECORDS or not all(_valid_record(record) for record in records):
                raise ValueError
            plaintext = json.dumps({"version": 1, "owner_sid": self.owner_sid, "records": records},
                                   ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            if len(plaintext) > MAX_RECOVERY_BYTES:
                raise ValueError
            encrypted = _HEADER + _dpapi(plaintext, decrypt=False)
            if len(encrypted) > MAX_RECOVERY_BYTES:
                raise ValueError
            _check_path(self.directory, directory=True)
            for candidate in (self.path, self._temporary_path):
                _check_path(candidate, directory=False, missing=True)
            fd = os.open(self._temporary_path, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | getattr(os, "O_BINARY", 0), 0o600)
            try:
                _secure_path(self._temporary_path, directory=False)
                with os.fdopen(fd, "wb") as stream:
                    fd = -1
                    stream.write(encrypted)
                    stream.flush()
                    os.fsync(stream.fileno())
                _atomic_replace(self._temporary_path, self.path)
            finally:
                if fd != -1:
                    os.close(fd)
        except (OSError, ValueError, TypeError, UnicodeError, RuntimeError):
            raise ContinuationStorageError("Protected continuation data could not be committed.") from None

    def load(self) -> list[dict[str, Any]]:
        """Return only this authenticated backend's records, preserving other partitions."""
        with self._transaction() as records:
            return [dict(record) for record in records if record["backend_identity"] == self.backend_identity]

    def add(self, record: dict[str, Any]) -> None:
        """Persist accepted coordinates once without replacing the original question."""
        with self._transaction() as records:
            candidate = dict(record)
            candidate.setdefault("backend_identity", self.backend_identity)
            existing = next((row for row in records if row["backend_identity"] == self.backend_identity
                             and row["job_id"] == candidate.get("job_id")), None)
            if existing is not None:
                keys = ("job_read_token", "question", "session_id", "backend_identity")
                if any(candidate.get(key) != existing[key] for key in keys):
                    raise ContinuationStorageError("Conflicting recovery coordinates were rejected.")
                return
            if len(records) >= MAX_RECOVERY_RECORDS:
                raise ContinuationStorageError("The protected recovery limit has been reached.")
            candidate["_slot"] = next(slot for slot in range(MAX_RECOVERY_RECORDS) if all(row["_slot"] != slot for row in records))
            if candidate["backend_identity"] != self.backend_identity or not _valid_record(candidate):
                raise ContinuationStorageError("Recovery coordinates are invalid.")
            records.append(candidate)
            self._write(records)

    def update(self, job_id: str, **fields: Any) -> dict[str, Any]:
        """Commit lifecycle/accounting evidence without changing immutable coordinates."""
        if not fields.keys() <= {"state", "expires_at", "result", "accounted", "audit_recorded"}:
            raise ContinuationStorageError("Recovery updates cannot change ownership.")
        with self._transaction() as records:
            record = next((row for row in records if row["backend_identity"] == self.backend_identity and row["job_id"] == job_id), None)
            if record is None:
                raise ContinuationStorageError("The recovery record is unavailable.")
            if any(record.get(key) is True and fields.get(key) is False for key in ("accounted", "audit_recorded")):
                raise ContinuationStorageError("Recovery accounting cannot be reversed.")
            record.update(fields)
            if not _valid_record(record):
                raise ContinuationStorageError("Recovery lifecycle evidence is invalid.")
            self._write(records)
            return dict(record)

    def remove(self, job_id: str) -> None:
        """Retire only this backend's consumed or terminal coordinates."""
        with self._transaction() as records:
            remaining = [row for row in records if row["backend_identity"] != self.backend_identity or row["job_id"] != job_id]
            if len(remaining) != len(records):
                self._write(remaining)

    @contextmanager
    def claim(self, job_id: str) -> Iterator[bool]:
        """Claim one job or this backend's monitor leader until context exit."""
        if job_id == "__monitor__":
            with self._monitor_mutex() as acquired:
                yield acquired
            return
        with self._transaction() as records:
            record = next((row for row in records if row["backend_identity"] == self.backend_identity and row["job_id"] == job_id), None)
            slot = record["_slot"] if record is not None else None
        if slot is None:
            yield False
            return
        with self._byte_lock(slot + 1) as acquired:
            if not acquired:
                yield False
                return
            with self._transaction() as records:
                valid = any(row["backend_identity"] == self.backend_identity and row["job_id"] == job_id
                            and row["_slot"] == slot for row in records)
            yield valid
