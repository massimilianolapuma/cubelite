# Quickstart

Five minutes from install to a live cluster view. This walkthrough uses the macOS app; the desktop app follows the same flow.

## 1. Launch and onboarding

On first launch CubeLite shows a short onboarding screen and looks for kubeconfig files:

- the `KUBECONFIG` environment variable, if set (colon-separated paths, all merged)
- otherwise `~/.kube/config`, plus any other valid kubeconfig files found in `~/.kube/`

If you can run `kubectl get pods`, CubeLite will find the same clusters.

## 2. Pick a context

The sidebar lists every context from the merged kubeconfigs. The active context is highlighted. Click any context to browse it; use **Set active** to persist the switch to disk (same effect as `kubectl config use-context`).

Prefer the keyboard? **⌘K** opens the command palette — type a context or view name and hit return. **⌘1–⌘5** jump between the main views.

## 3. Browse resources

Select a namespace in the sidebar, then move through the resource tabs: Pods, Deployments, Services, Secrets, ConfigMaps, Ingresses, Nodes, Jobs, StatefulSets, CronJobs, PVCs, Helm releases. Pod lists update live via the Kubernetes watch API — no manual refresh.

The **All Clusters** dashboard aggregates health across every context: online, offline, or RBAC-limited, at a glance.

## 4. Work with a pod

Click a pod to open its detail panel:

- **Logs** — streamed live, with follow mode
- **Shell** — interactive shell session in the pod's first container
- **Describe** — full manifest; edit it and **Apply** (kubectl-replace semantics)
- **Port forward** — map a pod port to localhost
- **Restart / Delete** — with confirmation; controllers recreate restarted pods

## 5. Menu bar quick-switch

CubeLite also lives in the macOS menu bar: click the cube icon to see contexts and switch the active one without opening the main window.

## Credentials note

On first load CubeLite moves bearer tokens from your kubeconfig into the OS keychain (keyed by cluster server) and keeps them out of memory afterwards. Your kubeconfig file on disk is never modified by this. To re-import fresh tokens, use **Settings → Advanced → Reset stored credentials**.

Next: [Features →](features.md)
