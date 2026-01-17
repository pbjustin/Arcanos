<##
Purpose:
  Build a Windows executable for the TypeScript backend.
Inputs/Outputs:
  No inputs; outputs dist/arcanos-backend.exe.
Edge cases:
  Fails if Node, npm, or pkg are not installed.
##>

# //audit Assumption: npm and Node are available. Risk: missing dependencies. Invariant: build requires npm. Handling: rely on PowerShell error output.
$ErrorActionPreference = "Stop"

# //audit Assumption: dependencies are installed. Risk: missing node_modules. Invariant: npm install completed. Handling: instruct user to run npm install first.
Write-Host "[ARCANOS] Packaging backend for Windows..."

npm run package:win
