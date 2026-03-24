.PHONY: audit audit-fix audit-recursive audit-full help

help:
	@echo "ARCANOS Python Audit Commands:"
	@echo "  make audit           - Run audit once"
	@echo "  make audit-fix       - Run audit with auto-fix"
	@echo "  make audit-recursive - Run recursive audit until clean"
	@echo "  make audit-full      - Full audit with Railway checks"

audit:
	python scripts/continuous_audit.py

audit-fix:
	python scripts/continuous_audit.py --auto-fix

audit-recursive:
	python scripts/continuous_audit.py --recursive --auto-fix

audit-full:
	python scripts/continuous_audit.py --recursive --auto-fix --railway-check
