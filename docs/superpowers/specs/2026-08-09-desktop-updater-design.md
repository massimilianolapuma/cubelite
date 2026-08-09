# Desktop auto-update (#250, senza firma Apple) — design

Date: 2026-08-09 · Scope: app desktop Tauri + CI. La parte "signed/notarized
dmg" di #250 è rimandata a #121 (richiede Apple Developer Program); qui si
consegna l'updater cross-platform con firma minisign propria.

## Stato attuale

`release.yml` ha già la matrice a 3 piattaforme (macOS dmg, Linux
AppImage/deb, Windows msi/nsis) con asset a nomi stabili sulla release. Manca
tutto il flusso updater: nessun plugin, nessun artifact `.sig`, nessun
endpoint, nessuna UI.

## Decisioni

1. **tauri-plugin-updater v2** (+ `tauri-plugin-process` per il relaunch).
   Firma updater = coppia minisign generata con `tauri signer generate` —
   indipendente da Apple. Chiave privata SOLO nel secret GitHub
   `TAURI_SIGNING_PRIVATE_KEY`; pubkey in `tauri.conf.json`. La chiave va
   backuppata dall'utente (perderla = gli utenti installati non ricevono più
   update).
2. **Endpoint**: `latest.json` statico allegato alla GitHub release,
   raggiunto via `https://github.com/<repo>/releases/latest/download/latest.json`
   (pattern asset-nomi-stabili già in uso). Generato in CI dal job publish
   aggregando i `.sig` della matrice.
3. **UX**: check silenzioso all'avvio (non blocca, fallisce muto se offline);
   se c'è un update → banner non modale "Update <v> available — Restart to
   update / Later". Bottone "Check for updates" in Preferences con stato
   (checking / up to date / update available / error). Download+install via
   plugin, poi relaunch su conferma.
4. **Piattaforme**: updater artifacts per macOS (app.tar.gz), Windows
   (nsis/msi), Linux (AppImage). I pacchetti deb restano solo asset di
   release (apt non usa l'updater Tauri).
5. macOS unsigned: l'updater Tauri funziona con app ad-hoc-signed (la firma
   minisign protegge il canale update); Gatekeeper resta il limite noto del
   primo install, invariato fino a #121.

## Testing

- Unit (vitest): store `updater.svelte.ts` con mock del plugin JS (stati:
  idle→checking→available→downloading→ready→error; check-on-startup gating).
- CI: job di verifica che `latest.json` generato referenzi tutti i target
  attesi con `.sig` presenti (script + test).
- Manuale (utente): release di prova → app installata vecchia versione →
  banner appare → update → relaunch su versione nuova.

## Out of scope

Firma/notarization Apple (#121), canale beta/nightly, delta updates,
auto-download senza consenso (si scarica solo dopo click).
