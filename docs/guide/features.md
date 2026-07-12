# Features

## Kubeconfig handling

- **Merge** — resolves `KUBECONFIG` env paths or `~/.kube/config`; multiple files merged, first file's `current-context` wins; duplicate context names from later files are skipped.
- **Auto-discovery** — scans `~/.kube/` for additional kubeconfig files (`kind: Config` marker) and merges them automatically.
- **Custom paths** — Settings lets you pin an explicit list of kubeconfig files instead.
- **Live reload** — CubeLite watches kubeconfig files on disk and reloads when they change (e.g. after `aws eks update-kubeconfig`).
- **Context switch** — persisted back to the kubeconfig file, exactly like `kubectl config use-context`. Only `current-context` is rewritten; the rest of your file is untouched.

## Security

- **Keychain-backed credentials** — bearer tokens are migrated into the OS keychain on load (keyed by cluster server URL) and stripped from memory; client certificates become `SecIdentity` entries. Reset anytime from Settings → Advanced.
- **Exec credential plugins** — `exec` blocks (EKS `aws eks get-token`, GKE `gke-gcloud-auth-plugin`, OIDC `kubelogin`, …) run exactly as kubectl runs them, with results cached until their expiration. Plugin binaries are resolved against your PATH plus common install locations (Homebrew, cloud SDKs).
- **No telemetry** — no analytics, no call-home, no accounts.
- **Secrets stay opaque** — the Secrets list shows names and key counts only; values are never fetched or displayed.

## Cluster views

- **All Clusters dashboard** — cross-cluster health: online / offline / RBAC-limited per context.
- **Resource lists** — Pods, Namespaces, Deployments, Services, Secrets, ConfigMaps, Ingresses, Nodes, Jobs, StatefulSets, CronJobs, PVCs, Helm releases (deduplicated to the latest revision).
- **Live pod updates** — Kubernetes watch stream (`?watch=true`) with debounced reloads.
- **RBAC-restricted clusters** — when namespace listing is forbidden, CubeLite falls back to your configured or default namespaces, and you can add namespaces manually.

## Pod operations

- **Logs** — live stream with follow; per-container.
- **Shell (exec)** — line-based interactive session over the Kubernetes WebSocket protocol (`v4.channel.k8s.io`).
- **Port forward** — local TCP listener bridged to the pod over the Kubernetes port-forward WebSocket; multiple simultaneous sessions with status per session.
- **Manifest view & edit** — full JSON manifest with apply (kubectl replace semantics).
- **Restart / Delete** — restart is a delete that lets the controller recreate the pod.

## Interface

- **Command palette** — ⌘K; jump to any context or view. ⌘1–⌘5 for the main views.
- **Menu bar extra** — quick context switch from the macOS status bar.
- **Logs & errors console** — every warning/error CubeLite itself produces, with suggested actions.
- **Light/dark** — follows the system or forced in Settings.
- **Launch at login** — optional.

## Platform notes

The macOS app (Swift 6 + SwiftUI, macOS 14+) is the reference implementation. The cross-platform desktop app (Tauri v2 + Svelte 5) shares the Rust core and is an early preview — expect a reduced feature set for now.

Next: [FAQ & Troubleshooting →](faq.md)
