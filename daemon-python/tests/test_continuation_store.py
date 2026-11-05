"""Native Windows protection, bounded snapshots, ownership and crash-safe claims."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from arcanos import continuation_store as storage

TOKEN = "v1." + "D" * 43
BACKEND = "a" * 64
OTHER_BACKEND = "b" * 64
JOB = "00000000-0000-4000-8000-000000000001"
QUESTION = "Synthetic original question — café 雪."
pytestmark = pytest.mark.skipif(os.name != "nt", reason="Actual user-bound DPAPI and Windows byte-range locks required")


def record(number=1, **updates):
    """Construct bounded synthetic metadata without borrowing any operator credential."""
    value = {"job_id": f"00000000-0000-4000-8000-{number:012d}", "job_read_token": TOKEN,
             "question": QUESTION, "session_id": "original-conversation", "created_at": 1_793_900_000.0,
             "expires_at": 1_793_986_400.0, "state": "pending"}
    value.update(updates)
    return value


@pytest.fixture
def store(tmp_path):
    """Create protected storage only inside the test's disposable profile directory."""
    return storage.ContinuationStore(tmp_path, BACKEND)


def _child_environment(data_dir):
    """Pin subprocess imports/state to this checkout without relying on pytest's sys.path."""
    environment = dict(os.environ)
    environment.update(PYTHONPATH=str(Path(__file__).resolve().parents[1]), DATA_DIR=str(data_dir),
                       MEMORY_FILE=str(data_dir / "memory.json"), HISTORY_DB_PATH=str(data_dir / "history.db"),
                       LOG_DIR=str(data_dir / "logs"), OPENAI_API_KEY="synthetic-unused-native-storage-test-key",
                       ARCANOS_ENV_PATH=str(data_dir / "unused-native-test.env"))
    return environment


def test_native_dpapi_round_trip_is_ciphertext_only_and_survives_reopen(store):
    """Protect the entire record and recover it through a fresh store instance."""
    store.add(record())
    encrypted = store.path.read_bytes()
    assert encrypted.startswith(storage._HEADER)
    for marker in (TOKEN, QUESTION, JOB, "original-conversation", BACKEND):
        assert marker.encode("utf-8") not in encrypted
    reopened = storage.ContinuationStore(store.directory.parent, BACKEND)
    assert reopened.load()[0]["question"] == QUESTION
    assert reopened.load()[0]["job_read_token"] == TOKEN
    assert reopened.load()[0]["session_id"] == "original-conversation"
    assert set(path.name for path in store.directory.iterdir()) == {"pending.dpapi", "coordination.lock"}


def test_fresh_process_recovers_native_user_protected_records(store):
    """A new Python process under the same Windows account can decrypt retained work."""
    store.add(record())
    command = (
        "import json,os,sys; from pathlib import Path; "
        "import arcanos.env as runtime_env; runtime_env._BOOTSTRAPPED=True; "
        "runtime_env._BASE_DIR=Path(os.environ['DATA_DIR']); "
        "from arcanos.continuation_store import ContinuationStore; "
        "r=ContinuationStore(Path(sys.argv[1]),sys.argv[2]).load(); "
        "print(json.dumps({'count':len(r),'original_session':r[0]['session_id']=='original-conversation',"
        "'valid_capability':len(r[0]['job_read_token'])==46}))"
    )
    child = subprocess.run([sys.executable, "-B", "-c", command, str(store.directory.parent), BACKEND],
                           capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW,
                           env=_child_environment(store.directory.parent))
    assert child.returncode == 0
    assert json.loads(child.stdout) == {"count": 1, "original_session": True, "valid_capability": True}
    assert TOKEN not in child.stdout + child.stderr


def test_backend_partition_cannot_read_or_delete_other_backend(store):
    """A different authenticated backend fingerprint never exposes retained capabilities."""
    store.add(record())
    other = storage.ContinuationStore(store.directory.parent, OTHER_BACKEND)
    assert other.load() == []
    other.remove(JOB)
    assert len(store.load()) == 1
    other.add(record(2))
    assert [row["job_id"] for row in other.load()] == [record(2)["job_id"]]
    assert [row["job_id"] for row in store.load()] == [JOB]


