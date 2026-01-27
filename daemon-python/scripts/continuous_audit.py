#!/usr/bin/env python3
"""
ARCANOS Continuous Audit Loop - Python CLI Daemon Quality Guardian
Purpose: Run recursive audits with auto-fix, Railway integration, and cloud-first enforcement.
"""

import os
import sys
import json
import subprocess
import hashlib
import re
from pathlib import Path
from typing import List, Dict, Any, Optional, Set, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta

# Constants
DEFAULT_ROOT = Path(__file__).parent.parent
LOG_DIR_NAME = 'logs'
STATE_FILE_NAME = 'continuous-audit-state.json'
LATEST_FILE_NAME = 'continuous-audit-latest.json'
REFACTORING_HISTORY_FILE = 'refactoring-history.json'
MAX_MODULE_LINES = 300
COMMENT_AGE_DAYS = 14
DEFAULT_MAX_DEPTH = 10

CODE_EXTENSIONS = {'.py'}
IGNORE_DIRS = {
    '.git', 'node_modules', 'dist', 'build', 'coverage', 'venv',
    '__pycache__', '.pytest_cache', '.vscode', 'npm_logs', 'logs', '.venv'
}

COMMENTED_CODE_PATTERN = re.compile(
    r'^\s*(?:#|//)\s*(if|for|while|return|const|let|var|class|function|def|import|from|export|try|catch|except|switch|case|break|continue|await|async|with)\b'
)

LEGACY_PATTERNS = [
    {'name': 'print statement', 'regex': re.compile(r'\bprint\s+'), 'fix': None},
    {'name': 'old-style class', 'regex': re.compile(r'class\s+\w+\s*[^\(:]'), 'fix': None},
    {'name': 'deprecated OpenAI pattern', 'regex': re.compile(r'Completion\.create'), 'fix': None},
]

AUDIT_COMMENT_PATTERN = re.compile(
    r'#\s*audit\s+assumption:\s*([^;]+);\s*risk:\s*([^;]+);\s*invariant:\s*([^;]+);\s*strategy:\s*(.+)'
)

UNUSED_IMPORT_PATTERNS = [
    re.compile(r'^import\s+(\w+)'),
    re.compile(r'^from\s+(\S+)\s+import'),
]


@dataclass
class Finding:
    """Represents an audit finding."""
    category: str
    file: str
    line: int
    message: str
    action: str
    consecutive_count: int = 0
    auto_remove_candidate: bool = False
    merge_touched: bool = False
    fix: Optional[callable] = None


def parse_workspace_args(args: List[str]) -> List[Path]:
    """Parse workspace list from argv or environment."""
    env_value = os.getenv('ARCANOS_AUDIT_WORKSPACES')
    workspace_index = None
    
    for i, arg in enumerate(args):
        if arg in ('--workspaces', '--workspace') and i + 1 < len(args):
            workspace_index = i + 1
            break
    
    if workspace_index is not None:
        raw = args[workspace_index]
    elif env_value:
        raw = env_value
    else:
        return [DEFAULT_ROOT]
    
    workspaces = [
        Path(p.strip()).resolve()
        for p in raw.split(';') if p.strip()
    ]
    
    if not workspaces:
        return [DEFAULT_ROOT]
    
    return workspaces


def parse_flags(args: List[str]) -> Dict[str, Any]:
    """Parse command line flags."""
    auto_fix = '--auto-fix' in args
    recursive = '--no-recursive' not in args
    max_depth = DEFAULT_MAX_DEPTH
    
    for arg in args:
        if arg.startswith('--max-depth='):
            try:
                max_depth = int(arg.split('=')[1])
            except (ValueError, IndexError):
                pass
    
    railway_check = '--no-railway-check' not in args
    rollback_on_failure = '--no-rollback' not in args
    
    return {
        'auto_fix': auto_fix,
        'recursive': recursive,
        'max_depth': max_depth,
        'railway_check': railway_check,
        'rollback_on_failure': rollback_on_failure
    }


def should_ignore_path(relative_path: Path) -> bool:
    """Determine if a path should be ignored."""
    parts = relative_path.parts
    return any(part in IGNORE_DIRS for part in parts)


