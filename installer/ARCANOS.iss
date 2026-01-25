; ARCANOS Inno Setup installer script
; Pass /DOutputDirName="path" to ISCC to override (e.g. %TEMP% to avoid AV locking installer\dist)

#ifndef OutputDirName
#define OutputDirName "dist"
#endif

#define AppName "ARCANOS"
#define AppVersion "1.0.1"
#define AppPublisher "ARCANOS"
#define AppExeName "ARCANOS.exe"

[Setup]
AppId={{9D72D1C8-0B6F-4F0D-9A22-AB6C6D402AB9}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir={#OutputDirName}
OutputBaseFilename=ARCANOS-Setup
Compression=lzma
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
SetupIconFile=..\daemon-python\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExeName}
WizardStyle=modern

[Files]
Source: "..\daemon-python\dist_new\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\daemon-python\assets\*"; DestDir: "{app}\assets"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\daemon-python\.env.example"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"
Name: "{commondesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\icon.ico"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
