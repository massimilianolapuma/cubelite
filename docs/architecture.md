# CubeLite — Architecture

## Overview

CubeLite is a monorepo containing three independent layers. They share no runtime dependency on each other — the macOS app and the Rust core both speak directly to the Kubernetes API server, using their respective HTTP clients.

## Component Diagram

```mermaid
graph TB
    subgraph user["Developer"]
        U[/"~/.kube/config\n$KUBECONFIG"/]
    end

    subgraph k8s["Kubernetes Cluster"]
        API[(K8s API Server)]
    end

    subgraph core["crates/cubelite-core — Rust 1.82+"]
        KC[KubeConfig\nkubeconfig.rs]
        CTX[context.rs\nlist_contexts · set_active_context]
        CL[KubeClient\nclient.rs]
        RM[ResourceModels\nresources.rs\nPodInfo · NamespaceInfo · DeploymentInfo]
        TY[types.rs\nKubeConfigFile · NamedContext\nNamedCluster · NamedUser]
        WA[ResourceWatcher\nwatcher.rs · WatchEvent]
        CE[KubeconfigError · ContextError\nerror.rs]
        KC --> CTX
        KC --> CL
        CTX --> CL
        CL --> RM
        CL --> WA
        CE --> KC
        CE --> CL
    end

    subgraph desktop["apps/desktop — Tauri v2 + Svelte 5"]
        TC[Tauri Commands\nkubernetes.rs]
        FE[Svelte 5 Frontend\nshadcn-svelte · Tailwind v4]
        FE -->|invoke| TC
        TC --> core
    end

    subgraph macos["apps/macos — Swift 6 + SwiftUI"]
        KS[KubeconfigService\nactor]
        KAS[KubeAPIService\nactor · URLSession\nper-server session cache · TLS skip]
        KES[KeychainService\nactor · Security.framework]
        AS[AppSettings\n@Observable · UserDefaults]
        CS[ClusterState\n@Observable @MainActor]
        CCS[CrossClusterState\n@Observable @MainActor]
        LS[LogStore / LogEntry\n@Observable @MainActor]

        MV[MainView · MenuBarContextView\nDashboardView · CrossClusterDashboardView\nFirstLaunchView · PreferencesView · LogsView]
        RV[Resource Views\nNamespaceListView · PodListView\nDeploymentListView · DeploymentDetailView\nServiceListView · SecretListView\nConfigMapListView · IngressListView\nHelmReleaseListView · ErrorBannerView]
        HF[K8sFormatters\nHelper]

        KS -->|parsed config| KAS
        KAS -->|resources| CS
        KAS -->|snapshots| CCS
        KS -->|contexts| CS
        KES -.-|credential store| KAS
        AS -.->|settings| KAS
        CS -->|state| MV
        CS -->|state| RV
        CCS -->|state| MV
        LS -->|entries| MV
        HF -.-|formatting| RV
    end

    U -->|read| KC
    U -->|read| KS
    CL -->|"HTTPS (kube-rs)"| API
    KAS -->|"HTTPS (URLSession)"| API
```

## Data Flow

### macOS app

1. `KubeconfigService.load()` resolves kubeconfig paths (env → `~/.kube/config`), merges multiple files, and returns parsed contexts and cluster endpoints.
2. `KubeAPIService` builds authenticated `URLRequest` objects (bearer token or custom CA trust) and issues requests to the K8s REST API. Per-server `URLSession` instances are cached to avoid repeated TLS handshakes; the TLS-skip flag is managed in-memory and propagated via `updateSkipTLS(_:)`. URLSession delegate uses completion-handler variants (not async) for reliable challenge delivery.
3. Responses are mapped to Swift model types (`PodInfo`, `NamespaceInfo`, `DeploymentInfo`, `ServiceInfo`, `SecretInfo`, `ConfigMapInfo`, `IngressInfo`, `HelmReleaseInfo`) and written to `ClusterState`.
4. `MainView`, resource list views, and `MenuBarContextView` observe `ClusterState` and re-render reactively.
5. For the cross-cluster dashboard, `KubeAPIService.loadCrossClusterData()` spawns concurrent tasks per context and writes aggregated `ClusterHealthSnapshot` values into `CrossClusterState`.

### Desktop app (Tauri)

1. Svelte frontend calls a typed `invoke()` wrapper.
2. The Tauri command handler (Rust) calls into `cubelite-core` — loading the kubeconfig and using `KubeClient` to query the API.
3. Results are serialised as JSON and returned to the frontend.

## Component Reference

### `crates/cubelite-core` — Rust library

| Module | Responsibility |
|---|---|
| `kubeconfig.rs` | Parse YAML kubeconfig, merge multiple files, switch active context, write changes to disk |
| `context.rs` | `list_contexts`, `list_context_infos`, `current_context`, `set_active_context`, `context_exists` — high-level context API |
| `client.rs` | `KubeClient` — async wrapper around kube-rs; lists pods, namespaces, and deployments |
| `resources.rs` | `PodInfo`, `NamespaceInfo`, `DeploymentInfo` — serde-serialisable API response models |
| `types.rs` | `KubeConfigFile`, `NamedContext`, `NamedCluster`, `NamedUser`, `ContextDetails`, `ClusterDetails`, `ContextInfo` — domain types mirroring the kubeconfig spec |
| `watcher.rs` | `ResourceWatcher`, `WatchEvent`, `ResourceInfo`, `ResourceType` — kube-rs watch streaming over Pods, Namespaces, and Deployments |
| `error.rs` | `KubeconfigError` enum (FileNotFound, ParseError, MergeError, ClientError, Io, WatchError); `ContextError` enum (NotFound, Kubeconfig) |

