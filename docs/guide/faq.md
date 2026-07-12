# FAQ & Troubleshooting

## Installation

**macOS says the app "cannot be opened because the developer cannot be verified".**
The builds are not notarized yet ([#121](https://github.com/massimilianolapuma/cubelite/issues/121)). Right-click the app → **Open** → **Open**, or run `xattr -dr com.apple.quarantine /Applications/cubelite.app`.

**Windows SmartScreen blocks the desktop installer.**
The installer is unsigned for now. **More info → Run anyway**.

**Which macOS versions are supported?**
macOS 14 Sonoma and later.

## Clusters & credentials

**CubeLite shows "no kubeconfig found".**
Check that `~/.kube/config` exists or `KUBECONFIG` is set. In Settings you can point CubeLite at explicit kubeconfig paths. If `kubectl` works in your terminal but CubeLite finds nothing, your `KUBECONFIG` is probably set only in your shell profile — launch CubeLite from that shell or configure the paths in Settings.

**A cluster shows as offline but kubectl reaches it.**
CubeLite talks to the API server directly. VPN-only clusters need the VPN up. Clusters using exec credential plugins (`kubelogin`, `aws eks get-token`, `gcloud`) are not supported yet — tracked in [#108](https://github.com/massimilianolapuma/cubelite/issues/108).

**"Your RBAC role cannot list namespaces."**
Normal on locked-down clusters. Set a default namespace (`kubectl config set-context <ctx> --namespace=<ns>`) or add namespaces manually in the sidebar; resource views then work within those namespaces.

**Certificate errors against self-signed clusters.**
Settings → **Skip TLS verification** disables certificate validation for all clusters. Use only for local/dev clusters you trust.

**Where are my tokens stored?**
In the OS keychain, keyed by cluster server URL, imported automatically on load. Your kubeconfig file is not modified. **Settings → Advanced → Reset stored credentials** deletes the stored copies; the next load re-imports from the file.

## Pods

**Logs or Shell button opens nothing.**
Fixed in the release following v0.3.0 — update to the latest version.

**Port forward says the local port is busy.**
Another process (or another CubeLite session) is listening on that port. Pick a different local port or stop the existing session from the pod detail panel.

## Data & privacy

**What does CubeLite send over the network?**
Only requests to your cluster API servers. Nothing else — no telemetry, no update pings (auto-update is planned and will be opt-in).

Still stuck? [Open an issue](https://github.com/massimilianolapuma/cubelite/issues/new) with the app version, macOS/OS version, and what the Logs & Errors console shows.