def normalize_relative_path(relative_path: Path) -> str:
    """Normalize a relative path to POSIX separators."""
    normalized = str(relative_path).replace(os.sep, '/')
    if normalized.startswith('./'):
        return normalized[2:]
    return normalized


def collect_files(root: Path, extensions: Set[str]) -> List[Path]:
    """Collect files with matching extensions under a root."""
    files = []
    
    def walk(current_dir: Path):
        try:
            for entry in current_dir.iterdir():
                relative_path = entry.relative_to(root)
                
                if should_ignore_path(relative_path):
                    continue
                
                if entry.is_dir():
                    walk(entry)
                elif entry.is_file() and entry.suffix in extensions:
                    files.append(entry)
        except (PermissionError, OSError):
            pass
    
    walk(root)
    return files


def read_json_file(file_path: Path) -> Dict[str, Any]:
    """Read JSON from a file path."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return {'ok': True, 'data': json.load(f)}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def run_command(command: str, cwd: Path) -> Dict[str, Any]:
    """Run a shell command and capture output."""
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=300
        )
        return {
            'ok': result.returncode == 0,
            'output': result.stdout + result.stderr
        }
    except Exception as e:
        return {'ok': False, 'output': str(e)}


def scan_file(file_path: Path, root: Path) -> Dict[str, Any]:
    """Scan a file's content for signals."""
    relative_path = normalize_relative_path(file_path.relative_to(root))
    commented_lines = []
    legacy_matches = []
    audit_comments = []
    unused_imports = []
    line_count = 0
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            line_count = len(lines)
            
            for line_num, line in enumerate(lines, 1):
                # Check for commented code
                if COMMENTED_CODE_PATTERN.match(line):
                    commented_lines.append({
                        'file': relative_path,
                        'line': line_num,
                        'message': line.strip()
                    })
                
                # Check for legacy patterns
                for pattern in LEGACY_PATTERNS:
                    if pattern['regex'].search(line):
                        legacy_matches.append({
                            'file': relative_path,
                            'line': line_num,
                            'message': f"{pattern['name']} detected.",
                            'pattern': pattern['name'],
                            'fix': pattern['fix']
                        })
                
                # Check for audit comments
                audit_match = AUDIT_COMMENT_PATTERN.search(line)
                if audit_match:
                    audit_comments.append({
                        'file': relative_path,
                        'line': line_num,
                        'assumption': audit_match.group(1).strip(),
                        'risk': audit_match.group(2).strip(),
                        'invariant': audit_match.group(3).strip(),
                        'strategy': audit_match.group(4).strip()
                    })
                
                # Check for unused imports (simple heuristic)
                for import_pattern in UNUSED_IMPORT_PATTERNS:
                    if import_pattern.match(line.strip()):
                        # This is a simple check - real unused import detection needs AST
                        pass
        
        # Compute file hash
        hasher = hashlib.sha256()
        with open(file_path, 'rb') as f:
            for chunk in iter(lambda: f.read(4096), b''):
                hasher.update(chunk)
        file_hash = hasher.hexdigest()
        file_size = file_path.stat().st_size
        
        return {
            'ok': True,
            'relative_path': relative_path,
            'line_count': line_count,
            'commented_lines': commented_lines,
            'legacy_matches': legacy_matches,
            'audit_comments': audit_comments,
            'unused_imports': unused_imports,
            'hash': file_hash,
            'size_bytes': file_size
        }
    except Exception as e:
        return {
            'ok': False,
            'relative_path': relative_path,
            'error': str(e)
        }


