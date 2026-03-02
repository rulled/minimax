# minimax

Chrome extension for automating MiniMax text-to-speech workflows and organizing generated downloads.

## What it does

- Works on the MiniMax text-to-speech page
- Parses script files and helps assign speakers and voices
- Automates batch generation and download handling
- Renames and groups downloaded audio files into structured folders

## Install locally

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this repository folder

## Release

Build a clean release archive with:

```powershell
.\scripts\build-release.ps1
```

The resulting zip is created in `dist/` and can be attached to a GitHub release.
