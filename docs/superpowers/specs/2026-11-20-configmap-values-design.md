# A ConfigMap's values, read one at a time — design (#668)

Status: approved by the user, 2026-11-20.

## 1. Intent

Today the ConfigMaps view shows how many keys each ConfigMap has, and nothing else: to read a value
the user opens the YAML. After this change each ConfigMap has its keys listed under it, with the key
rows built for Secrets in #661 (`KeyRows.svelte`), and any one value can be shown or copied.

A ConfigMap value is not a credential. Nothing is masked and nothing runs on a timer: the value is
read from the API server when asked for because the list should stay light (a ConfigMap can hold
files of up to 1 MiB), not to hide anything.

## 2. Goals, non-goals

**Goals**

- The list command and the watcher carry per ConfigMap its key names and the size of each value
  (`data` and `binaryData`), not the values.
- One value can be shown, from the API server, when asked for.
- One value can be copied, without being shown first.
- The key rows are `KeyRows.svelte`, with one new prop, not a copy.
- Keyboard accessible, as the Secrets view.

**Non-goals**

- Editing a value (the YAML editor already does it).
- A `.env` download for ConfigMaps.
- A Preferences setting: there is no timer.
- Redacting the YAML of a ConfigMap: it shows the values as today.

## 3. What the user sees

### 3.1 The list

Same shape as the Secrets view: one row per ConfigMap, its keys always visible under it.

```
ConfigMaps  9

NAME                      NAMESPACE  DATA   AGE
app-config                shop          4   41d
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ LOG_LEVEL          4 B                                         [ Show ]  [ Copy ] │
  │ application.yaml  2.1 KiB                                      [ Hide ]  [ Copy ] │
  │   server:                                                                         │
  │     port: 8080                                                                    │
  │   …                                                                               │
  │ logo.png          14 KiB   binary                                 [ Copy base64 ] │
  │ unused             0 B     empty                                                  │
  └───────────────────────────────────────────────────────────────────────────────────┘
kube-root-ca.crt          shop          1   90d
  ┌───────────────────────────────────────────────────────────────────────────────────┐
  │ ca.crt            1.1 KiB                                      [ Show ]  [ Copy ] │
  └───────────────────────────────────────────────────────────────────────────────────┘
```