def scan_files(root: Path, files: List[Path]) -> Dict[str, Any]:
    """Scan code files for content signals."""
    large_files = []
    commented_lines = []
    legacy_matches = []
    file_hashes = {}
    file_read_errors = []
    audit_comment_map = {}
    
    for file_path in files:
        scan_result = scan_file(file_path, root)
        
        if not scan_result['ok']:
            file_read_errors.append({
                'file': scan_result['relative_path'],
                'line': 1,
                'message': f"Failed to scan file: {scan_result.get('error', 'Unknown error')}"
            })
            continue
        
        relative_path = scan_result['relative_path']
        line_count = scan_result['line_count']
        
        if line_count > MAX_MODULE_LINES:
            large_files.append({
                'file': relative_path,
                'line': 1,
                'message': f'Module exceeds {MAX_MODULE_LINES} lines ({line_count}).'
            })
        
        commented_lines.extend(scan_result['commented_lines'])
        legacy_matches.extend(scan_result['legacy_matches'])
        
        if scan_result['audit_comments']:
            audit_comment_map[relative_path] = scan_result['audit_comments']
        
        # Track file hashes for duplicate detection
        file_hash = scan_result['hash']
        if file_hash not in file_hashes:
            file_hashes[file_hash] = []
        file_hashes[file_hash].append(relative_path)
    
    return {
        'large_files': large_files,
        'commented_lines': commented_lines,
        'legacy_matches': legacy_matches,
        'file_hashes': file_hashes,
        'file_read_errors': file_read_errors,
        'audit_comment_map': audit_comment_map
    }


def find_duplicate_files(file_hashes: Dict[str, List[str]]) -> List[Dict[str, Any]]:
    """Find duplicate files (simplified)."""
    duplicates = []
    for file_hash, files in file_hashes.items():
        if len(files) >= 2:
            duplicates.append({
                'hash': file_hash,
                'files': files
            })
    return duplicates


def get_line_age_days(root: Path, relative_file: str, line_number: int) -> Optional[float]:
    """Get line age in days via git blame."""
    command = f'git blame -L {line_number},{line_number} --date=short --porcelain -- "{relative_file}"'
    result = run_command(command, root)
    
    if not result['ok']:
        return None
    
    match = re.search(r'author-time (\d+)', result['output'])
    if not match:
        return None
    
    try:
        timestamp_seconds = int(match.group(1))
        age_ms = (datetime.now().timestamp() - timestamp_seconds) * 1000
        return age_ms / (1000 * 60 * 60 * 24)
    except (ValueError, TypeError):
        return None


def load_audit_state(state_path: Path) -> Dict[str, Any]:
    """Load audit state for a workspace."""
    read_result = read_json_file(state_path)
    
    if not read_result['ok']:
        return {
            'last_signatures': [],
            'counts': {},
            'unused_clean_streak': 0,
            'safe_versions': [],
            'rollback_history': []
        }
    
    data = read_result['data']
    return {
        'last_signatures': data.get('last_signatures', []),
        'counts': data.get('counts', {}),
        'unused_clean_streak': data.get('unused_clean_streak', 0),
        'safe_versions': data.get('safe_versions', []),
        'rollback_history': data.get('rollback_history', [])
    }


def save_audit_state(state_path: Path, state: Dict[str, Any]) -> None:
    """Save audit state to disk."""
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        with open(state_path, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2)
    except Exception:
        pass


def apply_consecutive_counts(previous_state: Dict[str, Any], findings: List[Finding]) -> Tuple[Dict[str, Any], List[Finding]]:
    """Update consecutive counts for findings."""
    previous_set = set(previous_state.get('last_signatures', []))
    next_counts = {}
    signatures = []
    
    for finding in findings:
        signature = f"{finding.category}|{finding.file}|{finding.line}|{finding.message}"
        signatures.append(signature)
        
        previous_count = previous_state.get('counts', {}).get(signature, 0)
        next_count = previous_count + 1 if signature in previous_set else 1
        next_counts[signature] = next_count
        
        finding.consecutive_count = next_count
        finding.auto_remove_candidate = finding.category == 'unused' and next_count >= 2
        
        if finding.auto_remove_candidate:
            finding.action = 'remove'
    
    next_state = {
        'last_signatures': signatures,
        'counts': next_counts,
        'unused_clean_streak': previous_state.get('unused_clean_streak', 0),
        'safe_versions': previous_state.get('safe_versions', []),
        'rollback_history': previous_state.get('rollback_history', [])
    }
    
    return next_state, findings


def create_git_checkpoint(workspace: Path) -> Optional[Dict[str, str]]:
    """Create git checkpoint before risky changes."""
    result = run_command('git rev-parse HEAD', workspace)
    if result['ok']:
        commit_hash = result['output'].strip()
        return {
            'commit_hash': commit_hash,
            'timestamp': datetime.now().isoformat(),
            'workspace': str(workspace)
        }
    return None


