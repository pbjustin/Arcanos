"""
Validation reporting utilities for backend/CLI checks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time
from typing import Any, Dict, Optional

from .validation_constants import SECTION_DIVIDER_WIDTH


@dataclass
class ValidationReporter:
    """
    Purpose: Track validation results and provide formatted output.
    Inputs/Outputs: category/key/value/error entries; prints section headers.
    Edge cases: unknown categories are created on-demand.
    """

    results: Dict[str, Any] = field(default_factory=lambda: {
        "backend_connectivity": {},
        "cli_agent": {},
        "commands": {},
        "bugs": [],
        "verdict": "UNKNOWN",
    })

    def log_result(self, category: str, key: str, value: Any, error: Optional[str] = None) -> None:
        """
        Purpose: Append a structured result for the given category/key.
        Inputs/Outputs: category, key, value, optional error string.
        Edge cases: Creates a new category map if it does not exist.
        """
        if category not in self.results:
            # //audit assumption: category may be dynamic; risk: missing category map; invariant: category exists; strategy: initialize entry.
            self.results[category] = {}
        self.results[category][key] = {
            "value": value,
            "error": error,
            "timestamp": time.time(),
        }
        if error:
            # //audit assumption: errors should be tracked; risk: missing bug entry; invariant: error logged; strategy: append to bugs list.
            self.results["bugs"].append(f"{category}.{key}: {error}")

    def print_section_header(self, title: str) -> None:
        """
        Purpose: Print a standardized section divider with a title.
        Inputs/Outputs: title string; writes to stdout.
        Edge cases: title can be empty, but divider still prints.
        """
        divider = "=" * SECTION_DIVIDER_WIDTH
        print("\n" + divider)
        print(title)
        print(divider)
