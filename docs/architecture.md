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
        CL[KubeClient\nclient.rs]
        RM[Resource Models\nresources.rs\nPodInfo · NamespaceInfo · DeploymentInfo]
        CE[ConfigError\nerror.rs]
        KC --> CL
        CL --> RM
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
        KAS[KubeAPIService\nactor · URLSession]
        KES[KeychainService\nactor · Security.framework]
        CS[ClusterState\n@Observable @MainActor]
        MV[MainView\nNavigationSplitView]
        MB[MenuBarContextView\nMenuBarExtra]

        KS -->|parsed config| KAS
        KAS -->|resources| CS
        KS -->|contexts| CS
        KES -.-|credential store| KAS
        CS -->|state| MV
        CS -->|state| MB
    end

    U -->|read| KC
    U -->|read| KS
    CL -->|"HTTPS (kube-rs)"| API
    KAS -->|"HTTPS (URLSession)"| API
```

## Data Flow

### macOS app

1. `KubeconfigService.load()` resolves kubeconfig paths (env → `~/.kube/config`), merges multiple files, and returns parsed contexts and cluster endpoints.
2. `KubeAPIService` builds authenticated `URLRequest` objects (bearer token or custom CA trust) and issues requests to the K8s REST API.
3. Responses are mapped to Swift model types (`PodInfo`, `NamespaceInfo`, `DeploymentInfo`) and written to `ClusterState`.
4. `MainView` and `MenuBarContextView` observe `ClusterState` and re-render reactively.

### Desktop app (Tauri)

1. Svelte frontend calls a typed `invoke()` wrapper.
2. The Tauri command handler (Rust) calls into `cubelite-core` — loading the kubeconfig and using `KubeClient` to query the API.
3. Results are serialised as JSON and returned to the frontend.

## Component Reference

### `crates/cubelite-core` — Rust library

| Module | Responsibility |
|---|---|
| `kubeconfig.rs` | Parse YAML kubeconfig, merge multiple files, switch active context, write changes to disk |
| `client.rs` | `KubeClient` — async wrapper around kube-rs; lists pods, namespaces, and deployments |
| `resources.rs` | `PodInfo`, `NamespaceInfo`, `DeploymentInfo` — serde-serialisable API response models |
| `error.rs` | `ConfigError` enum (thiserror): FileNotFound, ParseError, ContextNotFound, MergeError, ClientError, Io |

### `apps/macos` — Swift 6 + SwiftUI

| File | Responsibility |
|---|---|
| `cubeliteApp.swift` | `@main` entry point; registers `WindowGroup` and `MenuBarExtra` |
| `Services/KubeconfigService.swift` | Actor: resolves paths, parses YAML (Yams), merges configs, persists context changes |
| `Services/KubeAPIService.swift` | Actor: URLSession → K8s REST API; bearer token auth; custom CA trust |
| `Services/KeychainService.swift` | Actor: store/retrieve/delete credentials (bearer tokens, client certs) via Security.framework |
| `Models/ClusterState.swift` | `@Observable @MainActor` state: contexts, currentContext, pods, namespaces, deployments |
| `Models/KubeContext.swift` | Value type representing a single kubeconfig context |
| `Models/ResourceModels.swift` | Pod, Namespace, Deployment model types mirroring K8s API JSON |
| `Models/CubeliteError.swift` | Swift error enum for all service failures |
| `Views/MainView.swift` | `NavigationSplitView` — sidebar context list, detail pane, toolbar |
| `Views/MenuBarContextView.swift` | `MenuBarExtra` dropdown — active context header, quick-switch rows |

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
- Kubernetes Secrets are masked in the UI by default (M2+)