def test_different_windows_sid_is_rejected_as_an_identity_fault(store, monkeypatch):
    """Simulate a foreign Windows SID; this is not a second-account logon test."""
    store.add(record())
    monkeypatch.setattr(storage, "_current_user_sid", lambda: "S-1-5-21-synthetic-other-user")
    foreign = storage.ContinuationStore(store.directory.parent, BACKEND)
    with pytest.raises(storage.ContinuationStorageError) as error:
        foreign.load()
    assert TOKEN not in str(error.value)
    assert store.path.exists()


def test_dpapi_denies_anonymous_windows_principal_in_isolated_process(store):
    """Exercise actual impersonation in a disposable child, never the pytest process."""
    store.add(record())
    command = r'''
import ctypes,json,os,sys
from ctypes import wintypes
from pathlib import Path
import arcanos.env as runtime_env
runtime_env._BOOTSTRAPPED=True
runtime_env._BASE_DIR=Path(os.environ['DATA_DIR'])
from arcanos.continuation_store import _dpapi,_HEADER,ContinuationStorageError
ciphertext=Path(sys.argv[1]).read_bytes()[len(_HEADER):]
assert _dpapi(ciphertext,decrypt=True)
kernel32=ctypes.WinDLL('kernel32',use_last_error=True)
advapi32=ctypes.WinDLL('advapi32',use_last_error=True)
kernel32.GetCurrentThread.restype=wintypes.HANDLE
advapi32.ImpersonateAnonymousToken.argtypes=[wintypes.HANDLE]
advapi32.ImpersonateAnonymousToken.restype=wintypes.BOOL
advapi32.RevertToSelf.restype=wintypes.BOOL
if not advapi32.ImpersonateAnonymousToken(kernel32.GetCurrentThread()):
    print(json.dumps({'impersonation':'unavailable'}))
    sys.exit(0)
denied=False
try:
    try:
        _dpapi(ciphertext,decrypt=True)
    except ContinuationStorageError:
        denied=True
finally:
    reverted=bool(advapi32.RevertToSelf())
print(json.dumps({'impersonation':'available','decryption_denied':denied,'reverted':reverted}))
'''
    child = subprocess.run([sys.executable, "-B", "-c", command, str(store.path)],
                           capture_output=True, text=True, timeout=15, creationflags=subprocess.CREATE_NO_WINDOW,
                           env=_child_environment(store.directory.parent))
    assert child.returncode == 0
    assert TOKEN not in child.stdout + child.stderr
    result = json.loads(child.stdout)
    if result == {"impersonation": "unavailable"}:
        pytest.skip("Windows denied anonymous-principal impersonation in the isolated child")
    assert result == {"impersonation": "available", "decryption_denied": True, "reverted": True}


def test_dpapi_rejects_corruption_without_overwriting_original_data(store):
    """DPAPI authenticates the ciphertext and corrupt records remain unavailable."""
    store.add(record())
    damaged = bytearray(store.path.read_bytes())
    damaged[-20] ^= 0x40
    store.path.write_bytes(damaged)
    with pytest.raises(storage.ContinuationStorageError):
        store.load()
    with pytest.raises(storage.ContinuationStorageError):
        store.add(record(2))
    assert store.path.read_bytes() == damaged


@pytest.mark.parametrize("payload", [b"{}", b"plaintext " + TOKEN.encode(), b"x" * (storage.MAX_RECOVERY_BYTES + 1)],
                         ids=["unknown-format", "plaintext", "oversize"])
def test_plaintext_unknown_and_oversize_files_fail_closed(store, payload):
    """Untrusted formats are never interpreted as accepted work or silently reset."""
    store.path.write_bytes(payload)
    with pytest.raises(storage.ContinuationStorageError) as error:
        store.load()
    assert TOKEN not in str(error.value)
    assert store.path.read_bytes() == payload


