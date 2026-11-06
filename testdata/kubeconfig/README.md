# Kubeconfig fixture corpus

Realistic, anonymised kubeconfig layouts the core must read the way kubectl
does (#548). `crates/cubelite-core/tests/kubeconfig_fixtures.rs` (`cargo test`)
loads every case through `KubeConfig::load_from_paths` (the context list, the
server per context, Preferences sources) and the client path
(`client::merged_kubeconfig` plus the kube-rs `Config` built from it, without
a cluster).

The merge invariant itself is also property-tested in
`crates/cubelite-core/tests/kubeconfig_merge_property.rs`.

## Adding a case

Create a directory `<case>/` with one or more kubeconfig files and an
`expected.json`. The runner picks it up without code changes.

- **Kubeconfig files** are every `*.yaml` file under the case directory
  (subdirectories included), merged in lexical order of their path relative
  to the case directory: `01-config.yaml`, `02-team-a.yaml`,
  `03-team-b/config.yaml`. Other files (such as `certs/client.crt`) are data
  the kubeconfigs reference.
- **Anonymise everything**: `example.com` / `example.net` hosts, names like
  `team-a`, `prod-1`, `lab-1`, all-zero account and tenant ids, fake tokens
  (`fake-token-1`), and base64 data that decodes to obvious fake bytes
  (`ZmFrZS1jYS1kYXRh` is `fake-ca-data`). Never copy names or values from a
  real file, and never add a `-----BEGIN … PRIVATE KEY-----` block.
- **One credential per user** (a token, an exec plugin, or a client
  certificate). Clients do not agree on which one wins when a user has
  several (kube-rs prefers a token), so the runner rejects a user with more
  than one.
- Every directory here is a case: one without `expected.json` fails the
  runner.
- `expected.json` records the **correct** behaviour. If the code disagrees,
  open a `bug` issue and list the case, the exact field and the value
  observed today in `KNOWN_FAILURES`, with the issue number. The case then reports the gap without failing CI. Any
  other value of that field fails, and so does the field no longer showing
  the listed value, so the entry is updated or removed together with the fix.

## `expected.json`

```json
{
  "description": "What real-world shape this is and what it checks.",
  "current_context": "team-a",
  "contexts": [
    {
      "name": "team-a",
      "cluster": "prod-1",
      "server": "https://prod-1.example.com:6443",
      "user": "team-a",
      "namespace": "default",
      "auth": { "kind": "token", "token": "fake-token-1" }
    }
  ],
  "sources": [
    {
      "file": "01-config.yaml",
      "contexts": 1,
      "shadowed": [],
      "redefined_clusters": [],
      "redefined_users": []
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `current_context` | Merged current-context, or `null`. |
| `contexts` | Every merged context, in merge order (first file wins on a name clash). |
| `contexts[].cluster`, `.user` | Names the winning context entry references (`null` when absent). |
| `contexts[].server` | Server of the cluster the context connects to: the entry of the context's own file, else the first file that defines the name (#543); `null` when no file defines it. |
| `contexts[].namespace` | Effective namespace (`default` when the context sets none). |
| `contexts[].auth` | Credential of the user the context authenticates with, resolved like `server`. |
| `sources` | One entry per kubeconfig file, in merge order; `file` is the path relative to the case directory. |
| `sources[].contexts` | Contexts the file contributes to the merge. |
| `sources[].shadowed` | Context names of the file hidden by an earlier file. |
| `sources[].redefined_clusters`, `.redefined_users` | Names an earlier file defines differently (Preferences note, #543). |

`auth.kind` is one of:

| `kind` | Other fields |
|---|---|
| `token` | `token` |
| `exec` | `command`, `args` (`[]` when none) |
| `client-cert-file` | `client_certificate`, `client_key`: the files read, relative to the case directory (relative paths in a kubeconfig resolve against that file's directory) |
| `client-cert-data` | `client_certificate_data` |
| `none` | none |
