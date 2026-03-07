#!/usr/bin/env python3
"""Catalog Python modules with AST metadata for refactor auditing."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

EMBEDDING_DIMENSION = 96
SEMANTIC_DUPLICATE_THRESHOLD = 0.96


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""

    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--files-json", required=True)
    return parser.parse_args()


def sha256_text(value: str) -> str:
    """Build a deterministic digest for normalized content."""

    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def build_embedding(tokens: Iterable[str]) -> List[float]:
    """Convert semantic tokens into a deterministic hashed embedding."""

    counts = Counter(token for token in tokens if token)
    vector = [0.0] * EMBEDDING_DIMENSION
    for token, weight in counts.items():
        digest = hashlib.sha256(str(token).encode("utf-8", errors="replace")).digest()
        slot = digest[0] % EMBEDDING_DIMENSION
        sign = 1.0 if digest[1] % 2 == 0 else -1.0
        vector[slot] += sign * float(weight)

    magnitude = math.sqrt(sum(value * value for value in vector))
    if magnitude == 0:
        return vector
    return [value / magnitude for value in vector]


def cosine_similarity(left: List[float], right: List[float]) -> float:
    """Compute cosine similarity for same-length vectors."""

    if not left or not right or len(left) != len(right):
        return 0.0
    dot_product = sum(a * b for a, b in zip(left, right))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot_product / (left_norm * right_norm)


def normalize_module(relative_path: str) -> str:
    """Translate a repository-relative path into a Python module path."""

    without_suffix = relative_path[:-3] if relative_path.endswith(".py") else relative_path
    module_name = without_suffix.replace("/", ".")
    return module_name[:-9] if module_name.endswith(".__init__") else module_name


def classify_module(relative_path: str) -> str:
    """Classify a Python module by its repository path."""

    if relative_path.startswith("daemon-python/tests/") or relative_path.startswith("tests/"):
        return "test"
    if "/scripts/" in f"/{relative_path}":
        return "tooling"
    if "/backend_client/" in f"/{relative_path}":
        return "api-layer"
    if "/utils/" in f"/{relative_path}":
        return "utility"
    if "/debug/" in f"/{relative_path}" or "/agentic/" in f"/{relative_path}" or "/openai/" in f"/{relative_path}":
        return "service"
    return "module"


class Normalizer(ast.NodeTransformer):
    """Normalize identifiers and literals so hashes reflect structure."""

    def visit_Name(self, node: ast.Name) -> ast.AST:  # noqa: N802
        return ast.copy_location(ast.Name(id="IDENT", ctx=node.ctx), node)

    def visit_arg(self, node: ast.arg) -> ast.AST:  # noqa: N802
        return ast.copy_location(ast.arg(arg="ARG", annotation=None, type_comment=None), node)

    def visit_Attribute(self, node: ast.Attribute) -> ast.AST:  # noqa: N802
        transformed = self.generic_visit(node)
        assert isinstance(transformed, ast.Attribute)
        transformed.attr = "ATTR"
        return transformed

    def visit_Constant(self, node: ast.Constant) -> ast.AST:  # noqa: N802
        if isinstance(node.value, str):
            return ast.copy_location(ast.Constant(value="STR"), node)
        if isinstance(node.value, (int, float, complex)):
            return ast.copy_location(ast.Constant(value=0), node)
        return node


def normalize_node(node: ast.AST) -> ast.AST:
    """Return a normalized copy of a function/class subtree."""

    return Normalizer().visit(ast.fix_missing_locations(ast.parse(ast.unparse(node))))


def build_exact_duplicate_hash(node: ast.AST) -> str:
    """Hash a function/class subtree while preserving literal and identifier semantics."""

    return sha256_text(ast.dump(node, include_attributes=False))


def resolve_call_name(node: ast.Call) -> Optional[str]:
    """Resolve a best-effort callee name for a Python call."""

    if isinstance(node.func, ast.Name):
        return node.func.id
    if isinstance(node.func, ast.Attribute):
        parts: List[str] = []
        current: ast.AST = node.func
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if isinstance(current, ast.Name):
            parts.append(current.id)
        parts.reverse()
        return ".".join(parts)
    return None


def extract_tokens(node: ast.AST) -> List[str]:
    """Extract identifier-like tokens for semantic similarity."""

    tokens: List[str] = []
    for current in ast.walk(node):
        if isinstance(current, ast.Name):
            tokens.append(current.id.lower())
        elif isinstance(current, ast.Attribute):
            tokens.append(current.attr.lower())
        elif isinstance(current, ast.Constant) and isinstance(current.value, str):
            tokens.extend(piece for piece in current.value.lower().split() if piece)
    return tokens


def resolve_import(
    current_relative_path: str,
    module_name: Optional[str],
    level: int,
    symbol_name: Optional[str],
    module_index: Dict[str, str],
) -> Optional[str]:
    """Resolve an import to another in-repo Python file when possible."""

    current_parts = normalize_module(current_relative_path).split(".")
    target_parts = current_parts[:-1]
    if level > 0:
        target_parts = target_parts[: max(0, len(target_parts) - (level - 1))]
    if module_name:
        target_parts.extend(module_name.split("."))

    candidates: List[str] = []
    if target_parts:
        candidates.append(".".join(target_parts))
    if symbol_name:
        candidates.append(".".join([*target_parts, symbol_name]))

    for candidate in candidates:
        if candidate in module_index:
            return module_index[candidate]
        init_candidate = f"{candidate}.__init__"
        if init_candidate in module_index:
            return module_index[init_candidate]
    return None


def catalog_file(relative_path: str, root: Path, module_index: Dict[str, str]) -> Dict[str, Any]:
    """Parse one Python file into architecture and duplicate metadata."""

    source_path = root / relative_path
    source_text = source_path.read_text(encoding="utf-8")
    module_name = normalize_module(relative_path)
    file_entry: Dict[str, Any] = {
        "language": "python",
        "path": relative_path,
        "moduleType": classify_module(relative_path),
        "moduleName": module_name,
        "docstring": None,
        "imports": [],
        "exports": [],
        "symbols": [],
        "callEdges": [],
        "errors": [],
        "lineCount": source_text.count("\n") + 1,
    }

    try:
        tree = ast.parse(source_text, filename=str(source_path))
    except SyntaxError as error:
        #audit Assumption: syntax errors should not abort the full audit; risk: partial graph output; invariant: the failing file remains visible in the report; handling: record the error and continue.
        file_entry["errors"].append(
            {
                "kind": "SyntaxError",
                "message": error.msg,
                "line": error.lineno,
                "offset": error.offset,
            }
        )
        return file_entry

    file_entry["docstring"] = ast.get_docstring(tree)
    local_symbols: Dict[str, str] = {}

    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                file_entry["imports"].append(
                    {
                        "kind": "import",
                        "module": alias.name,
                        "alias": alias.asname,
                        "resolvedPath": resolve_import(relative_path, alias.name, 0, None, module_index),
                    }
                )
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                file_entry["imports"].append(
                    {
                        "kind": "from",
                        "module": node.module,
                        "symbol": alias.name,
                        "alias": alias.asname,
                        "level": node.level,
                        "resolvedPath": resolve_import(
                            relative_path,
                            node.module,
                            node.level,
                            None if alias.name == "*" else alias.name,
                            module_index,
                        ),
                    }
                )

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbol_id = f"{relative_path}#{node.name}"
            local_symbols[node.name] = symbol_id
            if not node.name.startswith("_"):
                file_entry["exports"].append(node.name)

            normalized_node = normalize_node(node)
            control_flow = Counter(
                type(current).__name__
                for current in ast.walk(node)
                if isinstance(
                    current,
                    (
                        ast.If,
                        ast.For,
                        ast.AsyncFor,
                        ast.While,
                        ast.Try,
                        ast.Return,
                        ast.Raise,
                        ast.Match,
                    ),
                )
            )
            semantic_tokens = extract_tokens(node)
            file_entry["symbols"].append(
                {
                    "id": symbol_id,
                    "name": node.name,
                    "kind": "async_function" if isinstance(node, ast.AsyncFunctionDef) else "function",
                    "line": getattr(node, "lineno", None),
                    "endLine": getattr(node, "end_lineno", None),
                    "docstring": ast.get_docstring(node),
                    "signature": node.name,
                    "exactDuplicateHash": build_exact_duplicate_hash(node),
                    "structuralFingerprint": sha256_text(
                        json.dumps(
                            {
                                "kinds": [type(current).__name__ for current in ast.walk(normalized_node)],
                                "controlFlow": dict(sorted(control_flow.items())),
                            },
                            sort_keys=True,
                        )
                    ),
                    "semanticEmbedding": build_embedding([node.name.lower(), *semantic_tokens, *(ast.get_docstring(node) or "").lower().split()]),
                    "semanticTokens": semantic_tokens,
                }
            )

            for current in ast.walk(node):
                if not isinstance(current, ast.Call):
                    continue
                callee_name = resolve_call_name(current)
                if not callee_name:
                    continue
                file_entry["callEdges"].append(
                    {
                        "from": symbol_id,
                        "to": local_symbols.get(callee_name),
                        "callee": callee_name,
                        "line": getattr(current, "lineno", None),
                    }
                )
        elif isinstance(node, ast.ClassDef):
            symbol_id = f"{relative_path}#{node.name}"
            local_symbols[node.name] = symbol_id
            if not node.name.startswith("_"):
                file_entry["exports"].append(node.name)
            file_entry["symbols"].append(
                {
                    "id": symbol_id,
                    "name": node.name,
                    "kind": "class",
                    "line": getattr(node, "lineno", None),
                    "endLine": getattr(node, "end_lineno", None),
                    "docstring": ast.get_docstring(node),
                    "signature": node.name,
                    "methods": [
                        child.name
                        for child in node.body
                        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
                    ],
                }
            )

    file_entry["exports"] = sorted(set(file_entry["exports"]))
    return file_entry


def build_duplicates(symbols: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Cluster Python functions by exact, structural, and semantic similarity."""

    functions = [symbol for symbol in symbols if symbol["kind"] in {"function", "async_function"}]
    exact_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    structural_groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    for symbol in functions:
        exact_groups[symbol["exactDuplicateHash"]].append(symbol)
        structural_groups[symbol["structuralFingerprint"]].append(symbol)

    semantic_groups: List[Dict[str, Any]] = []
    visited: set[str] = set()
    for index, left_symbol in enumerate(functions):
        if left_symbol["id"] in visited:
            continue

        cluster = [left_symbol]
        for right_symbol in functions[index + 1 :]:
            if right_symbol["id"] in visited:
                continue
            similarity = cosine_similarity(left_symbol["semanticEmbedding"], right_symbol["semanticEmbedding"])
            if similarity >= SEMANTIC_DUPLICATE_THRESHOLD:
                cluster.append({**right_symbol, "score": round(similarity, 4)})

        if len(cluster) > 1:
            for symbol in cluster:
                visited.add(symbol["id"])
            semantic_groups.append(
                {
                    "clusterId": sha256_text("::".join(sorted(symbol["id"] for symbol in cluster)))[:16],
                    "language": "python",
                    "symbols": sorted(cluster, key=lambda symbol: symbol["id"]),
                }
            )

    return {
        "exact": [
            {
                "clusterId": duplicate_hash[:16],
                "language": "python",
                "symbols": sorted(group, key=lambda symbol: symbol["id"]),
            }
            for duplicate_hash, group in exact_groups.items()
            if len(group) > 1
        ],
        "structural": [
            {
                "clusterId": fingerprint[:16],
                "language": "python",
                "symbols": sorted(group, key=lambda symbol: symbol["id"]),
            }
            for fingerprint, group in structural_groups.items()
            if len(group) > 1
        ],
        "semantic": semantic_groups,
    }


def main() -> None:
    """Run the Python AST audit helper and write JSON to stdout."""

    args = parse_args()
    root = Path(args.root).resolve()
    files: List[str] = sorted(json.loads(args.files_json))
    module_index = {normalize_module(relative_path): relative_path for relative_path in files}
    module_index.update({f"{module_name}.__init__": relative_path for module_name, relative_path in list(module_index.items())})

    file_entries = [catalog_file(relative_path, root, module_index) for relative_path in files]
    symbol_entries = [symbol for file_entry in file_entries for symbol in file_entry["symbols"]]
    payload = {
        "language": "python",
        "files": file_entries,
        "duplicates": build_duplicates(symbol_entries),
    }
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
