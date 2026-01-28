#!/usr/bin/env python3
"""
Fix for Pydantic 2.12.5 bug: NameError: name 'var' is not defined

This script applies a patch to fix the bug in pydantic's _internal/_generics.py
and v1/generics.py where 'var' should be 'const' in iter_contained_typevars function.

Bug details:
- Location 1: pydantic/_internal/_generics.py line 189
- Location 2: pydantic/v1/generics.py line 352
- Issue: Uses undefined variable 'var' instead of loop variable 'const'
- Impact: Breaks OpenAI SDK 1.109.1+ imports when using generic types

This is a temporary fix until Pydantic releases a version with the fix.
"""

import os
import sys
import site


def find_pydantic_path():
    """Find the pydantic installation path."""
    for path in site.getsitepackages():
        pydantic_path = os.path.join(path, 'pydantic')
        if os.path.exists(pydantic_path):
            return pydantic_path
    
    # Try relative to current Python executable
    if hasattr(sys, 'real_prefix') or (hasattr(sys, 'base_prefix') and sys.base_prefix != sys.prefix):
        # In a virtual environment
        venv_lib = os.path.join(os.path.dirname(sys.executable), '..', 'Lib', 'site-packages', 'pydantic')
        if os.path.exists(venv_lib):
            return os.path.normpath(venv_lib)
    
    raise FileNotFoundError("Could not find pydantic installation")


def apply_fix(file_path, line_num, description):
    """Apply the fix to a specific file."""
    if not os.path.exists(file_path):
        print(f"⚠️  File not found: {file_path}")
        return False
    
    with open(file_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    if len(lines) < line_num:
        print(f"⚠️  File {file_path} has fewer than {line_num} lines")
        return False
    
    # Check if fix is already applied
    line_idx = line_num - 1
    if 'iter_contained_typevars(const)' in lines[line_idx]:
        print(f"✅ Fix already applied to {description}")
        return True
    
    # Check if bug exists
    if 'iter_contained_typevars(var)' not in lines[line_idx]:
        print(f"⚠️  Bug pattern not found in {description} at line {line_num}")
        return False
    
    # Apply fix
    lines[line_idx] = lines[line_idx].replace(
        'iter_contained_typevars(var)',
        'iter_contained_typevars(const)'
    )
    
    # Write back
    with open(file_path, 'w', encoding='utf-8') as f:
        f.writelines(lines)
    
    # Clear bytecode cache
    pyc_file = file_path.replace('.py', f'.cpython-{sys.version_info[0]}.pyc')
    if os.path.exists(pyc_file):
        try:
            os.remove(pyc_file)
            print(f"🗑️  Cleared bytecode cache: {os.path.basename(pyc_file)}")
        except Exception as e:
            print(f"⚠️  Could not remove bytecode cache: {e}")
    
    print(f"✅ Fixed {description}")
    return True


def main():
    """Main function to apply all fixes."""
    print("🔧 Applying Pydantic 2.12.5 bug fix...")
    print()
    
    try:
        pydantic_path = find_pydantic_path()
        print(f"📦 Found pydantic at: {pydantic_path}")
        print()
    except FileNotFoundError:
        print("❌ Error: Could not find pydantic installation")
        print("   Make sure pydantic is installed in your Python environment")
        sys.exit(1)
    
    fixes = [
        (
            os.path.join(pydantic_path, '_internal', '_generics.py'),
            189,
            "pydantic/_internal/_generics.py (v2 path)"
        ),
        (
            os.path.join(pydantic_path, 'v1', 'generics.py'),
            352,
            "pydantic/v1/generics.py (v1 compatibility path)"
        ),
    ]
    
    success_count = 0
    for file_path, line_num, description in fixes:
        if apply_fix(file_path, line_num, description):
            success_count += 1
    
    print()
    if success_count == len(fixes):
        print("✅ All fixes applied successfully!")
        print()
        print("💡 Note: This fix will be lost if you reinstall pydantic.")
        print("   Consider pinning to a fixed version when available.")
        return 0
    else:
        print(f"⚠️  Applied {success_count}/{len(fixes)} fixes")
        return 1


if __name__ == '__main__':
    sys.exit(main())
