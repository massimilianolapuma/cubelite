# Secret values stay in the backend until one is asked for — design (#661)

Status: draft for review, 2026-11-14.

## 1. Intent

Today opening the Secrets view, or the Overview (it counts Secrets by type), makes the backend send
every value of every Secret in the namespace to the webview, decoded. The mask is drawn by the
view over values it already holds.

After this change a value leaves the Rust backend only when the user asks for that one value, and
in the narrowest way that serves the request:

- **Reveal** sends one value to the webview, which shows it and drops it after a set time.
- **Copy** sends nothing to the webview: the backend reads the value and writes the clipboard.
- **Download .env** sends nothing to the webview: the backend reads the Secret and writes the file.

The limit, stated in the view's own words where it matters: a revealed value is in the webview
while it is shown. None of this protects against someone who can use the app with the user's
kubeconfig; it limits what is exposed to what was asked for, for as long as it is needed.

## 2. Goals, non-goals, anti-goals

**Goals**

- Listing Secrets (the list command and the watcher) carries key names and sizes, never values.
- One key can be revealed, or copied, without touching the others.
- A revealed value hides itself after a time set in Preferences, and on leaving the view.
- A copied value is removed from the clipboard after the same time, if it is still there.
- A Secret can be downloaded as a `.env` file after a warning that says what will be written.
- The YAML of a Secret is redacted in the backend, on both commands that can return one.
- Helm release Secrets are recognisable and their payload is not offered as a value.

**Non-goals**

