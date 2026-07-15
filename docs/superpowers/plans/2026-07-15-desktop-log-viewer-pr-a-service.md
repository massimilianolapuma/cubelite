# Desktop Log Viewer — PR A (Service Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust + TS service layer for the desktop log panel (#295, parity with macOS #294): per-container log streams with previous/tail/sinceTime, per-pod container details (init/sidecar/state/restarts), scoped Tauri events with an end signal for frontend-driven reconnect.

**Architecture:** `cubelite-core::logs` gains `LogStreamOptions` + `stream_pod_logs_opts` (existing `stream_pod_logs` delegates) and a `LogLevel::Debug` bucket. New pure `pod_to_container_details` (unit-tested) + `KubeClient`-level fetch. Tauri command `stream_pod_log` emits `pod-log-line:{id}` per line and `pod-log-end:{id}` on stream end (reconnect/backoff lives in the frontend session store, matching the macOS split); `get_pod_containers` returns details. TS wrappers + types in `tauri.ts`.

**Tech Stack:** Rust (kube-rs `LogParams` already supports container/previous/tail_lines/since_time), Tauri 2 events, TypeScript.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-pod-log-viewer-design.md` (shared with macOS). `timestamps=true` always on the wire.
- Default tail 500. Existing aggregated `stream_logs`/`LogsView` untouched (separate feature).
- Repo gates: `cargo test -p cubelite-core`, `cargo clippy --deny warnings`, `pnpm --filter desktop lint`, `pnpm --filter desktop test`. No `any` in TS.
- Branch: `feat/295-desktop-log-viewer` off main.

---

### Task 1: core — `LogStreamOptions`, Debug level, options-aware stream

**Files:** modify `crates/cubelite-core/src/logs.rs` (+ re-exports in `lib.rs` if needed).

**Interfaces:**
```rust
#[derive(Debug, Clone, Default)]
pub struct LogStreamOptions {
    pub container: Option<String>,
    pub previous: bool,          // implies follow=false
    pub follow: bool,            // ignored (forced false) when previous
    pub tail_lines: i64,
    pub since_time: Option<String>, // RFC 3339; parsed, invalid values ignored
}
pub fn log_params(opts: &LogStreamOptions) -> LogParams   // pure, unit-tested
pub fn stream_pod_logs_opts(client, namespace, pod, opts) -> Pin<Box<dyn Stream<Item = LogLine> + Send>>
// stream_pod_logs(client, ns, pod, tail) delegates with follow=true defaults
```
`LogLevel` gains `Debug` (markers `DEBUG`, `TRACE`), serialized `"debug"`; detection order error > warn > debug > info.

**Tests (in-module):** `log_params` — defaults (follow+timestamps+tail500), previous forces follow=false + previous=true, container passthrough, since_time parsed to `Time`, invalid since_time → None; `detect_level` debug cases.

### Task 2: core — container details

**Files:** modify `crates/cubelite-core/src/resources.rs` (struct), `crates/cubelite-core/src/watcher.rs` or new fn beside `pod_to_info` (mapping), client fetch in `crates/cubelite-core/src/client.rs`.

**Interfaces:**
```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContainerDetail {
    pub name: String,
    pub init: bool,      // plain init container
    pub sidecar: bool,   // initContainer with restartPolicy: Always (K8s ≥1.28)
    pub restarts: i32,
    pub ready: bool,
    pub state: String,               // "running" | "waiting" | "terminated"
    pub state_reason: Option<String>,       // CrashLoopBackOff, Completed, …
    pub last_terminated_reason: Option<String>,
    pub last_terminated_at: Option<String>,
}
pub fn pod_to_container_details(pod: &Pod) -> Vec<ContainerDetail>  // pure; order: app, sidecars, plain init
impl KubeClient { pub async fn get_pod_containers(&self, namespace: &str, pod: &str) -> Result<Vec<ContainerDetail>, Error> }
```

**Tests:** construct a `Pod` with app container (waiting CrashLoopBackOff, restarts 7, lastState terminated OOMKilled), sidecar init (`restart_policy: Some("Always".into())`, running), plain init (terminated Completed) + matching `container_statuses`/`init_container_statuses`; assert order, flags, states, last-termination fields; missing-status container defaults (waiting, 0 restarts).

### Task 3: Tauri commands + TS wrappers

**Files:** modify `apps/desktop/src-tauri/src/commands/kubernetes.rs` (+ register in `main.rs`/`lib.rs` invoke_handler), `apps/desktop/src/lib/tauri.ts`.

**Interfaces (Rust):**
```rust
#[tauri::command] pub async fn stream_pod_log(
    app: AppHandle, kubeconfig_path: String, namespace: String, pod: String,
    container: Option<String>, previous: bool, tail_lines: Option<i64>,
    since_time: Option<String>, context: Option<String>,
) -> Result<String, String>   // stream_id; emits pod-log-line:{id} (LogLine), then pod-log-end:{id} (unit) when the stream ends
#[tauri::command] pub async fn get_pod_containers(
    kubeconfig_path: String, namespace: String, pod: String, context: Option<String>,
) -> Result<Vec<ContainerDetail>, String>
```
`stream_pod_log` registers its task in the existing `LogState` registry so `stop_logs(stream_id)` cancels it. Previous mode: non-follow stream, lines then end event.

**Interfaces (TS, `tauri.ts`):**
```typescript
export interface ContainerDetail { name: string; init: boolean; sidecar: boolean; restarts: number; ready: boolean; state: "running" | "waiting" | "terminated"; state_reason: string | null; last_terminated_reason: string | null; last_terminated_at: string | null }
export type PodLogLevel = "debug" | "info" | "warn" | "error";  // LogLine.level widened
export interface PodLogStreamOptions { container?: string; previous?: boolean; tailLines?: number; sinceTime?: string }
export async function streamPodLog(kubeconfigPath: string, namespace: string, pod: string, opts: PodLogStreamOptions, context?: string): Promise<string>
export async function getPodContainers(kubeconfigPath: string, namespace: string, pod: string, context?: string): Promise<ContainerDetail[]>
// stopLogs(streamId) reused for teardown
```

**Gates:** `cargo test -p cubelite-core` PASS, `cargo clippy --workspace --all-targets -- -D warnings` PASS, `cargo build -p cubelite-desktop` (tauri crate) PASS, `pnpm --filter desktop lint` + `test` PASS. Commit per task; push; PR base main titled `feat(desktop): log service layer — container-aware streams, previous logs (#295 PR A)`.
