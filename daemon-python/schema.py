"""JSON-backed memory store for daemon state."""

import json
import os
from typing import Any

MEMORY_FILE = "memory.json"


class Memory:
    """Read/write access to a JSON memory file."""

    def __init__(self, file_path: str = MEMORY_FILE) -> None:
        """
        Initialize the memory store.

        Purpose:
            Ensure the memory file exists and is ready to read/write.
        Inputs/Outputs:
            file_path: Path to the JSON file to use.
            Creates the file if it does not exist.
        Edge cases:
            If file_path points to a non-existent directory, an exception is raised.
        """

        self.file_path = file_path
        if not os.path.exists(self.file_path):
            # //audit Assumption: missing file should be created. Risk: permissions. Invariant: file exists after creation. Handling: create with {}.
            with open(self.file_path, "w", encoding="utf-8") as file:
                json.dump({}, file)

    def get(self, key: str) -> Any:
        """
        Read a value from memory by key.

        Purpose:
            Retrieve a stored value from the JSON file.
        Inputs/Outputs:
            key: The key to retrieve.
            Returns the stored value or None.
        Edge cases:
            If the key is missing, returns None.
        """

        with open(self.file_path, "r", encoding="utf-8") as file:
            data = json.load(file)
        # //audit Assumption: data is dict. Risk: file corruption. Invariant: mapping lookup. Handling: use dict.get.
        return data.get(key)

    def set(self, key: str, value: Any) -> None:
        """
        Persist a value into memory by key.

        Purpose:
            Update the JSON file with a key/value pair.
        Inputs/Outputs:
            key: The key to set.
            value: The value to store (JSON-serializable).
        Edge cases:
            If the file contains invalid JSON, json.load raises an error.
        """

        with open(self.file_path, "r", encoding="utf-8") as file:
            data = json.load(file)
        # //audit Assumption: data is dict. Risk: corruption. Invariant: data is mutable mapping. Handling: overwrite key.
        data[key] = value
        with open(self.file_path, "w", encoding="utf-8") as file:
            json.dump(data, file, indent=2)
