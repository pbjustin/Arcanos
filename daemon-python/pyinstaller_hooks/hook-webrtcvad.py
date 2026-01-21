"""
PyInstaller hook for webrtcvad packaged via wheels on Windows.
"""

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

# //audit assumption: collect helpers find webrtcvad modules; risk: missing VAD support; invariant: webrtcvad packaged; strategy: collect modules/data.
hiddenimports = collect_submodules("webrtcvad")
datas = collect_data_files("webrtcvad")
