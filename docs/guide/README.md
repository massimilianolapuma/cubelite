# CubeLite User Guide

CubeLite is a Kubernetes context aggregator: it reads your existing kubeconfig files and gives you a native window onto your clusters — no cloud account, no telemetry.

| Chapter | What it covers |
| --- | --- |
| [Installation](installation.md) | Download, install, and first launch on macOS, Linux, and Windows |
| [Quickstart](quickstart.md) | From zero to a working cluster view in five minutes |
| [Features](features.md) | Contexts, resources, logs, shell, port-forward, manifest editing |
| [FAQ & Troubleshooting](faq.md) | Gatekeeper warnings, RBAC limits, connection issues |

## Two apps, one core

- **CubeLite for macOS** — native Swift 6 + SwiftUI app with a menu-bar quick-switcher. The most complete experience today.
- **CubeLite Desktop** — cross-platform app (Tauri v2 + Svelte 5) for macOS, Linux, and Windows. Early preview.

Both read the same kubeconfig sources and never send your cluster data anywhere.

## Getting help

- [Open an issue](https://github.com/massimilianolapuma/cubelite/issues) for bugs and feature requests
- [CHANGELOG](https://github.com/massimilianolapuma/cubelite/blob/main/CHANGELOG.md) for what's new in each release
