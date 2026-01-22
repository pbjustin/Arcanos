# -*- mode: python ; coding: utf-8 -*-

"""
PyInstaller spec file for ARCANOS
Build Windows executable with all dependencies.

Usage:
    pyinstaller arcanos.spec
"""

import sys
from pathlib import Path

block_cipher = None

# Base directory
base_dir = Path('.').absolute()

# Data files to include
datas = [
    ('.env.example', '.'),
    ('assets', 'assets'),
]

# Hidden imports (packages not auto-detected)
hiddenimports = [
    'openai',
    'requests',
    'dotenv',
    'cryptography',
    'tenacity',
    'sentry_sdk',
    'PIL',
    'pyautogui',
    'cv2',
    'speech_recognition',
    'pyaudio',
    'pyttsx3',
    'pynput',
    'webrtcvad',
    'win32com.client',
    'winshell',
    'pystray',
    'rich',
    'psycopg2',
]

# Analysis
a = Analysis(
    ['cli.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib',
        'numpy',
        'pandas',
        'scipy',
        'IPython',
        'notebook',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# PYZ (Python zip archive)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# EXE (Executable)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='ARCANOS',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # Keep console for terminal UI
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='assets/icon.ico' if Path('assets/icon.ico').exists() else None,
    version_file=None,
    uac_admin=False,  # Don't require admin
)
