<##
Purpose:
  Build Windows executables for the Python daemon and CLI.
Inputs/Outputs:
  No inputs; outputs dist/daemon.exe and dist/cli.exe.
Edge cases:
  Fails if Python or PyInstaller is not installed.
##>

# //audit Assumption: Python and PyInstaller are installed. Risk: missing binaries. Invariant: pyinstaller command exists. Handling: rely on PowerShell error output.
$ErrorActionPreference = "Stop"

Write-Host "[ARCANOS] Packaging daemon for Windows..."

# //audit Assumption: build path is writable. Risk: file permission errors. Invariant: dist directory created. Handling: let pyinstaller fail visibly.
pyinstaller --onefile --distpath dist --name daemon daemon.py
pyinstaller --onefile --distpath dist --name cli cli.py
