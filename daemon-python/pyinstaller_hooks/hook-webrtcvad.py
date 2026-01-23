# Custom PyInstaller hook for webrtcvad
# This hook prevents PyInstaller from trying to process webrtcvad metadata
# when the package is not installed (webrtcvad-wheels is used on Windows instead)

# Empty hook - webrtcvad is optional and handled gracefully in code
# No metadata collection needed since the package may not be installed

datas = []
hiddenimports = []
binaries = []
