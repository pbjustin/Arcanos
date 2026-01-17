"""Update manager for daemon memory synchronization."""

from schema import Memory


def build_audit_entry(last_entry: str) -> str:
    """
    Build a new audit log entry.

    Purpose:
        Generate a normalized audit entry string.
    Inputs/Outputs:
        last_entry: The most recent entry value to reference.
        Returns a formatted audit log string.
    Edge cases:
        Accepts "None" or empty strings and still returns a valid entry.
    """

    # //audit Assumption: last_entry is string-like. Risk: non-string input. Invariant: output is string. Handling: coerce via f-string.
    return f"Verified: {last_entry}"


class UpdateManager:
    """Coordinates updates to the memory audit log."""

    def __init__(self, memory: Memory | None = None) -> None:
        """
        Initialize the update manager.

        Purpose:
            Hold a Memory dependency for audit updates.
        Inputs/Outputs:
            memory: Optional Memory instance for dependency injection.
            Stores the memory reference on self.
        Edge cases:
            If memory is None, a new Memory instance is created.
        """

        # //audit Assumption: Memory is injectable. Risk: None. Invariant: self.memory is Memory. Handling: create Memory if None.
        self.memory = memory or Memory()

    def run_updates(self) -> None:
        """
        Run a single update cycle.

        Purpose:
            Append a verification entry to the audit log in memory.
        Inputs/Outputs:
            Reads from memory and writes updated audit_log list.
        Edge cases:
            Initializes audit_log when missing and defaults last_entry to "None".
        """

        audit_log = self.memory.get("audit_log") or []
        # //audit Assumption: audit_log is list-like. Risk: corrupted type. Invariant: list to append. Handling: default to empty list.
        last_entry = self.memory.get("last_entry") or "None"
        # //audit Assumption: last_entry may be missing. Risk: None. Invariant: string. Handling: default to "None".
        audit_log.append(build_audit_entry(str(last_entry)))
        self.memory.set("audit_log", audit_log)
        print("[DAEMON] Audit log updated.")
