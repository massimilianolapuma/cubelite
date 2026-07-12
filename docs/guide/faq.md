# FAQ & Troubleshooting

## Installation

**macOS says the app "is damaged and can't be opened. You should eject the disk image."**
It isn't damaged — this is Gatekeeper's message for unsigned downloads on recent macOS, and the right-click → Open trick does not bypass it. The builds are not signed/notarized yet ([#121](https://github.com/massimilianolapuma/cubelite/issues/121)). Drag the app to Applications, then clear the quarantine flag:

```sh
xattr -dr com.apple.quarantine /Applications/cubelite.app        # native app
xattr -dr com.apple.quarantine /Applications/CubeLite.app        # desktop app
```

**Windows SmartScreen blocks the desktop installer.**
The installer is unsigned for now. **More info → Run anyway**.

**Which macOS versions are supported?**
macOS 14 Sonoma and later.

## Clusters & credentials

**CubeLite shows "no kubeconfig found".**
Check that `~/.kube/config` exists or `KUBECONFIG` is set. In Settings you can point CubeLite at explicit kubeconfig paths. If `kubectl` works in your terminal but CubeLite finds nothing, your `KUBECONFIG` is probably set only in your shell profile — launch CubeLite from that shell or configure the paths in Settings.

**A cluster shows as offline but kubectl reaches it.**
CubeLite talks to the API server directly. VPN-only clusters need the VPN up. Clusters using exec credential plugins (`kubelogin`, `aws eks get-token`, `gke-gcloud-auth-plugin`) are supported: CubeLite runs the plugin exactly like kubectl does and caches the returned token until it expires. If the plugin binary isn't found, CubeLite shows which command is missing — install it or use an absolute path in the kubeconfig's `exec.command`. Legacy `auth-provider` blocks (pre-exec OIDC/GCP) are not supported; migrate them to an exec plugin.

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