def test_maximum_eight_records_applies_across_backend_partitions(store):
    """Bound total encrypted state rather than permitting unbounded backend partitions."""
    other = storage.ContinuationStore(store.directory.parent, OTHER_BACKEND)
    for number in range(1, storage.MAX_RECOVERY_RECORDS + 1):
        (store if number % 2 else other).add(record(number))
    with pytest.raises(storage.ContinuationStorageError):
        store.add(record(9))
    assert len(store.load()) == len(other.load()) == 4
    assert store.path.stat().st_size < storage.MAX_RECOVERY_BYTES


def test_duplicate_acceptance_cannot_replace_question_or_capability(store):
    """Idempotent retention keeps lifecycle state and the original question unchanged."""
    store.add(record())
    store.update(JOB, state="ready", result={"response_text": "Approved complete answer"})
    store.add(record())
    assert store.load()[0]["state"] == "ready"
    with pytest.raises(storage.ContinuationStorageError):
        store.add(record(question="A different request must not steal this result"))
    assert store.load()[0]["question"] == QUESTION


def test_lifecycle_evidence_is_atomic_and_accounting_cannot_reverse(store):
    """Persist completion progress without permitting ownership or accounting rollback."""
    store.add(record())
    store.update(JOB, state="recorded", accounted=True, audit_recorded=True)
    reopened = storage.ContinuationStore(store.directory.parent, BACKEND)
    assert reopened.load()[0]["accounted"] is True
    with pytest.raises(storage.ContinuationStorageError):
        reopened.update(JOB, accounted=False)
    with pytest.raises(storage.ContinuationStorageError):
        reopened.update(JOB, question="different question")
    assert reopened.load()[0]["audit_recorded"] is True
    reopened.remove(JOB)
    assert store.load() == []


def test_failed_atomic_rename_preserves_old_snapshot_and_ciphertext_temporary(store, monkeypatch):
    """A write crash before replacement leaves the previous committed snapshot readable."""
    store.add(record())
    previous = store.path.read_bytes()

    def fail_replace(source, destination):
        """Inspect only encrypted bytes at the simulated crash boundary."""
        encrypted = source.read_bytes()
        assert TOKEN.encode() not in encrypted
        assert QUESTION.encode() not in encrypted
        raise OSError("synthetic atomic rename failure")

    with monkeypatch.context() as patch:
        patch.setattr(storage, "_atomic_replace", fail_replace)
        with pytest.raises(storage.ContinuationStorageError):
            store.add(record(2))
    assert store.path.read_bytes() == previous
    assert [row["job_id"] for row in store.load()] == [JOB]
    store.add(record(2))
    assert len(store.load()) == 2
    assert len(list(store.directory.iterdir())) == 2


@pytest.mark.parametrize("failure", ["unlock", "lseek", "close"])
def test_cleanup_fault_releases_native_descriptor_and_local_state_lock(store, monkeypatch, failure):
    """A post-commit cleanup error stays visible without stranding either coordination lock."""
    import msvcrt
    native_locking, native_seek, native_close = msvcrt.locking, os.lseek, os.close
    replace = storage._atomic_replace
    fault = {"armed": False, "triggered": False, "fd": None}

    def committed(source, destination):
        """Arm the one-shot native fault only after a real DPAPI atomic commit."""
        replace(source, destination)
        fault["armed"] = True

    def should_fail(kind, fd):
        """Select exactly one resource-cleanup operation after the committed write."""
        if failure == kind and fault["armed"] and not fault["triggered"]:
            fault.update(triggered=True, fd=fd)
            return True
        return False

    def locking(fd, mode, size):
        """Keep the real Windows byte lock, injecting only its unlock failure."""
        if mode == msvcrt.LK_UNLCK and should_fail("unlock", fd):
            raise OSError("Synthetic post-commit unlock failure")
        return native_locking(fd, mode, size)

    def seek(fd, offset, whence):
        """Exercise failure while seeking to the locked byte before unlocking."""
        if should_fail("lseek", fd):
            raise OSError("Synthetic post-commit lseek failure")
        return native_seek(fd, offset, whence)

    def close(fd):
        """Model an error reported after native descriptor closure, without leaking it."""
        if should_fail("close", fd):
            native_close(fd)
            raise OSError("Synthetic post-commit close failure")
        return native_close(fd)

    monkeypatch.setattr(storage, "_atomic_replace", committed)
    monkeypatch.setattr(msvcrt, "locking", locking)
    monkeypatch.setattr(os, "lseek", seek)
    monkeypatch.setattr(os, "close", close)
    local = None
    try:
        with pytest.raises(OSError, match="Synthetic post-commit"):
            store.add(record())
        assert fault["triggered"] and store.path.exists()
        local = storage._THREAD_LOCKS[(str(store.lock_path).casefold(), 0)]
        assert not local.locked()
        assert store.load()[0]["job_id"] == JOB
    finally:
        # Also clean an unfixed implementation after its expected failing-before
        # assertion, so a leaked test lock never prevents pytest temp cleanup.
        if local is not None and local.locked():
            if failure != "close":
                native_close(fault["fd"])
            local.release()


