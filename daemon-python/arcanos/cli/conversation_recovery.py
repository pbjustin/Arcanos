"""Recover only accepted conversations with bounded reads and protected coordinates."""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any, TYPE_CHECKING

from ..backend_client_models import BackendChatContinuation
from ..continuation_store import ContinuationStore, ContinuationStorageError
from ..config import Config
from ..cli_midlayer import translate
from . import state, ui_ops
from .audit import record as audit_record
from .cli_policy import redact_output
from .context import resolve_persona

if TYPE_CHECKING:
    from .cli import ArcanosCLI


class ConversationRecovery:
    """One process leader reads at most eight original jobs, never a generation route."""

    def __init__(self, cli: "ArcanosCLI", store: Any = None, *, clock=time.monotonic):
        """Bind protected records and a short-timeout reader to the authenticated backend."""
        self.cli = cli
        self.client = cli.backend_client
        self.identity = self.client.continuation_identity()
        self.reader = self.client.continuation_reader()
        self.store = store if store is not None else ContinuationStore(Config.DATA_DIR, self.identity)
        self.clock = clock
        self.stop_event = threading.Event()
        self.wakeup = threading.Event()
        self.thread: threading.Thread | None = None
        self.schedule: dict[str, tuple[float, int]] = {}
        self.notices: dict[str, str] = {}
        self._protected_jobs: set[str] = set()
        self.restore()

    def _identity_matches(self) -> bool:
        """A stored session is correlation data, never authority for a different backend."""
        try:
            return self.cli.backend_client is self.client and self.client.continuation_identity() == self.identity
        except Exception:
            return False

    def _delivery_id(self, job_id: str) -> str:
        """Namespace durable history idempotency by authenticated backend and original job."""
        return hashlib.sha256((self.identity + "\0" + job_id).encode("ascii")).hexdigest()

    def _sync_usage(self) -> None:
        """Hydrate or reconcile already-committed usage without charging a recovered turn twice."""
        for row in self.cli.memory.get_recovered_usage():
            self.cli.rate_limiter.record_recovered_request(
                row["delivery_id"], row["tokens"], row["cost"], row["created_at"],
            )

    def restore(self) -> list[dict]:
        """Restore matching protected work across process IDs while retaining its original question."""
        records = self.store.load()
        with self.cli._conversation_state_lock():
            active = {record["job_id"] for record in records}
            for retired in self._protected_jobs - active:
                self.cli._pending_backend_conversations.pop(retired, None)
            for record in records:
                self.cli._restore_backend_conversation(
                    record["question"], BackendChatContinuation(
                        record["job_id"], record["job_read_token"], record.get("expires_at"),
                    ), record["session_id"],
                )
            self._sync_usage()
            self._protected_jobs = active
        return records

    def retain(self, question: str, handle: BackendChatContinuation, session_id: str) -> None:
        """Encrypt accepted coordinates before declaring automatic restart recovery available."""
        if not self._identity_matches():
            raise ContinuationStorageError("Authenticated backend recovery is unavailable.")
        if self.contains(handle.job_id):
            return
        self.store.add({
            "job_id": handle.job_id, "job_read_token": handle.job_read_token,
            "question": question, "session_id": session_id, "created_at": time.time(),
            "expires_at": handle.expires_at, "state": "pending",
            "accounted": False, "audit_recorded": False,
        })
        self._protected_jobs.add(handle.job_id)
        self.wakeup.set()

    def contains(self, job_id: str) -> bool:
        """Report only whether this accepted job has protected restart coordinates."""
        if job_id in self._protected_jobs:
            return True
        try:
            return any(row["job_id"] == job_id for row in self.store.load())
        except Exception:
            return False

    def start(self) -> None:
        """Start only the read-only recovery worker; action and daemon polling are separate."""
        if self.thread is None or not self.thread.is_alive():
            self.stop_event.clear()
            self.thread = threading.Thread(target=self._run, name="conversation-recovery", daemon=True)
            self.thread.start()

    def stop(self) -> None:
        """Interrupt backoff and prevent delivery after shutdown without discarding pending work."""
        self.stop_event.set()
        self.wakeup.set()
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(timeout=3)

    def _run(self) -> None:
        """Hold one OS-released leader claim so two CLI processes never run duplicate monitors."""
        while not self.stop_event.is_set():
            try:
                with self.store.claim("__monitor__") as leader:
                    if leader:
                        while not self.stop_event.is_set():
                            self.tick()
                            self.wakeup.wait(1)
                            self.wakeup.clear()
                    else:
                        self.restore()
            except Exception:
                self._notice("storage", "Automatic conversation recovery is waiting for protected storage.")
            self.stop_event.wait(1)

    def _notice(self, key: str, text: str) -> None:
        """Report a state change once without reflecting credentials or untrusted error bodies."""
        if self.notices.get(key) != text and not self.stop_event.is_set():
            self.notices[key] = text
            self.cli.console.print(text, markup=False)

    def tick(self) -> None:
        """Make sequential bounded reads only for due accepted records; expiry remains server-owned."""
        if not self._identity_matches():
            self._notice("identity", "Conversation recovery paused: the authenticated backend identity changed.")
            return
        records = self.restore()
        active = {record["job_id"] for record in records}
        self.schedule = {key: value for key, value in self.schedule.items() if key in active}
        self.notices = {key: value for key, value in self.notices.items() if key in active or key in ("storage", "identity")}
        for record in records:
            if self.stop_event.is_set():
                return
            job_id = record["job_id"]
            if self.clock() >= self.schedule.get(job_id, (0, 0))[0]:
                try:
                    self.recover(job_id)
                except Exception:
                    self._backoff(job_id, transient=True)
                    self._notice(job_id, "Conversation recovery is waiting for safe delivery or storage.")

    def _backoff(self, job_id: str, *, transient: bool) -> None:
        """Bound polling to one worker with per-job exponential waits capped at 30/60 seconds."""
        attempts = min(self.schedule.get(job_id, (0, 0))[1] + 1, 7)
        delay = min(60 if transient else 30, 2 ** (attempts - 1))
        self.schedule[job_id] = (self.clock() + delay, attempts)

    def resume(self, args: str) -> None:
        """Keep manual diagnostics as a single same-job read serialized with automatic delivery."""
        if not args.strip():
            jobs = ", ".join(record["job_id"] for record in self.store.load())
            self.cli.console.print(f"Pending conversations: {jobs or 'none'}.", markup=False)
            return
        self.recover(args.strip(), manual=True)

    def recover(self, job_id: str, *, manual: bool = False) -> None:
        """Claim one accepted job before any request or delivery; never treat an arbitrary ID as work."""
        if not self._identity_matches() or self.stop_event.is_set():
            return
        with self.store.claim(job_id) as claimed:
            if not claimed:
                return
            record = next((row for row in self.store.load() if row["job_id"] == job_id), None)
            if record is None:
                return
            delivery_id = self._delivery_id(job_id)
            completed = self.cli.memory.get_recovered_conversation(delivery_id)
            if completed is None:
                response = self.reader.request_chat_job_result(BackendChatContinuation(
                    job_id, record["job_read_token"], record.get("expires_at"),
                ))
                if self.stop_event.is_set() or not self._identity_matches():
                    return
                if not response.ok or response.value is None:
                    error = response.error
                    terminal = error and (
                        error.kind in ("failed", "cancelled", "expired", "unavailable", "validation")
                        or error.status_code in (401, 403)
                    )
                    if terminal:
                        self._terminal(record, error.message)
                    else:
                        if error and error.continuation and error.continuation.expires_at is not None:
                            self.store.update(job_id, expires_at=error.continuation.expires_at)
                        self._backoff(job_id, transient=not error or error.kind != "pending")
                        if manual or (error and error.kind != "pending"):
                            self._notice(job_id, "Conversation recovery is waiting for the original job or backend.")
                    return
                value = response.value
                approved, show = translate(
                    record["question"], value.response_text, source="backend", presentation=value.presentation,
                )
                with self.cli._conversation_state_lock():
                    if self.stop_event.is_set() or not self._identity_matches():
                        return
                    self.cli.memory.record_recovered_conversation(
                        delivery_id, record["session_id"], record["question"], approved if show else "",
                        value.tokens_used, value.cost_usd,
                    )
                    self._sync_usage()
                self.store.update(job_id, state="recorded", accounted=True,
                                  expires_at=value.continuation_expires_at or record.get("expires_at"))
                completed = self.cli.memory.get_recovered_conversation(delivery_id)
            self._deliver(record, delivery_id, completed)

    def _deliver(self, record: dict, delivery_id: str, completed: dict) -> None:
        """Persist before display and acknowledge afterward; a crash in that gap may repeat only display."""
        if self.stop_event.is_set() or not self._identity_matches():
            return
        with self.cli._conversation_state_lock():
            if self.stop_event.is_set() or not self._identity_matches():
                return
            if not completed["displayed"]:
                if completed["ai"]:
                    label = redact_output(record["question"], apply_truncation=False).replace("\n", " ")[:160]
                    self.cli.console.print(f"Answer for: {label}", markup=False)
                    ui_ops.speak_to_user(
                        self.cli, completed["ai"], persona=resolve_persona(self.cli),
                        user_text=record["question"], memory=self.cli.memory, filtered_text=completed["ai"],
                    )
                    self.cli._last_response = completed["ai"]
                else:
                    self.cli._last_response = None
                    self.cli.console.print("The completed answer was withheld by output validation.", markup=False)
                self.cli.memory.mark_recovered_displayed(delivery_id)
            state.recompute_trust_state(self.cli)
            if self.cli.memory.claim_recovered_audit(delivery_id):
                audit_record("execute_success" if completed["ai"] else "execute_failed",
                             command="conversation_recovery", source="backend", job_id=record["job_id"],
                             conversation_id=hashlib.sha256(record["session_id"].encode()).hexdigest(),
                             trust=self.cli._trust_state.name)
            self.store.remove(record["job_id"])
            self.cli._pending_backend_conversations.pop(record["job_id"], None)
            self.schedule.pop(record["job_id"], None)
            self.notices.pop(record["job_id"], None)

    def _terminal(self, record: dict, message: str) -> None:
        """Retire an authoritative terminal failure without inventing an answer or new generation."""
        with self.cli._conversation_state_lock():
            if self.stop_event.is_set() or not self._identity_matches():
                return
            self.cli.console.print(redact_output(message), markup=False)
            state.recompute_trust_state(self.cli)
            audit_record("execute_failed", command="conversation_recovery", source="backend",
                         job_id=record["job_id"], trust=self.cli._trust_state.name)
            self.store.remove(record["job_id"])
            self.cli._pending_backend_conversations.pop(record["job_id"], None)
