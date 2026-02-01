# Pydantic 2.12.5 Bug Fix

## Issue

Pydantic 2.12.5 contains a bug that causes `NameError: name 'var' is not defined` when using OpenAI SDK 1.109.1+ with generic types.

### Error Details

```
File "pydantic/_internal/_generics.py", line 189, in iter_contained_typevars
    yield from iter_contained_typevars(var)
                                       ^^^
NameError: name 'var' is not defined
```

### Root Cause

The `iter_contained_typevars` function in two locations uses an undefined variable `var` instead of the loop variable `const`:

1. **pydantic/_internal/_generics.py** line 189 (v2 path)
2. **pydantic/v1/generics.py** line 352 (v1 compatibility path)

### Affected Code

```python
# Buggy code:
elif isinstance(v, (DictValues, list)):
    for const in v:
        yield from iter_contained_typevars(var)  # ❌ 'var' is not defined

# Fixed code:
elif isinstance(v, (DictValues, list)):
    for const in v:
        yield from iter_contained_typevars(const)  # ✅ Use loop variable
```

## Solution

A patch script is provided to automatically fix both locations:

```bash
python scripts/fix_pydantic_bug.py
```

The script:
- Locates the pydantic installation
- Applies the fix to both affected files
- Clears Python bytecode cache (`.pyc` files)
- Verifies the fix was applied

## Impact

- **Severity**: High - Breaks OpenAI SDK imports
- **Workaround**: Apply this patch script
- **Permanent Fix**: Wait for Pydantic to release a fixed version (2.13.0+)

## Testing

After applying the fix, verify it works:

```python
from openai import OpenAI
from openai.pagination import SyncPage
from openai.resources.beta.assistants import Assistants

# All imports should work without errors
client = OpenAI(api_key='test')
print("✅ All imports successful")
```

## References

- Pydantic version: 2.12.5
- OpenAI SDK version: 1.109.1+
- Python version: 3.11.7

## Notes

- This fix is temporary and will be lost if pydantic is reinstalled
- Consider pinning to a fixed pydantic version when available
- The fix has been tested and verified to work with OpenAI SDK 1.109.1
