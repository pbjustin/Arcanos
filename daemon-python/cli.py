"""Command-line interface for reading and writing daemon memory."""

import sys

from schema import Memory


def main(argv: list[str]) -> None:
    """
    Execute CLI commands for the memory store.

    Purpose:
        Provide read/write access to memory.json from the shell.
    Inputs/Outputs:
        argv: List of CLI arguments excluding the script name.
        Returns None; prints responses to stdout.
    Edge cases:
        When arguments are missing or invalid, prints usage and exits early.
    """

    if len(argv) < 1:
        # //audit Assumption: command is required. Risk: ambiguity. Invariant: argv contains command. Handling: print usage and return.
        print("Usage: cli.py <read|write> [key] [value]")
        return

    cmd = argv[0]
    memory = Memory()

    if cmd == "read" and len(argv) >= 2:
        # //audit Assumption: key provided. Risk: KeyError semantics in caller. Invariant: len(argv) >= 2. Handling: read by key.
        key = argv[1]
        print(memory.get(key))
        return

    if cmd == "write" and len(argv) >= 3:
        # //audit Assumption: key/value provided. Risk: missing value. Invariant: len(argv) >= 3. Handling: write value.
        key, value = argv[1], argv[2]
        memory.set(key, value)
        print(f"Set {key} -> {value}")
        return

    # //audit Assumption: command is invalid or incomplete. Risk: user confusion. Invariant: command not handled. Handling: print error.
    print("Unknown or incomplete command")


if __name__ == "__main__":
    main(sys.argv[1:])