- Editing a Secret's values.
- On-demand values for ConfigMaps (#668, it reuses the key rows built here).
- The values inside a Helm release (the Helm view does not send them today).
- Redacting other kinds that may embed credentials (a custom resource's YAML is shown as it is).
- Clipboard managers that ignore the "do not keep" mark (§6.2).

**Anti-goals** (it has failed if any of these is true, even with every test green)

- A value in a log line, an error message, a toast, or any persisted storage.
- A command through which the webview can make the backend write a value to a path it chooses.
- A revealed value that outlives the view, a namespace or cluster switch, or its timer.
- Copy that clears a clipboard the user has since filled with something else.

## 3. What the user sees

### 3.1 The list

The list keeps its shape: one row per Secret, its keys always visible under it (no drill-down).
What changes is inside the key rows, and the last column.

```
Secrets  12                               ( a value is read only when you reveal or copy it )

NAME                      NAMESPACE  TYPE                  DATA   AGE
api-credentials           shop       Opaque                   4   41d    [ .env ]
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ API_KEY          40 B      ••••••••                          [ Reveal ]  [ Copy ] │
  │ DB_PASSWORD      12 B      s3cr3t-p4ss!                      [ Hide ]    [ Copy ] │
  │ DB_USER           8 B      ••••••••                          [ Reveal ]  [ Copy ] │
  │ ca.crt          1.8 KiB    binary                                 [ Copy base64 ] │
  └───────────────────────────────────────────────────────────────────────────────────┘
registry-pull             shop       kubernetes.io/dockerconfigjson   1   90d    [ .env ]
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ .dockerconfigjson  312 B   ••••••••                          [ Reveal ]  [ Copy ] │
  └───────────────────────────────────────────────────────────────────────────────────┘
sh.helm.release.v1.api.v7 shop       helm.sh/release.v1       1    2d
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ release         48.2 KiB   Helm release payload, shown in Helm                    │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

- **Key row**: key name, size of the decoded value, the value area, the actions. Same sunken block
  as today (`bg-surface-sunken`, `type-data-sm`), one row per key, keys sorted by name.
- **Size** is the decoded length in bytes (`12 B`, `1.8 KiB`, `48.2 KiB`), muted, right-aligned in
  its column.
- **Value area, hidden**: a fixed `••••••••` (eight dots whatever the length), subtle text,
  hidden from assistive technology, with the word "hidden" for screen readers.
- **Value area, shown**: the value in the data face, wrapping (`break-all`), line breaks kept. More
  than 8 lines scroll inside the row. Text is selectable.
- **Reveal / Hide**: one text button per key (`Button` `variant="text"` `size="inline"`, the eye
  icons used today). It reads the value at that moment from the API server; while the request runs
  the button is disabled and reads "Reading…".
- **Copy**: one text button per key. It never needs Reveal first and does not reveal. After a copy
  the button reads "Copied" for 2 seconds.
- **Binary value** (not UTF-8): the value area reads "binary", there is no Reveal, and the copy
  button is "Copy base64".
- **Empty value** (0 B): the value area reads "empty", no actions.
- **Too large to show** (over 64 KiB of text): no Reveal, the value area reads "too large to show",
  Copy stays.
- **Helm release Secret** (`type: helm.sh/release.v1`): one line, "Helm release payload, shown in
  Helm", no actions, no `.env`.
- **`.env`** (a last column headed "Export"; the per-Secret Reveal column of today is removed in
  delivery 1 and this column comes with delivery 2, §9): a text button with the download icon,
  see §3.3.
- **The chip** in the toolbar changes from "values decoded on this machine only" to "a value is
  read only when you reveal or copy it", same warning-container chip.

Several keys can be shown at once, each with its own timer.

### 3.2 When a shown value goes away

A shown value is dropped from the webview's memory, not only covered, when:

- its timer ends (the time set in Preferences, counted from the reveal);
- the user presses Hide;
- the view is left, or the namespace or the cluster changes;
- a reload of the list shows that the Secret has changed (its resource version differs from the
  one the value was read at), or that the Secret or the key is gone.

An ordinary reload (auto-refresh) that finds the Secret unchanged leaves the value shown, with its
timer running.

An answer that arrives after its cause is gone (Hide pressed meanwhile, the view left, the
namespace or the cluster changed) is thrown away, never shown and never stored.

There is no countdown in the row.

### 3.3 Download as `.env`

Pressing **.env** opens a confirmation (`ui/Modal`) before anything is read:

```
┌ Download api-credentials as .env ───────────────────────────────────┐
│                                                                     │
│  3 values will be written to a file in plain text:                  │
│  API_KEY, DB_PASSWORD, DB_USER                                      │
│                                                                     │
│  1 key is left out:                                                 │
│  ca.crt (binary)                                                    │
│                                                                     │
│  ■ Anyone who can read the file can read these values.              │
│    CubeLite does not delete it.                                     │
│                                                                     │
│                              [ Cancel ]  [ Choose where to save… ]  │
└─────────────────────────────────────────────────────────────────────┘
```

- The numbers and the names come from what the list already holds (key names and the binary
  mark); no value is read to draw this.
- A key is left out when its value is binary, or when its name is not a valid variable name
  (`[A-Za-z_][A-Za-z0-9_]*`): `tls.crt`, `.dockerconfigjson`. Each is listed with its reason.
- Under the lists, one muted line: "Written for a shell: `set -a; . ./api-credentials.env`".
- The warning line uses the warning container, with a glyph as well as the colour.
- Focus starts on Cancel. "Choose where to save…" opens the system's save dialog, opened by the
  backend, with the name `<secret>.env` proposed.
- After the file is written, a toast: "3 values of api-credentials saved to
  `<path>`". Cancelling the system dialog writes nothing and says nothing.
- When no key can be written (all binary or badly named), the confirmation says so and has only
  Close.

### 3.4 Preferences

A new group **Secrets** in Preferences, after Connection, with one setting:

```
Secrets
Hide a shown value, and clear a copied one, after     ( 15 s | 30 s | 1 min | 5 min | Never )
```

`ui/SegmentedControl`, default **30 s**. "Never" leaves shown values until one of the other causes
of §3.2, and leaves the clipboard alone.

### 3.5 Errors, in the row

- The API server refuses the read (list allowed, get denied): "Not allowed to read this Secret
  (403)" in the value area, error tone, Reveal available again.
- The key or the Secret no longer exists: "No longer exists", and the list reloads.
- Any other failure: the message of the API error, never anything read from the Secret.

### 3.6 Keyboard and assistive technology

- Every action is a real button, reached in order: per key Reveal then Copy, then the next key;
  the Secret's `.env` button before its key rows.
- Button names carry the key: "Reveal DB_PASSWORD", "Hide DB_PASSWORD", "Copy DB_PASSWORD",
  "Copy ca.crt as base64", "Download api-credentials as .env".
- Reveal and Hide are the same button changing name: focus stays on it. When the timer hides a
  value, focus is not moved.
- One polite status region for the view announces: "DB_PASSWORD shown", "DB_PASSWORD hidden",
  "DB_PASSWORD copied, the clipboard is cleared in 30 seconds" (or "…copied" with Never). The value
  itself is never put in the status region.
- The new parts hold in forced colours and with more contrast, as the lists do; the boundary of
  the buttons against the sunken block is checked as non-text contrast, not only the text.

## 4. What crosses to the webview

| Command | Before | After |
|---|---|---|
| `list_secrets` | every value, decoded | per key: name, size, binary mark |
| watcher, kind `secret` | every value, decoded | the same shape as `list_secrets` |
| `get_resource_yaml` (secret) | `data` in base64 | redacted (§5.3) |
| `get_dynamic_resource_yaml` (any answer that is a Secret) | `data` in base64 | redacted (§5.3) |
| `apply_resource_yaml` (secret) | accepted | refused (§5.3) |
| `reveal_secret_value` (new) | – | one value, text only |
| `copy_secret_value` (new) | – | the format used (`text` or `base64`) |
| `export_secret_env` (new) | – | saved or not, the path, the key names written and left out |

The list still reads whole Secret objects from the API server into the backend's memory, where the
values are measured and dropped: key names and sizes are not available any other way. That is the
backend, on the user's machine, for the length of the call.

## 5. Core (`crates/cubelite-core`)

### 5.1 The list shape

```rust
pub struct SecretInfo {
    pub name: String,
    pub namespace: String,
    pub secret_type: Option<String>,
    /// One entry per key, sorted by key. Never the values.
    pub keys: Vec<SecretKeyInfo>,
    /// `type: helm.sh/release.v1`.
    pub helm_release: bool,
    /// Lets the view drop a shown value when the Secret changes.
    pub resource_version: Option<String>,
    pub creation_timestamp: Option<String>,
}

pub struct SecretKeyInfo {
    pub key: String,
    /// Length of the decoded value, in bytes.
    pub size: u64,
    /// The value is not valid UTF-8.
    pub binary: bool,
}
```

`data` is removed, not kept empty: nothing that compiles can still fill it.

### 5.2 Reading one value

- `KubeClient::secret_value(namespace, name, key)` gets the Secret and returns the one value as
  text or as bytes. Its type does not implement `Serialize`, and its `Debug` prints the kind and
  the length only, so it cannot be sent or logged by accident.
- The value comes back with the resource version of the Secret it was read from.
- The core's error type gains what is missing today to tell the cases apart: the Secret does not
  exist, the key does not exist, the value is not offered (Helm payload, binary, too large). A 403
  stays the API error it is. How they reach the view is in §6.4.
- A Helm release Secret is refused here too ("a Helm release payload is not a value"), so the rule
  does not depend on the view.

### 5.3 YAML

- A Secret rendered as YAML has every value under `data` and `stringData` replaced by
  `REDACTED (12 bytes)` (the decoded length), and the annotation
  `kubectl.kubernetes.io/last-applied-configuration` replaced by `REDACTED`: after a
  `kubectl apply` that annotation holds the whole Secret.
- It applies wherever a Secret can come out as YAML: `get_resource_yaml` for the secret type, and
  `get_dynamic_yaml`.
- In `get_dynamic_yaml` the rule looks at **what the API server answered**, not at what was asked:
  an object with `apiVersion: v1` and `kind: Secret` is redacted, and so is every item of a
  `SecretList`. The resource reference comes from the webview and its group, version and plural go
  into the request path as they are (`resource_path`, `dynamic.rs`), so a reference with a slash
  in its plural can reach a Secret under another name. For the same reason the three segments are
  now validated before any request (lowercase letters, digits, `-` and `.` only; no `/`), for
  every command that takes a resource reference.
- `apply_resource_yaml` for the secret type is refused in the core with a plain message: a
  redacted manifest cannot be applied back. No view offers either path for a Secret today.

### 5.4 The `.env` text

A pure function from a Secret to the file's text and the two lists of key names (written, left out
with the reason):

- One `KEY=value` line per written key, sorted by key, a final newline.
- First line a comment: `# <namespace>/<name>, exported by CubeLite <RFC 3339 time>`.
- The file is written for a shell (`set -a; . ./api-credentials.env`), with POSIX quoting, so
  every value comes back exactly as it is in the Secret. Other readers of `.env` files (Compose,
  the dotenv libraries) read the ordinary values the same way and may differ on values with
  quotes or several lines; the file does not try to suit them all, because no rule does.
- A value made only of `A-Z a-z 0-9 _ @ % + = : , . / -` is written bare. An empty value is
  written as `KEY=`.
- Any other value is written in single quotes, as it is, line breaks included; a `'` inside it is
  written as `'\''`.
- Left out: binary values, values that contain a NUL character (a shell cannot hold one), and
  keys that are not `[A-Za-z_][A-Za-z0-9_]*`. Helm release Secrets are refused whole.

## 6. Tauri (`apps/desktop/src-tauri`)

### 6.1 Reveal

`reveal_secret_value(kubeconfig_path, namespace, name, key, context)` answers with the value and
the resource version of the Secret it was read from. It refuses a binary value and a text over
64 KiB (the view does not offer Reveal for either; the backend does not rely on that).

### 6.2 Copy

`copy_secret_value(kubeconfig_path, namespace, name, key, clear_after_secs, context)` reads the
value and writes the system clipboard from Rust: text as it is, binary as base64. It answers with
the format used. The value does not cross to the webview.

- The clipboard is written with `arboard` (3.7 resolves today), without its default features (they
  bring image support) and with `wayland-data-control`, one instance kept in the app's managed
  state (on Linux the content lives as long as its owner). No clipboard permission is added to the
  webview's capabilities: the webview can neither read nor write the clipboard through the
  backend.
- The write carries the "do not keep" marks `arboard` has: on Windows the system's own flags for
  clipboard history and cloud sync; on macOS and Linux the conventions clipboard managers follow
  (`org.nspasteboard.ConcealedType`, the KDE password hint). A manager that ignores the convention
  is outside what the app can do.
- **macOS**: the copied value must not travel to the user's other Apple devices (Universal
  Clipboard), which `arboard` cannot prevent. On macOS the write therefore goes to `NSPasteboard`
  directly, prepared as current-host-only (`prepareForNewContents` with `.currentHostOnly`), with
  the concealed mark as well. The read for the comparison and the clear may stay on `arboard`.
  This is the only platform code of the feature; it is kept in one small module, with the reason
  written in it.
- **Clearing**: with `clear_after_secs` set (the Preferences time; not sent for Never), the backend
  clears the clipboard after that time **only if it still holds what was copied**. The comparison
  keeps a digest of the copied value, not the value. A new copy replaces the pending clear.
- **At exit**: a pending clear is run at once, with the same condition, on every exit the backend
  is told about, the restart after an update included (the app moves from `Builder::run` to
  `build` plus a run loop that handles the exit event). A crash or a kill is not covered.

### 6.3 Export

`export_secret_env(kubeconfig_path, namespace, name, context)` opens the system save dialog from
Rust (`tauri-plugin-dialog`, already a dependency), reads the Secret, and writes the text of §5.4
to the chosen path. The command takes no path: the webview cannot aim the write. It answers with
whether a file was saved, its path, and the key names written and left out.

- The dialog is a child of the main window.
- On Unix the file ends with mode `0600` whether it was created or overwritten: the mode is set
  on the open file before the text is written, not only asked for at creation. On Windows the
  file takes the folder's permissions; nothing is done about it.

### 6.4 Everywhere

- No value in an error string, in a log line, or in a `Debug` output. Errors name the Secret and
  the key, and carry the API server's message.
- The three new commands answer errors as an object, not as a string: a `kind` the view switches
  on (`forbidden`, `secret_missing`, `key_missing`, `not_a_value`, `binary`, `too_large`, `other`)
  and a `message` for display. The other commands keep their string errors.
- The three new commands serve the main window only and refuse any other caller: the log pop-out
  windows share the main window's capability, and they have no business with Secrets.

## 7. Desktop (`apps/desktop/src`)

- `lib/tauri.ts`: the new `SecretInfo` and `SecretKeyInfo`, and one wrapper per new command.
- Reveal state in a small module of its own, pure enough to test with fake timers: shown values by
  `namespace/name/key` with the Secret's resource version and a timer each; the rules of §3.2.
  It lives for the view only and is never persisted.
- `settings.secretHideAfter`: `15 | 30 | 60 | 300 | 0` seconds (`0` is Never), default `30`,
  persisted like the other settings (it is a preference, not a secret).
- `SecretsView.svelte` keeps `ui/ResourceList`; the key rows become a component of their own, so
  the ConfigMap follow-up can reuse them.
- The rule for "valid variable name" exists on both sides (the confirmation's numbers, the file):
  what the backend answers is what the toast reports.
- The Overview's count of Secrets by type keeps working on the new shape (it reads the type only).
- `tests/e2e/tauri-mock.ts` gets the new shape and the three commands.
- What else moves with the shape: the fixtures that build a `SecretInfo` with `data`
  (`kind-views.test.ts`, `overview-summary.test.ts`, the `secret_to_info` test in `watcher.rs`),
  and the doc comments that say values are decoded locally and "never leave the machine"
  (`resources.rs`, `watcher.rs`, `client.rs`, `commands/kubernetes.rs`, `tauri.ts`), which get
  the new truth. `secret_to_info` stops reading `stringData` (the API server never returns it).
  `"secret"` stays in `YamlResourceType`: the read is still served, redacted.

## 8. Tests

- **Core**: a Secret with sentinel values, serialized as `SecretInfo`, as the watcher's event and
  as redacted YAML (with a `last-applied-configuration` annotation holding the same values): the
  output contains the sentinel neither decoded nor in base64. Sizes and the binary mark. The Helm
  mark. `secret_value` against the mocked API: text, binary, missing key, missing Secret, 403,
  Helm release refused. The `.env` text: one case per rule of §5.4. `apply_resource_yaml` refused
  for a Secret. The value type's `Debug` output. `get_dynamic_yaml` with a resource reference
  built to reach a Secret, and one built to reach a `SecretList`: refused by the validation, and
  redacted when the validation is taken out of the way.
- **Tauri**: the clearing rule on a clipboard stand-in (still ours: cleared; replaced by the user:
  untouched; a second copy replaces the pending clear; Never: no clear; pending at exit: run).
  Reveal refuses binary and oversized text. A caller that is not the main window is refused. The
  error object for each `kind`.
- **Desktop unit**: key rows in each state of §3.1; one key revealed leaves the others hidden and
  calls the backend once, for that key; the timer, Hide, leaving the view, namespace change,
  changed resource version, vanished key; an unchanged reload keeps the value; an answer that
  arrives after Hide or after leaving is thrown away; Copy calls the
  backend with the Preferences time and never puts a value in the DOM; the confirmation's numbers
  and its no-writable-key form; the Preferences control; the status region's messages; the row
  errors of §3.5.
- **E2E (Tauri mock)**: reveal one key, see it hide after the time (short time in the test); copy;
  the `.env` confirmation and its toast; keyboard walk through a Secret's actions; forced colours
  and more contrast for the key rows.

## 9. Delivery

Two pull requests to `main`, each usable on its own:

1. **Values stay in the backend** (`feat/661-secret-values-backend`, part of #661): this spec, the
   list shape, the watcher shape, YAML redaction, the Helm mark, reveal per key, the timer and its
   Preferences setting.
2. **Copy and export** (`feat/661-secret-copy-export`, closes #661): copy from the backend with
   the clearing rule, and the `.env` download. It adds `arboard` and the macOS pasteboard module.

After the first one, a value can be copied by revealing it and selecting the text. Until the
second one is in, the first shows only what it does: the chip reads "a value is read only when you
reveal it", the Preferences label is "Hide a shown value after", the key rows have no Copy and the
list has no Export column. The second brings the texts of §3.

## 10. Calls made in this spec, for review

Decided by the user on 2026-11-14: copy goes through the backend; the clipboard is cleared after
the same time if it still holds the copied value; `.env` download is in, with a warning; ConfigMap
values are a separate issue (#668); the `.env` file is written for a shell; on macOS a copied
value is kept off Universal Clipboard, with platform code.

Mine, to confirm or change:

1. **Times**: 15 s, 30 s, 1 min, 5 min, Never; default 30 s; one setting for both hiding and
   clearing the clipboard.
2. **No countdown** in the row.
3. **Binary values**: never shown, copied as base64.
4. **Text over 64 KiB** is not shown, only copied.
5. **Helm release Secrets** are refused by the backend for reveal, copy and export, not only left
   without buttons in the view.
6. **A shown value is dropped when its Secret changes** (resource version), so the view never
   shows a value that is no longer the one in the cluster.
7. **YAML redaction also covers the `last-applied-configuration` annotation**, and
   `apply_resource_yaml` on a Secret is refused.
8. **`arboard` directly** instead of the Tauri clipboard plugin: it gives the "do not keep" marks
   and adds no command the webview could call.
9. **The save dialog is opened by the backend** and the export command takes no path.
10. **Keys that are not variable names, binary values and values with a NUL are left out** of the
    `.env` and named, not transformed.
11. **A pending clipboard clear runs at exit**, the restart after an update included.
12. **Two pull requests** rather than one.
13. **The new commands serve the main window only**; the log pop-out windows are refused.
14. **Resource references are validated** (no slash in group, version or plural) for every
    command that takes one, not only for the Secret case: it closes the way around the redaction
    and any other path built the same way.
15. **Structured errors for the three new commands only**; the rest of the app keeps strings.

## 11. Left to the builder

- The names of the internal types and modules, and where the reveal state lives.
- Which of `arboard`'s Windows marks to set (its docs say the monitoring one covers the other two
  and is not to be combined with them).
- How a command learns which window called it.
- The exact layout of the key row's columns at narrow widths (the actions never wrap under the
  key name; the value area takes what is left).
- How the "Copied" state and the "Reading…" state are drawn within `ui/Button`.