@pytest.mark.parametrize("field,value", [("job_id", "not-a-job"), ("job_read_token", "invalid"),
                                       ("state", "unknown"), ("created_at", float("nan")),
                                       ("session_id", ""), ("question", "\ud800")])
def test_invalid_coordinates_fail_closed_without_sensitive_errors(store, field, value):
    """Reject invalid persisted coordinates before encrypting or trusting them."""
    with pytest.raises(storage.ContinuationStorageError) as error:
        store.add(record(**{field: value}))
    assert TOKEN not in str(error.value)
    assert store.load() == []


def test_thread_claims_and_leader_are_nonblocking_and_reusable(store):
    """Only one worker owns a job or monitor leader at a time, without polling forever."""
    store.add(record())

    def contender(key):
        """Try to acquire an already-owned claim from another thread."""
        with store.claim(key) as acquired:
            return acquired

    with store.claim(JOB) as owned:
        assert owned
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(contender, JOB).result(timeout=3) is False
    with store.claim("__monitor__") as leader:
        assert leader
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(contender, "__monitor__").result(timeout=3) is False
    with store.claim(JOB) as owned:
        assert owned
    with store.claim(record(2)["job_id"]) as absent:
        assert absent is False


def test_monitor_leaders_are_backend_scoped_and_nonrecursive(store):
    """Independent backends coexist while duplicate controllers remain excluded."""
    same = storage.ContinuationStore(store.directory.parent, BACKEND)
    other = storage.ContinuationStore(store.directory.parent, OTHER_BACKEND)
    with store.claim("__monitor__") as first:
        assert first
        with same.claim("__monitor__") as duplicate:
            assert duplicate is False
        with other.claim("__monitor__") as independent:
            assert independent is True
    with same.claim("__monitor__") as released:
        assert released is True
    assert set(path.name for path in store.directory.iterdir()) == {"coordination.lock"}


def test_native_process_claim_releases_after_process_crash(store, tmp_path):
    """Windows releases a crashed monitor's lock so a later process can recover safely."""
    ready = tmp_path / "claim-ready"
    command = (
        "import os,sys,time; from pathlib import Path; "
        "import arcanos.env as runtime_env; runtime_env._BOOTSTRAPPED=True; "
        "runtime_env._BASE_DIR=Path(os.environ['DATA_DIR']); "
        "from arcanos.continuation_store import ContinuationStore; "
        "s=ContinuationStore(Path(sys.argv[1]),sys.argv[2]); "
        "c=s.claim('__monitor__'); owned=c.__enter__(); "
        "Path(sys.argv[3]).write_text('owned' if owned else 'busy'); time.sleep(30)"
    )
    child = subprocess.Popen([sys.executable, "-B", "-c", command, str(store.directory.parent), BACKEND, str(ready)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW,
                             env=_child_environment(store.directory.parent))
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.025)
        assert ready.read_text() == "owned"
        with store.claim("__monitor__") as owned:
            assert owned is False
        child.kill()
        child.wait(timeout=5)
        with store.claim("__monitor__") as owned:
            assert owned is True
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        if child.stderr:
            child.stderr.close()