### `apps/macos` — Swift 6 + SwiftUI

| File | Responsibility |
|---|---|
| `cubeliteApp.swift` | `@main` entry point; registers `WindowGroup` and `MenuBarExtra` |
| `Services/KubeconfigService.swift` | Actor: resolves paths, parses YAML (Yams), merges configs, persists context changes |
| `Services/KubeAPIService.swift` | Actor: per-server `URLSession` cache; bearer token + custom CA trust; TLS-skip flag managed in-memory; completion-handler URLSession delegates for reliable challenge delivery |
| `Services/KeychainService.swift` | Actor: store/retrieve/delete credentials (bearer tokens, client certs) via Security.framework |
| `Models/AppSettings.swift` | `@Observable @MainActor`: UserDefaults-backed settings — autoRefreshInterval, launchAtLogin, showSystemNamespaces, appearanceMode, menuBarIconStyle, kubeconfigPaths, apiTimeout, contextNamespaces, skipTLSVerification |
| `Models/ClusterState.swift` | `@Observable @MainActor` state: contexts, currentContext, pods, namespaces, deployments, services, secrets, configMaps, ingresses, helmReleases, selectedNamespace, isLoading, isLoadingResources, noConfig, errorMessage, resourceError, namespacePodCounts, clusterReachable, forbiddenResources |
| `Models/CrossClusterState.swift` | `@Observable @MainActor`: aggregated health snapshots (`ClusterHealthSnapshot`) across all contexts — totals for pods, deployments, services; online/offline/limited cluster counts |
| `Models/KubeContext.swift` | Value type representing a single kubeconfig context |
| `Models/ResourceModels.swift` | `PodInfo`, `NamespaceInfo`, `DeploymentInfo`, `DeploymentCondition`, `ServiceInfo`, `SecretInfo`, `ConfigMapInfo`, `IngressInfo`, `HelmReleaseInfo` — Swift model types mirroring K8s API JSON |
| `Models/CubeliteError.swift` | Swift error enum for all service failures |
| `Models/LogStore.swift` | `@Observable @MainActor`: ring-buffer (500 entries) of `LogEntry` values; tracks unread error count |
| `Models/LogEntry.swift` | `LogEntry` struct with severity (`error`/`warning`/`info`), source, message, details, suggestedAction; `LogSeverity` enum |
| `Views/MainView.swift` | `NavigationSplitView` — sidebar context list, detail pane, toolbar |
| `Views/MenuBarContextView.swift` | `MenuBarExtra` dropdown — active context header, quick-switch rows |
| `Views/DashboardView.swift` | Per-cluster resource summary dashboard |
| `Views/CrossClusterDashboardView.swift` | Aggregated health overview across all kubeconfig contexts |
| `Views/FirstLaunchView.swift` | Onboarding screen shown when no kubeconfig is found |
| `Views/PreferencesView.swift` | App settings panel (refresh interval, appearance, TLS, kubeconfig paths) |
| `Views/LogsView.swift` | Scrollable log viewer backed by `LogStore` |
| `Views/NamespaceListView.swift` | Namespace browser with pod-count badges |
| `Views/PodListView.swift` | Filterable pod list with status indicators |
| `Views/DeploymentListView.swift` | Deployment list with replica health summary |
| `Views/DeploymentDetailView.swift` | Detailed deployment view — conditions, selector, replica counts |
| `Views/ServiceListView.swift` | Kubernetes Services list |
| `Views/SecretListView.swift` | Kubernetes Secrets list (values masked by default) |
| `Views/ConfigMapListView.swift` | Kubernetes ConfigMaps list |
| `Views/IngressListView.swift` | Kubernetes Ingresses list |
| `Views/HelmReleaseListView.swift` | Helm releases detected via label selectors |
| `Views/ErrorBannerView.swift` | Inline error banner for transient resource fetch failures |
| `Views/ResourceDetailView.swift` | Generic resource detail overlay |
| `Helpers/K8sFormatters.swift` | Formatting utilities: age strings, status colours, byte/CPU formatting |

### `apps/desktop` — Tauri v2 + Svelte 5

| Path | Responsibility |
|---|---|
| `src-tauri/src/commands/kubernetes.rs` | Tauri commands: `list_pods`, `list_namespaces`, `list_deployments` |
| `src/routes/` | Svelte page routes |
| `src/lib/components/` | UI components (shadcn-svelte) |

## Technology Stack

| Area | Technology | Version |
|---|---|---|
| Rust core | Rust | 1.82+ |
| Rust core | kube-rs | 0.97 |
| Rust core | tokio | 1 |
| Rust core | thiserror | 2 |
| Rust core | anyhow | 1 |
| macOS | Swift | 6 |
| macOS | SwiftUI + Observation | macOS 14+ |
| macOS | Yams (YAML parsing) | SPM |
| Desktop | Tauri | v2 |
| Desktop | Svelte | 5 |
| Desktop | Tailwind CSS | v4 |
| Desktop | shadcn-svelte | latest |
| CI/CD | GitHub Actions | — |

## Security Model

- No plaintext secrets in code or config files
- Kubernetes credentials stored in the OS Keychain (Security.framework on macOS)
- macOS app reads kubeconfig from disk; no remote config fetching
- No telemetry, no analytics, no call-home of any kind
- Kubernetes Secrets are masked in the UI by default
