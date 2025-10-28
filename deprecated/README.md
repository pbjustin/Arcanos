# Deprecated Code Archive

This directory contains code that has been marked for removal through the CREPID (Code Review, Elimination, Pruning, Iteration, Deployment) process.

## Purge Modes

- `CREPID_PURGE=off` (default): No code is moved or deleted
- `CREPID_PURGE=soft`: Legacy code is moved to `/deprecated/` with audit trail
- `CREPID_PURGE=hard`: Code is permanently deleted (use with caution in staging only)

## Structure

```
deprecated/
  ├── audit/          # Audit trails for removed code
  ├── modules/        # Deprecated modules
  ├── scripts/        # Deprecated scripts
  └── utils/          # Deprecated utilities
```

## Audit Trail

Each deprecated item has an audit record in `audit/` with:
- Module path and import weight
- Last commit date
- Removal risk assessment
- Dependencies affected

## Recovery

To recover deprecated code in `soft` mode:
1. Copy the file back to its original location
2. Update imports in dependent files
3. Run tests to ensure functionality
4. Set `CREPID_PURGE=off` to prevent re-removal