def test_reparse_point_or_hardlink_storage_is_rejected(store, tmp_path):
    """Reject path indirection before protected records can be read or replaced."""
    store.add(record())
    linked = tmp_path / "linked-state"
    os.link(store.path, linked)
    with pytest.raises(storage.ContinuationStorageError):
        store.load()
    linked.unlink()
    assert len(store.load()) == 1


def test_protected_directory_acl_uses_only_current_windows_identity(store):
    """Verify the existing native ACL helper grants no inherited or additional principal."""
    from arcanos.action_plan_execution_journal import _windows_acl_entries, _windows_current_identity
    result = subprocess.run(["icacls", str(store.directory)], capture_output=True, text=True,
                            timeout=10, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    entries = _windows_acl_entries(store.directory, result.stdout)
    assert len(entries) == 1
    assert entries[0][0].casefold() == _windows_current_identity().casefold()
    assert set(entries[0][1]) == {"OI", "CI", "F"}


def test_existing_ciphertext_has_private_file_acl_after_reopen(store):
    """Revalidate an existing snapshot's ACL as well as the parent directory."""
    from arcanos.action_plan_execution_journal import _windows_acl_entries, _windows_current_identity
    store.add(record())
    reopened = storage.ContinuationStore(store.directory.parent, BACKEND)
    result = subprocess.run(["icacls", str(reopened.path)], capture_output=True, text=True,
                            timeout=10, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    entries = _windows_acl_entries(reopened.path, result.stdout)
    assert len(entries) == 1
    assert entries[0][0].casefold() == _windows_current_identity().casefold()
    assert entries[0][1] == ("F",)


def test_oversize_coordination_file_fails_closed(store):
    """Reject tampered coordination data instead of allowing unbounded auxiliary disk use."""
    store.lock_path.write_bytes(b"x" * (storage.MAX_COORDINATION_BYTES + 1))
    with pytest.raises(storage.ContinuationStorageError):
        store.load()
    with pytest.raises(storage.ContinuationStorageError):
        storage.ContinuationStore(store.directory.parent, BACKEND)


def test_origin_owns_before_snapshot_is_visible_and_hands_off_on_release(store, monkeypatch):
    """A retained job cannot be claimed by another console before its origin owns it."""
    other = storage.ContinuationStore(store.directory.parent, BACKEND)
    original_write = store._write
    observed = []

    def committed(records):
        """Inspect the actual local owner before committing the protected snapshot."""
        observed.append(store.owns(JOB))
        return original_write(records)

    monkeypatch.setattr(store, "_write", committed)
    store.add(record(), claim_owner=True)
    try:
        assert observed == [True]
        assert store.owns(JOB)
        assert not other.acquire_ownership(JOB)
        store.release_ownerships()
        assert other.acquire_ownership(JOB)
        assert not store.acquire_ownership(JOB)
        other.remove(JOB)
        assert not other.owns(JOB)
        assert store.load() == []
    finally:
        store.release_ownerships()
        other.release_ownerships()


def test_failed_owned_snapshot_releases_the_native_claim(store, monkeypatch):
    """A failed encrypted write cannot leave an invisible live owner reservation behind."""
    def failed(_records):
        """Fail before committing any private coordinates."""
        raise storage.ContinuationStorageError("Synthetic persistence failure")

    with monkeypatch.context() as patch:
        patch.setattr(store, "_write", failed)
        with pytest.raises(storage.ContinuationStorageError):
            store.add(record(), claim_owner=True)
    assert not store.owns(JOB)
    other = storage.ContinuationStore(store.directory.parent, BACKEND)
    other.add(record(), claim_owner=True)
    try:
        assert other.owns(JOB)
        assert storage.ContinuationStore(store.directory.parent, OTHER_BACKEND).acquire_ownership(JOB) is False
    finally:
        other.release_ownerships()