def rollback_to_checkpoint(checkpoint: Dict[str, str]) -> bool:
    """Rollback to git checkpoint."""
    if not checkpoint:
        return False
    workspace = Path(checkpoint['workspace'])
    result = run_command(f"git reset --hard {checkpoint['commit_hash']}", workspace)
    return result['ok']


def validate_changes(workspace: Path) -> Dict[str, Any]:
    """Validate changes after refactoring (black, flake8, mypy)."""
    black_result = run_command('black --check .', workspace)
    flake8_result = run_command('flake8 .', workspace)
    mypy_result = run_command('mypy .', workspace)
    
    # mypy is optional, don't fail if not configured
    passed = black_result['ok'] and flake8_result['ok']
    
    return {
        'passed': passed,
        'black': black_result['ok'],
        'flake8': flake8_result['ok'],
        'mypy': mypy_result['ok'] if mypy_result['ok'] else None,
        'errors': {
            'black': None if black_result['ok'] else black_result['output'],
            'flake8': None if flake8_result['ok'] else flake8_result['output'],
            'mypy': None if mypy_result['ok'] else mypy_result['output']
        }
    }


def tag_safe_version(workspace: Path, state_path: Path, state: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """Tag current version as safe."""
    result = run_command('git rev-parse HEAD', workspace)
    if result['ok']:
        commit_hash = result['output'].strip()
        safe_version = {
            'commit_hash': commit_hash,
            'timestamp': datetime.now().isoformat(),
            'status': 'CLEAN'
        }
        
        safe_versions = state.get('safe_versions', [])
        safe_versions.append(safe_version)
        
        # Keep only last 10 safe versions
        if len(safe_versions) > 10:
            safe_versions = safe_versions[-10:]
        
        state['safe_versions'] = safe_versions
        save_audit_state(state_path, state)
        return safe_version
    return None


def apply_auto_fixes(workspace: Path, findings: List[Finding]) -> List[Finding]:
    """Auto-fix findings (remove unused code, fix legacy patterns, remove commented code)."""
    fixes_applied = []
    files_to_fix = {}
    
    # Group findings by file
    for finding in findings:
        if finding.action == 'remove' and finding.auto_remove_candidate:
            if finding.file not in files_to_fix:
                files_to_fix[finding.file] = []
            files_to_fix[finding.file].append({'type': 'remove-unused', 'finding': finding})
        elif finding.action == 'remove' and finding.category == 'commented-out':
            if finding.file not in files_to_fix:
                files_to_fix[finding.file] = []
            files_to_fix[finding.file].append({'type': 'remove-comment', 'finding': finding})
        elif finding.action == 'refactor' and finding.category == 'legacy-pattern':
            if finding.file not in files_to_fix:
                files_to_fix[finding.file] = []
            files_to_fix[finding.file].append({'type': 'fix-legacy', 'finding': finding})
    
    # Apply fixes to each file
    for file_path_str, fixes in files_to_fix.items():
        full_path = workspace / file_path_str
        try:
            with open(full_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            modified = False
            # Sort fixes by line number (descending) to avoid line number shifts
            fixes.sort(key=lambda x: x['finding'].line, reverse=True)
            
            for fix in fixes:
                line_index = fix['finding'].line - 1
                if 0 <= line_index < len(lines):
                    if fix['type'] in ('remove-unused', 'remove-comment'):
                        lines.pop(line_index)
                        modified = True
                        fixes_applied.append(fix['finding'])
                    elif fix['type'] == 'fix-legacy' and fix['finding'].fix:
                        lines[line_index] = fix['finding'].fix(lines[line_index])
                        modified = True
                        fixes_applied.append(fix['finding'])
            
            if modified:
                with open(full_path, 'w', encoding='utf-8') as f:
                    f.writelines(lines)
        except Exception as e:
            print(f"Failed to fix {file_path_str}: {e}", file=sys.stderr)
    
    # Run black to format after fixes
    if fixes_applied:
        run_command('black .', workspace)
    
    return fixes_applied


def validate_railway_readiness(workspace: Path) -> Dict[str, Any]:
    """Validate Railway readiness."""
    findings = []
    
    # Check for local state files (cloud-first anti-pattern)
    code_files = collect_files(workspace, CODE_EXTENSIONS)
    for file_path in code_files:
        relative_path = normalize_relative_path(file_path.relative_to(workspace))
        if 'arcanos' in relative_path and not any(x in relative_path for x in ['test', '__pycache__']):
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    # Check for local file reads (anti-pattern)
                    if 'open(' in content and ('config' in content or 'state' in content):
                        if 'os.getenv' not in content and 'Config.' not in content:
                            findings.append(Finding(
                                category='cloud-first',
                                file=relative_path,
                                line=1,
                                message='Local file system state detected - use environment variables instead',
                                action='refactor'
                            ))
            except Exception:
                pass
    
    return {'passed': len(findings) == 0, 'findings': findings}


def validate_audit_comments(audit_comment_map: Dict[str, List], code_files: List[Path], root: Path) -> List[Finding]:
    """Validate audit comments."""
    findings = []
    
    # Check critical files for missing audit comments
    critical_files = [
        f for f in code_files
        if 'arcanos' in str(f) and 'test' not in str(f) and
        any(x in str(f) for x in ['cli', 'config', 'backend'])
    ]
    
    for file_path in critical_files:
        relative_path = normalize_relative_path(file_path.relative_to(root))
        if relative_path not in audit_comment_map:
            findings.append(Finding(
                category='audit-comment',
                file=relative_path,
                line=1,
                message='Missing audit comments in critical file',
                action='verify'
            ))
    
    return findings


def audit_workspace(root: Path) -> Dict[str, Any]:
    """Audit a workspace and return results."""
    log_dir = root / LOG_DIR_NAME
    state_path = log_dir / STATE_FILE_NAME
    latest_path = log_dir / LATEST_FILE_NAME
    
    log_dir.mkdir(parents=True, exist_ok=True)
    
    previous_state = load_audit_state(state_path)
    
    findings = []
    
    # Scan code files
    code_files = collect_files(root / 'arcanos', CODE_EXTENSIONS)
    scan_results = scan_files(root, code_files)
    
    for item in scan_results['file_read_errors']:
        findings.append(Finding(
            category='scan-error',
            file=item['file'],
            line=item['line'],
            message=item['message'],
            action='verify'
        ))
    
    for item in scan_results['large_files']:
        findings.append(Finding(
            category='large-module',
            file=item['file'],
            line=item['line'],
            message=item['message'],
            action='refactor'
        ))
    
    # Commented code older than threshold
    for item in scan_results['commented_lines']:
        age_days = get_line_age_days(root, item['file'], item['line'])
        if age_days is not None and age_days > COMMENT_AGE_DAYS:
            findings.append(Finding(
                category='commented-out',
                file=item['file'],
                line=item['line'],
                message=f"Commented-out code older than {COMMENT_AGE_DAYS} days: {item['message']}",
                action='remove'
            ))
    
    for item in scan_results['legacy_matches']:
        findings.append(Finding(
            category='legacy-pattern',
            file=item['file'],
            line=item['line'],
            message=item['message'],
            action='refactor',
            fix=item.get('fix')
        ))
    
    # Duplicate files
    duplicates = find_duplicate_files(scan_results['file_hashes'])
    for dup in duplicates:
        for file_path in dup['files']:
            findings.append(Finding(
                category='duplicate',
                file=file_path,
                line=1,
                message=f"Duplicate file content (hash {dup['hash']}) shared by {', '.join(dup['files'])}",
                action='verify'
            ))
    
    # Audit comment validation
    audit_comment_findings = validate_audit_comments(
        scan_results['audit_comment_map'],
        code_files,
        root
    )
    findings.extend(audit_comment_findings)
    
    # Apply consecutive counts
    updated_state, enriched_findings = apply_consecutive_counts(previous_state, findings)
    
    # Update unused clean streak
    unused_count = sum(1 for f in enriched_findings if f.category == 'unused')
    if unused_count == 0:
        updated_state['unused_clean_streak'] = previous_state.get('unused_clean_streak', 0) + 1
    else:
        updated_state['unused_clean_streak'] = 0
    
    save_audit_state(state_path, updated_state)
    
    # Validate with Python tools
    black_result = run_command('black --check .', root)
    flake8_result = run_command('flake8 .', root)
    lint_ok = black_result['ok'] and flake8_result['ok']
    
    unused_clean_ok = updated_state['unused_clean_streak'] >= 2
    clean = lint_ok and unused_clean_ok and len(enriched_findings) == 0
    
    status = 'CLEAN' if clean else 'NEEDS_ATTENTION'
    
    summary = {
        'total_findings': len(enriched_findings),
        'unused_findings': unused_count,
        'auto_remove_candidates': sum(1 for f in enriched_findings if f.auto_remove_candidate)
    }
    
    result = {
        'workspace': str(root),
        'timestamp': datetime.now().isoformat(),
        'summary': summary,
        'lint_ok': lint_ok,
        'unused_clean_ok': unused_clean_ok,
        'status': status,
        'findings': [asdict(f) for f in enriched_findings]
    }
    
    with open(latest_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)
    
    return result


def main():
    """Main entry point with recursive refactoring loop."""
    args = sys.argv[1:]
    workspaces = parse_workspace_args(args)
    flags = parse_flags(args)
    
    overall_status = 'CLEAN'
    depth = 0
    
    # Recursive refactoring loop
    while flags['recursive'] and depth < flags['max_depth']:
        # Check escape hatch
        escape_hatch_path = DEFAULT_ROOT / LOG_DIR_NAME / 'guardian.stop'
        if escape_hatch_path.exists():
            print('🛑 Escape hatch triggered - stopping')
            break
        
        cycle_results = []
        
        for workspace in workspaces:
            log_dir = workspace / LOG_DIR_NAME
            state_path = log_dir / STATE_FILE_NAME
            log_dir.mkdir(parents=True, exist_ok=True)
            
            result = audit_workspace(workspace)
            cycle_results.append(result)
            
            # Auto-fix if enabled and findings present
            if flags['auto_fix'] and result['status'] != 'CLEAN' and result['findings']:
                checkpoint = create_git_checkpoint(workspace)
                # Convert dict findings back to Finding objects for auto-fix
                findings_objs = []
                for f_dict in result['findings']:
                    finding = Finding(
                        category=f_dict.get('category', ''),
                        file=f_dict.get('file', ''),
                        line=f_dict.get('line', 0),
                        message=f_dict.get('message', ''),
                        action=f_dict.get('action', 'verify'),
                        consecutive_count=f_dict.get('consecutive_count', 0),
                        auto_remove_candidate=f_dict.get('auto_remove_candidate', False),
                        merge_touched=f_dict.get('merge_touched', False),
                        fix=f_dict.get('fix')
                    )
                    findings_objs.append(finding)
                fixes_applied = apply_auto_fixes(workspace, findings_objs)
                
                if fixes_applied:
                    print(f"🔧 Applied {len(fixes_applied)} auto-fixes")
                    
                    # Validate after fixes
                    validation = validate_changes(workspace)
                    
                    if not validation['passed']:
                        print('❌ Validation failed after auto-fixes, rolling back...')
                        if checkpoint:
                            rollback_to_checkpoint(checkpoint)
                        sys.exit(1)
                    
                    # Mark as safe version if clean
                    state = load_audit_state(state_path)
                    if validation['passed']:
                        tag_safe_version(workspace, state_path, state)
            
            # Railway validation if enabled
            if flags['railway_check']:
                railway_valid = validate_railway_readiness(workspace)
                if not railway_valid['passed']:
                    print('❌ Railway readiness validation failed')
                    if flags['rollback_on_failure']:
                        state = load_audit_state(state_path)
                        # Rollback logic would go here
                    sys.exit(1)
        
        any_needs_attention = any(r['status'] != 'CLEAN' for r in cycle_results)
        
        if any_needs_attention:
            overall_status = 'NEEDS_ATTENTION'
            depth += 1
            
            if flags['recursive']:
                print(f"🔄 Recursive iteration {depth}/{flags['max_depth']} - continuing until clean...")
                continue
        else:
            overall_status = 'CLEAN'
            break
    
    if depth >= flags['max_depth']:
        print(f"⚠️  Max depth ({flags['max_depth']}) reached - stopping recursion")
    
    print(f"STATUS: {overall_status}")
    sys.exit(0 if overall_status == 'CLEAN' else 1)


if __name__ == '__main__':
    main()
