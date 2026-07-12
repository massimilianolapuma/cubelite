# Installation

Every release publishes ready-to-install artifacts on the [GitHub Releases page](https://github.com/massimilianolapuma/cubelite/releases/latest). The links below always point at the newest version.

## macOS (native app)

Requires macOS 14 Sonoma or later.

1. Download [`CubeLite-macOS.dmg`](https://github.com/massimilianolapuma/cubelite/releases/latest/download/CubeLite-macOS.dmg) (or the [zip](https://github.com/massimilianolapuma/cubelite/releases/latest/download/CubeLite-macOS.zip)).
2. Open the DMG and drag **CubeLite** into **Applications**.
3. First launch: CubeLite is not yet signed or notarized, so macOS Gatekeeper blocks it with **"CubeLite is damaged and can't be opened. You should eject the disk image."** The app is not actually damaged — this is what recent macOS versions say about unsigned downloads, and the right-click → Open trick does *not* help here. Clear the quarantine flag instead:

   ```sh
   xattr -dr com.apple.quarantine /Applications/cubelite.app
   ```

   Signed and notarized builds are planned — see [issue #121](https://github.com/massimilianolapuma/cubelite/issues/121).

4. CubeLite reads `~/.kube/config` (and any kubeconfig files it discovers in `~/.kube/`). No further setup.

## Desktop app (cross-platform, early preview)

| Platform | Download |
| --- | --- |
| macOS | [`CubeLite-Desktop-macOS.dmg`](https://github.com/massimilianolapuma/cubelite/releases/latest/download/CubeLite-Desktop-macOS.dmg) |
| Linux (AppImage) | [`CubeLite-Desktop-Linux.AppImage`](https://github.com/massimilianolapuma/cubelite/releases/latest/download/CubeLite-Desktop-Linux.AppImage) |
| Linux (Debian/Ubuntu) | [`CubeLite-Desktop-Linux.deb`](https://github.com/massimilianolapuma/cubelite/releases/latest/download/CubeLite-Desktop-Linux.deb) |
| Windows | [`CubeLite-Desktop-Windows.msi`](https://github.com/massimilianolapuma/cubelite/releases/latest/download/CubeLite-Desktop-Windows.msi) |

macOS: same Gatekeeper "damaged" warning as the native app — after dragging to Applications run `xattr -dr com.apple.quarantine /Applications/CubeLite.app`.
Linux AppImage: make it executable first (`chmod +x CubeLite-Desktop-Linux.AppImage`).
Windows: SmartScreen may warn about an unsigned installer — choose **More info → Run anyway**.

## Building from source

See the [repository README](https://github.com/massimilianolapuma/cubelite#readme) for toolchain prerequisites (Rust 1.82+, Xcode 16+, Node 20+, pnpm 9+) and build commands.

Next: [Quickstart →](quickstart.md)