- **Key row**: as for Secrets (#661 §3.1): name, size, value area, actions; keys sorted by name,
  `data` and `binaryData` together (the API server refuses a key in both).
- **Size**: the length in bytes of the value as stored (UTF-8 text for `data`, decoded bytes for
  `binaryData`).
- **Value area, not shown**: empty. No dots, no "hidden" for screen readers: there is nothing
  hidden, only nothing read yet.
- **Value area, shown**: as for Secrets: the value on a line of its own under the row, line breaks
  kept, more than 8 lines scroll inside the row, text selectable.
- **Show / Hide**: one text button per key, same button as Reveal / Hide with the words changed;
  "Reading…" while the request runs.
- **Copy**: one text button per key, never shows the value; "Copied" for 2 seconds.
- **`binaryData`**: the value area reads "binary", no Show, the button is "Copy base64".
- **Empty value** (0 B): "empty", no actions.
- **Text over 64 KiB**: "too large to show", no Show, Copy stays.
- **Data** column: the number of keys, as today.
- No chip in the toolbar.

Several keys can be shown at once.

### 3.2 When a shown value goes away

Dropped from the webview's memory when:

- the user presses Hide;
- the view is left, or the namespace or the cluster changes;
- a reload of the list shows the ConfigMap changed (its resource version differs from the one the
  value was read at), or the ConfigMap or the key is gone.

An ordinary reload that finds the ConfigMap unchanged leaves the value shown. An answer that
arrives after its cause is gone is thrown away. These are the rules of #661 §3.2 without the timer.

### 3.3 Errors, in the row

As for Secrets (#661 §3.5): "Not allowed to read this ConfigMap (403)"; "No longer exists" and the
list reloads; any other failure shows the API error's message.

### 3.4 Keyboard and assistive technology

As for Secrets (#661 §3.6), with the words of this view:

- Per key Show then Copy, then the next key.
- Button names carry the key: "Show application.yaml", "Hide application.yaml",
  "Copy application.yaml", "Copy logo.png as base64".
- Show and Hide are one button: focus stays on it.
- One polite status region: "application.yaml shown", "application.yaml hidden",
  "application.yaml copied". The value is never put in it.
- Forced colours and more contrast hold, as for the Secrets key rows.

## 4. What crosses to the webview

| Command | Before | After |
|---|---|---|
| `list_configmaps` | per ConfigMap: the number of keys | per key: name, size, binary mark; the resource version |
| watcher, kind `configmap` | the same as `list_configmaps` | the same as `list_configmaps` |
| `read_configmap_value` (new) | – | one value, text only |
| `copy_configmap_value` (new) | – | the format used (`text` or `base64`) |

## 5. Core (`crates/cubelite-core`)

### 5.1 The list shape

```rust
pub struct ConfigMapInfo {
    pub name: String,
    pub namespace: String,
    /// One entry per key of `data` and `binaryData`, sorted by key. Never the values.
    pub keys: Vec<ConfigMapKeyInfo>,
    /// Lets the view drop a shown value when the ConfigMap changes.
    pub resource_version: Option<String>,
    pub creation_timestamp: Option<String>,
}

pub struct ConfigMapKeyInfo {
    pub key: String,
    /// Length of the value, in bytes.
    pub size: u64,
    /// The key is under `binaryData`.
    pub binary: bool,
}
```

`data_count` is removed; the view counts `keys`. `ConfigMapKeyInfo` has the shape of
`SecretKeyInfo`: the builder may make them one type if that stays readable.

### 5.2 Reading one value

- `KubeClient::configmap_value(namespace, name, key)` gets the ConfigMap and returns the one value
  as text (`data`) or bytes (`binaryData`), with the resource version it was read from.
- Errors tell apart: the ConfigMap does not exist, the key does not exist; a 403 stays the API
  error. Binary and too large are refused by the read command (§6.1), not by the core.
- Namespace and name are validated as for every typed call (#671).

## 6. Tauri (`apps/desktop/src-tauri`)

### 6.1 Read

`read_configmap_value(kubeconfig_path, namespace, name, key, context)` answers with the value and
the resource version. It refuses a `binaryData` value and a text over 64 KiB.

### 6.2 Copy

`copy_configmap_value(kubeconfig_path, namespace, name, key, context)` reads the value and writes
the clipboard from Rust, text as it is, binary as base64, through the clipboard instance of #661.
It answers with the format used. The value does not cross to the webview.

- **Plain write**: no "do not keep" mark, not kept off Universal Clipboard, no clear afterwards.
  The `Board` of `clipboard/mod.rs` gains a plain write next to the concealed one; on macOS the
  plain write is an ordinary pasteboard write.
- A plain copy **drops any pending clear** of a Secret value: the clipboard no longer holds it, and
  a clear that compares digests must not touch the new content.

### 6.3 Everywhere

- Errors as an object, `kind` and `message`, as the Secret commands: `forbidden`,
  `configmap_missing`, `key_missing`, `binary`, `too_large`, `other`.
- The two commands serve the main window only, with the guard of the Secret commands.
- No value in an error string or a log line (a ConfigMap is not a credential, but the rule costs
  nothing and keeps one habit).

## 7. Desktop (`apps/desktop/src`)

- `lib/tauri.ts`: the new `ConfigMapInfo` and `ConfigMapKeyInfo`, one wrapper per new command.
- `KeyRows.svelte` gains one prop, `masked` (default `true`). With `masked={false}`: the value area
  is empty when nothing is shown (no dots, no "hidden"), and the toggle reads Show / Hide
  ("Show", "Hide", "Reading…"; names "Show <key>", "Hide <key>"). Nothing else changes, the Secrets
  view included.
- Shown-value state: the rules of §3.2. The reveal state of #661 (`secret-reveal.svelte.ts`) is
  reused with its timer turned off, or made generic over the object kind, rather than copied; the
  builder chooses, and the Secrets tests stay as they are.
- Copy state ("Copied" for 2 seconds): as `secret-copy.svelte.ts`, reused the same way.
- `ConfigMapsView.svelte` keeps `ui/ResourceList` and draws `KeyRows` under each row as
  `SecretsView.svelte` does.
- What moves with the shape: fixtures that build a `ConfigMapInfo` with `data_count` (unit tests,
  `tests/e2e/tauri-mock.ts`, the `configmap_to_info` test in `watcher.rs`), and anything that reads
  `data_count` (the Overview, counts, the palette).

## 8. Tests

- **Core**: `configmap_to_info` with `data` and `binaryData`: names sorted, sizes, binary mark,
  resource version, and the serialized output holds no value (sentinel). `configmap_value` against
  the mocked API: text, binary, missing key, missing ConfigMap, 403.
- **Tauri**: read refuses binary and oversized text; copy writes plain and drops a pending Secret
  clear; caller not the main window refused; the error object for each `kind`.
- **Desktop unit**: `KeyRows` with `masked={false}` in each state (empty area, Show/Hide words and
  names), and the Secrets states unchanged with the default; ConfigMaps view: one key shown calls
  the backend once, for that key; Hide, leaving the view, namespace change, changed resource
  version, vanished key; an unchanged reload keeps the value; a late answer is thrown away; Copy
  calls the backend and puts no value in the DOM; status messages; row errors.
- **E2E (Tauri mock)**: show one key, hide it; copy; a binary key offers Copy base64 only; keyboard
  walk through a ConfigMap's actions; forced colours and more contrast.

## 9. Delivery

One pull request to `main` (`feat/668-configmap-values`, closes #668).

## 10. Calls made in this spec

Decided by the user on 2026-11-20: copy goes through the backend, plain (no mark, no clear,
Universal Clipboard allowed); a `binaryData` value is copied as base64; a key not shown has an
empty value area and the buttons read Show / Hide.

Proposed in the draft, approved by the user on 2026-11-20:

1. **No timer and no Preferences setting.**
2. **A shown value is dropped when its ConfigMap changes**, as for Secrets.
3. **Text over 64 KiB is not shown, only copied**, as for Secrets.
4. **A plain copy drops a pending Secret clear.**
5. **The new commands serve the main window only**, as the Secret commands.
6. **Structured errors** for the two new commands, as the Secret commands.
7. **No `.env` for ConfigMaps.**
8. **One pull request.**

## 11. Left to the builder

- Whether `ConfigMapKeyInfo` and `SecretKeyInfo` become one type.
- Whether the reveal and copy state of #661 is reused with options or made generic.
- How the plain write sits next to the concealed one in `clipboard/`.
