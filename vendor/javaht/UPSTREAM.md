# javaht Windows patch

This directory contains an unmodified copy of the Windows installer and the
Simplified/Traditional Chinese resources used by the optional built-in patch
mode.

- Upstream: https://github.com/javaht/claude-desktop-zh-cn
- Commit: `f23b0292646bdd912f759cec1096d9814ebb01ef`
- Installer: `scripts/install_windows.ps1`
- Installer SHA-256 after normalizing CRLF to LF:
  `5f844f1fc26006f28607290edb88a7247cfa8bc8b4ab1ccc08acebf167462f70`
- License: MIT, copyright (c) 2025 javaht. See `LICENSE`.

`run_plugin_patch.ps1` is the magpie wrapper added by this project. It requests
UAC elevation, runs the pinned installer with `install` or `uninstall`, or runs
the recovery path, and writes a small JSON result for the plugin process. The
plugin verifies the installer hash and requires all listed Chinese resource
files before enabling this mode.

Wrapper SHA-256 after normalizing CRLF to LF:
`4ca3211a2724a4961cafdc3c35aec160585174ca73477d0dd32daa6366c4e69f`

`recover_third_party.ps1` is a project-added recovery path. It restores
`app.asar`, `ion-dist.asar`, `Claude.exe` and the original `cowork-svc.exe`
from the installer's backup set, removes Chinese resources, and resets the
Claude locale to `en-US`. Recovery hash after normalizing CRLF to LF:
`3ec318a61e6ed0c4ac833a77c5b16e0577b58b8d0b6c082b029f28cd2881f552`

The bundled patch changes Claude application files and may invalidate the
application signature. Restore uses the patch's own `.zh-cn-backups` backup set.
