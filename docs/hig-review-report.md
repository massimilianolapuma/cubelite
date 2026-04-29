# Report HIG Review — CubeLite Design System

**Autore**: Design Agent (GitHub Copilot)  
**Data**: 2025-07  
**Branch**: `feat/67-macos-first-launch`  
**Riferimento HIG**: Apple Human Interface Guidelines — macOS  
**Scope**: Pagine Penpot "States & Components" + "macOS Native"  
**Modalità**: Solo analisi — nessuna modifica apportata

---

## Riepilogo Executive

Il design system di CubeLite si trova in uno **stato di conformità parziale** rispetto alle Apple Human Interface Guidelines. I componenti del kit UI (`kit-*`) sulla pagina "States & Components" sono generalmente ben disegnati, con colori Apple system corretti e dimensioni ragionevoli, ma presentano lacune strutturali (stati mancanti, inconsistenze tra light/dark). La pagina "macOS Native" mostra una **qualità molto variabile**: alcune viste (MainView, Resource Browser, Preferences) sono sostanzialmente conformi, mentre altre (First Launch, Deployment Detail – Light) usano colori completamente non Apple e dimensioni da paradigma web/iOS.

**Sintesi valutazioni**:

| Area | Conformità HIG | Note |
|---|---|---|
| Kit UI (`kit-*`) | ⚠️ **Sufficiente** | Colori corretti, dimensioni borderline, stati mancanti |
| Board legacy (Component Library ecc.) | ❌ **Non conforme** | Colori Tailwind, nessun dark mode |
| macOS Native — MainView | ✅ **Buono** | Piccole inconsistenze colore tra dark variant e kit |
| macOS Native — Resource Browser | ⚠️ **Sufficiente** | Colori sidebar non standard (icon colors) |
| macOS Native — Namespace View | ⚠️ **Problematico** | Bug tab selezionato in Light, inconsistenza colonne |
| macOS Native — Deployment Detail | ⚠️ **Mix** | Dark buono, Light completamente non conforme |
| macOS Native — Preferences | ✅ **Buono** | Controlli dimensione borderline, struttura ok |
| macOS Native — Preferences Advanced | ⚠️ **Problematico** | Toggle sotto dimensioni, input sotto standard |
| macOS Native — First Launch | ❌ **Non conforme** | Colori Tailwind, misure iOS, titled bar assente |
| macOS Native — Logs & Errors Panel | ⚠️ **Sufficiente** | Bug posizionamento, duplicati titlebar |

**Problemi totali identificati**: 32 (3 P0, 8 P1, 12 P2, 9 P3)

---

## Sezione 1 — Pagina "States & Components"

### 1.1 kit-titlebar-light / kit-titlebar-dark ✅

**Dimensioni**: 280×30pt — titlebar macOS tipicamente 28-32pt ✅  
**Traffic lights**: 12×12pt, spaziatura 16pt tra cerchi ✅  
**Colori semafori**: #ff5f57 (close), #febc2e (min), #28c840 (zoom) — identici ai valori macOS standard ✅  
**Colori bg**: #e8e8e8 (light) / #2c2c2e (dark) — ✅ semanticamente corretti per NSWindow background  
**Border bottom**: 1pt #d5d5d5 (light) / #3a3a3c (dark) — ✅ separatore corretto  
**Testo titolo**: #1d1d1f (light) / #f5f5f7 (dark) ✅

**Problemi**: nessuno

---

### 1.2 kit-tabbar-light / kit-tabbar-dark ✅

**Dimensioni**: 360×37pt — altezza NSSegmentedControl stile tab ✅  
**Background board**: #FFFFFF — artefatto Penpot, il componente usa le rect corrette  
**Bg rect**: #f5f5f5 (light) / #2a2a2c (dark) ✅  
**Tab selected bg**: #ffffff (light) / #1c1c1e (dark) ✅  
**Separatori verticali**: 1×20pt ✅  
**Testo inactive**: #aeaeb2 (light) / #636366 (dark) ✅  
**Testo selected**: #1d1d1f (light) / #f5f5f7 (dark) ✅  
**Corner radius tab**: 4pt ✅ (coerente con macOS style)

**Problemi**: nessuno rilevante

---

### 1.3 kit-formfield-light / kit-formfield-dark ✅

**Dimensioni**: 338×28pt — altezza input standard macOS 28pt ✅  
**Input height**: 28pt ✅ (HIG: text field min 22pt, standard 28pt)  
**Corner radius**: 5pt ✅  
**Color input bg**: #f2f2f7 (light) / #3a3a3c (dark) ✅  
**Placeholder**: #aeaeb2 (light) / #636366 (dark) ✅ — colori secondari Apple  
**Label text**: #1d1d1f (light) / #f5f5f7 (dark) ✅  
**Browse button**: 56×28pt — larghezza minima, ma accettabile per un action button inline

> ⚠️ **P3** — Background board #FFFFFF (artefatto Penpot, non è il background del componente)  
> ⚠️ **P3** — Mancano stati interattivi del campo (focused con ring blu, disabled con opacità ridotta)

---

### 1.4 kit-toggle-off/on-light / kit-toggle-off/on-dark ✅

**Track**: 44×26pt — dimensioni standard NSSwitch/macOS toggle ✅  
**Knob**: 22×22pt — rapporto knob/track corretto ✅  
**Knob posizione OFF**: @x=2, ON: @x=20 — movimento coerente ✅  
**Colore ON**: #34c759 (light) / #30d158 (dark) — Apple System Green ✅  
**Colore OFF track**: #d5d5d5 (light) / #3a3a3c (dark) ✅  
**Knob color**: bianco #ffffff (light) / #f5f5f7 (dark) ✅

> ⚠️ **P3** — Frame size inconsistente: `off` è 78×26pt, `on` è 74×26pt in entrambe le varianti. La differenza di 4pt nella larghezza del frame (probabilmente causata da label) può creare offset nel layout se i componenti vengono giustapposti.

---

### 1.5 kit-checkbox-unchecked/checked-light / kit-checkbox-unchecked/checked-dark ⚠️

**Dimensioni box**: 18×18pt  
**HIG**: dimensioni minime controlli macOS = **20×20pt** (assoluto), **28×28pt** (raccomandato)

> ❌ **P1** — `kit-checkbox-unchecked-light` e `kit-checkbox-checked-light` (e dark): box 18×18pt — 2pt SOTTO il minimo assoluto HIG di 20×20pt. Tutti i checkbox nel design system e nelle schermate che li usano ereditano questo problema.

**Colore checked**: #007aff (light) / #0a84ff (dark) — Apple System Blue ✅  
**Checkmark**: bianco su sfondo blu ✅  
**Corner radius**: 4pt ✅ (coerente con macOS checkbox style)  
**Border unchecked light**: rect aggiuntiva #B1B2B5 ✅

> ❌ **P2** — `kit-checkbox-unchecked-dark` manca il rettangolo di bordo presente in `kit-checkbox-unchecked-light`. Inconsistenza strutturale: light ha `box-border` (1pt stroke #B1B2B5), dark non lo ha. Nel rendering finale, il checkbox unchecked in dark mode potrebbe risultare visivamente meno definito.

---

### 1.6 kit-dropdown-light / kit-dropdown-dark ⚠️

**Dimensioni**: 160×28pt ✅  
**Bg color**: #f2f2f7 (light) / #3a3a3c (dark) ✅  
**Testo**: #1d1d1f (light) / #f5f5f7 (dark) ✅  
**Chevron**: 14×20pt, #86868b (light) / #98989d (dark) ✅ colori corretti

> ⚠️ **P3** — Mancano stati: disabled, hover/focused. HIG richiede che i controlli mostrino chiaramente tutti gli stati interattivi nel design system.  
> ⚠️ **P3** — Il "chevron" è un semplice rettangolo (probabilmente rappresenta un SF Symbol non visibile nel data dump), non un vero chevron arrow. Verificare che nell'implementazione si usi SF Symbol `chevron.down`.

---

### 1.7 kit-logrow-light / kit-logrow-dark ⚠️

**Altezza riga**: 32pt ✅ (HIG: righe tabella min 22pt, 32pt è standard confortevole)  
**Severity badge**: 48×16pt, opacity 0.12 (light) / 0.18 (dark) ✅  
**Gerarchia visiva**: severity | timestamp | source | message — ✅ ordine corretto  
**Colori**: corretti per entrambe le varianti ✅

> ❌ **P1** — `kit-logrow-dark` manca l'elemento hover state. `kit-logrow-light` include `kit-row-bg-hover-l` (480×32, #f0f0f0@0.60), ma la variante dark non ha l'equivalente hover. Inconsistenza che comporta un comportamento visuale diverso tra light e dark mode.

---

### 1.8 kit-badge-error/warn/info-light / kit-badge-error/warn/info-dark ✅

**Altezza badge**: 22pt ✅ (HIG min control 20pt)  
**Opacità bg**: 0.12 (light) / 0.18 (dark) — scelta corretta per adattarsi a sfondi diversi ✅  
**Colori**: Apple system colors corretti (red, orange, blue × light/dark) ✅  
**Corner radius**: 3pt

> ⚠️ **P3** — `border-radius: 3pt` è molto basso. HIG macOS preferisce badge con corner radius proporzionale alla metà dell'altezza per badge "pillola" (~11pt per un badge h:22pt). L'attuale r:3 dà un aspetto più squadrato che non è tipico dei badge macOS.

---

### 1.9 kit-button-light / kit-button-dark ⚠️

**Dimensioni**: 120×32pt — altezza 32pt è il massimo standard per bottoni macOS ✅  
**Colore**: #007aff (light) / #0a84ff (dark) — Apple System Blue per `.bordered .prominent` ✅  
**Corner radius**: 6pt ✅  
**Testo**: bianco #ffffff ✅

> ⚠️ **P2** — Mancano completamente le varianti di stato: disabled (opacity ridotta), hover (background più luminoso), pressed (background più scuro/saturato). Nel design system è presente solo lo stato "default".  
> ⚠️ **P3** — HIG richiede che il bottone primario (key action) abbia il ring del Return key equivalente visibile nel disegno. Nessun indicatore visivo del default button (anello esterno o accento pronunciato).  
> ⚠️ **P3** — Presente solo lo stile `.prominent` (filled). Mancano stili secondario (tinted/grey) e terziario (plain) che completerebbero la gerarchia dei bottoni macOS.

---

### 1.10 kit-statusbar-light / kit-statusbar-dark ✅

**Altezza**: 28pt ✅ (HIG status bar 22-28pt)  
**Bg**: #f5f5f5 (light) / #252528 (dark) ✅  
**Separatore top**: 480×1pt ✅  
**Testo**: #86868b (light) / #98989d (dark) — ✅ colori terziari Apple

**Problemi**: nessuno

---

### 1.11 kit-separator-light / kit-separator-dark ✅

**Spessore**: 1pt ✅ (HIG: dividers sono 1pt — "hairline")  
**Colori**: #e5e5ea (light) / #3a3a3c (dark) — identici ai valori NSColor.separatorColor ✅

**Problemi**: nessuno

---

### 1.12 Board Legacy: Component Library, Empty States, Error States, Loading States ❌

Questi quattro board rappresentano un prototipo precedente di stile web/Tailwind e **non sono conformi all'HIG macOS** su nessuno dei parametri chiave:

**Colori**:
- Usano sistematicamente colori Tailwind: `#6366f1` (indigo-500), `#ef4444` (red-500), `#22c55e` (green-500), `#f59e0b` (amber-500), `#6b7280` (gray-500), `#374151` (gray-700), `#1e1e2e` (slate custom dark)
- **Nessun colore Apple system** è presente

> ❌ **P1** — Colori non Apple in tutto il board legacy. HIG macOS richiede che le app utilizzino i colori di sistema NSColor (Red #FF3B30, Green #34C759, Blue #007AFF, ecc.).

**Dimensioni controlli**:
- Bottoni: 140×36pt — altezza 36pt supera il massimo raccomandato macOS di 32pt (è una dimensione iOS/web)
- Card radius: r:12 — per macOS i pannelli usano r:8-10, r:12 è troppo arrotondato

> ❌ **P1** — Dimensioni bottoni 36pt e card radius 12pt sono idiomatici di iOS/web, non macOS.

**Dark mode**: assente — nessuna variante dark nei 4 board legacy.

> ❌ **P1** — Assenza totale di dark mode. macOS richiede supporto obbligatorio per dark mode dal 2019.

**Raccomandazione**: questi board dovrebbero essere **deprecati** e rimpiazzati con componenti che usino i kit macOS (`kit-*`) già definiti correttamente sul lato light e dark.

---

### 1.13 cubelite-icon ⚠️

**Dimensioni board**: 400×400pt, background trasparente ✅  
**Contenuto**: unico elemento `icon-image` [rect] 400×400pt con fill `undefined`

> ❌ **P2** — L'elemento `icon-image` ha fill `undefined` — significa che l'immagine non è collegata o il placeholder è vuoto. L'icona non è visibile nel board. Verificare che la risorsa immagine sia effettivamente collegata nel layer Penpot.

---

## Sezione 2 — Pagina "macOS Native"

### 2.1 Logs & Errors Panel – Light / – Dark (800×552) ⚠️

**Struttura**: titlebar / tab-filter / column headers / righe log / detail panel — ✅ architettura corretta  
**Altezza titlebar**: 28pt ✅  
**Righe log altezza**: 32pt ✅  
**Severity badges**: 54×20pt altezza 20pt = al limite minimo ✅  
**Row selected indicator**: 3×32pt (`sel-indicator`) in blu #007aff — ✅ pattern corretto per selezione riga

> ❌ **P2** — `Logs & Errors Panel – Light`: elemento `r6-sb` ha `ry=6008` — questo è chiaramente un bug di posizionamento Penpot (il valore normale sarebbe circa 308). L'elemento è fuori dal frame visible area. Da correggere.

> ❌ **P2** — `Logs & Errors Panel – Light` ha elementi titlebar duplicati: nel dump sono presenti due set di `titlebar-bg`, `btn-close`, `btn-min`, `btn-zoom`. Probabilmente residuo di un'operazione di copia. Rimuovere i duplicati.

> ⚠️ **P3** — Il testo timestamp/source nelle righe log dovrebbe usare SF Mono o SF Pro Rounded per i timestamp (stile monospace da HIG per log displays). Non verificabile dal data dump, ma da considerare nell'implementazione.

---

### 2.2 MainView – Empty – Light / – Dark (1200×700) ⚠️

**Titlebar**: 32pt ✅ (leggermente alto ma conforme)  
**Toolbar**: 44pt ✅ (standard macOS NSToolbar)  
**Sidebar**: 220pt ✅ (HIG sidebar tipicamente 180-260pt)  
**Separatore sidebar-toolbar**: 1pt ✅  
**Colori Light**: tutti Apple system ✅

> ⚠️ **P2** — `btn-refresh` e `btn-bell`: 24×24pt — sotto il **minimo raccomandato HIG di 28×28pt**. Il minimo assoluto è 20×20pt (questi lo rispettano), ma la raccomandazione di 28pt non è soddisfatta. Target di tap/click area dovrebbe essere almeno 28pt.

> ⚠️ **P2** — Dark variant `titlebar-bg`: #242424. Il kit standard (`kit-titlebar-dark`) usa #2c2c2e. Discrepanza colore titlebar in dark mode tra MainView e il kit component.

> ⚠️ **P2** — Dark variant `toolbar-bg`: #2d2d2d. Non corrisponde ad alcun valore documentato nel kit (pattern light usa #f5f5f5, status bar dark usa #252528). Il valore 2d2d2d è non standard.

> ⚠️ **P3** — Dark `sidebar-bg`: #252525 vs kit statusbar dark #252528 — differenza di 3 cifre hex (quasi identico ma non uguale). Allineamento cromatico consigliato per consistenza.

---

### 2.3 MainView – Error – Light / – Dark (1200×700) ⚠️

**Struttura**: identica a Empty + error banner inline + bell badge ✅  
**Error banner**: bg(979×40) con opacity 0.06 (light) / 0.08 (dark) — ✅ tecnica corretta  
**Banner border**: render opacity 0.35 su colore sistema rosso ✅  
**Link "Fix"**: colore blu sistema ✅

> ✅ **P0 — Risolto (#152)** — `bell-badge` aumentato a **22×22pt** (light + dark) per superare il minimo assoluto HIG 20×20pt e allinearsi alla convenzione kit-checkbox 22pt (PR #140). Re-centrato sul top-right del `btn-bell` (24×24pt, hit target nativo). Testo `bell-badge-n` ricentrato. Swift `MainView+Toolbar.swift` usa `Button { … } label: { Image(systemName: "bell") }` in un toolbar nativo: il bottone fornisce di per sé l'hit target HIG-conforme; il badge è decorativo (ZStack overlay).

---

### 2.4 MainView – No Config – Light / – Dark (1200×700) ⚠️

Struttura identica a Empty, con placeholder "no kubeconfig" nella sidebar.  
**Light**: colori corretti ✅  
**Dark**: stesse inconsistenze cromatiche di MainView – Empty – Dark (#242424 titlebar, #2d2d2d toolbar).

> ⚠️ **P2** — Stesse discrepanze colore dark variant di MainView Empty (vedere 2.2).

---

### 2.5 MainView – Select NS – Light / – Dark (1200×700) ✅

**Sidebar dropdown contesto**: bg(212×32, accent@0.12, r:5) ✅ 
**Status dot**: 8×8pt in verde sistema ✅  
**Context menu espanso**: lista namespace con spacing 28pt tra item ✅  
**Chevron indicator**: 10×8pt ✅

> ⚠️ **P3** — Dark variant: colore testo namespace list `ns0-3` usa #888888, mentre il kit standard usa #86868b (light) / #98989d (dark). Il valore #888888 è un hex custom non allineato con il sistema di colori Apple.

> ⚠️ **P2** — Stesso problema cromatico dark titlebar/toolbar degli altri MainView dark variant (vedere 2.2).

---

### 2.6 macOS – Preferences – Light / – Dark (480×360) ✅

**Titlebar**: 28pt — ✅ standard per finestre dialog/panel macOS  
**Tab bar height**: 52pt (vs kit-tabbar 37pt) — ⚠️ inconsistente con il kit (37pt), ma per una finestra Preferences questo layout "tall" è accettabile su macOS  
**Tab selected**: primo tab General ✅  
**Dropdown fields**: bg #f5f5f7 (light) / #3a3a3c (dark), r:6 ✅  
**Checkbox checked**: #007aff / #0a84ff ✅

> ❌ **P1** — `cb-bg-1`, `cb-bg-2`: 18×18pt — stesso problema dimensione checkbox del kit (sotto minimo 20×20pt). Ereditato da kit-checkbox.

> ⚠️ **P2** — Dark variant `dd-txt-0` usa #98989d (colore secondario/placeholder) per un valore selezionato nel dropdown. Se questo testo rappresenta il valore corrente della scelta, dovrebbe essere #f5f5f7 (testo primario), non secondario.

> ⚠️ **P3** — Dark variant usa `#ebebf5` per le label (pref-lbl-*) invece di `#f5f5f7` (Apple label standard). Differenza minore ma non allineata con il sistema cromatico.

---

### 2.7 Preferences – Advanced (TLS) – Light / – Dark (480×360) ❌

**Struttura**: form card con 4 campi label+input+button + 1 toggle + save button

> ❌ **P1** — **Toggle inline non standard**: track 36×20pt (vs kit standard 44×26pt) e thumb 16×16pt (vs kit 22×22pt). Il toggle nella schermata Advanced usa dimensioni significativamente inferiori rispetto al kit. Questo crea inconsistenza visiva e riduce la hitbox del controllo.

> ❌ **P1** — Dark variant `toggle-thumb`: colore #98989d (grigio secondario) invece di bianco (#f5f5f7). Il thumb del toggle OFF in dark mode non è bianco, rendendo difficile distinguere lo stato ON/OFF visivamente. HIG richiede thumb bianco/luminoso per massimo contrasto.

> ⚠️ **P2** — Input fields altezza: 24pt (vs kit-formfield standard 28pt). La riduzione a 24pt è sotto il raccomandata e crea inconsistenza con gli altri form fields dell'app.

> ⚠️ **P2** — `r1-btn-t` (button text nei form field): dark usa #98989d (colore secondario) — ma se il bottone è "Browse" con un'azione, il testo dovrebbe essere #f5f5f7 (primario). Sembrano disabilitati visivamente senza esserlo semanticamente.

> ⚠️ **P3** — Dark variant conta 34 kids, Light 30 kids — 4 elementi extra nel dark, probabilmente titlebar duplicato (come in Logs & Errors Panel Light). Verificare e rimuovere duplicati.

---

### 2.8 Resource Browser – Light / – Dark (900×600) ⚠️

**Struttura**: sidebar + content (master-detail) ✅  
**Sidebar**: 220pt ✅  
**Table alternating rows**: Light #ffffff / #f2f2f7 ✅; Dark #1c1c1e / #252528 ✅ — pattern HIG corretto  
**Table header**: 28pt, testo secondario ✅  
**Column header separatore**: #e5e5ea (light) / #3a3a3c (dark) ✅  
**Row selected**: `row-pods-sel` bg accent@0.12/0.15 ✅  
**Context pill badge**: 28pt height, corner radius 6 ✅

**Colori icone sidebar** (sezione più problematica):

> ⚠️ **P2** — `icon-services`, `icon-ingress`: Light usa #5856d6, Dark usa #5e5ce6 — questi sono viola custom, **non** Apple System Purple (#AF52DE light / #BF5AF2 dark). Pur essendo semanticamente "purple", il valore scelto non corrisponde al colore di sistema.

> ⚠️ **P2** — `icon-nodes`: sia Light che Dark usano #ff6b00 (orange custom) — **non** è Apple System Orange (#FF9500 light / #FF9F0A dark). Il valore hex è diverso.

> ⚠️ **P2** — `icon-helm-releases`, `icon-helm-charts`: Light usa #0070c9 — molto simile ma **non** è #007AFF (Apple System Blue). Dark usa #0096ff — anch'esso non standard.

> ⚠️ **P3** — Pod name links (`row-name-*`) usano il colore link (#007aff). HIG sconsiglia link underlined in tabelle macOS; preferire invece row selection + navigation per mostrare dettaglio (pattern standard macOS "click row = navigate").

> ⚠️ **P3** — Row status dots: 7×7pt — classificabili come decorative indicators (non interattivi), quindi il minimo 20pt non si applica obbligatoriamente. Tuttavia, per consistenza con l'indicatore context pill (ctx-dot: 8×8pt), sarebbe preferibile uniformare a 8pt.

---

### 2.9 macOS – Namespace View – Light / – Dark (900×600) ❌

**Struttura**: sidebar namespace list + content area con tabella pod ✅  
**Dark**: layout completo e cromaticamente corretto ✅

> ✅ **P0 — Risolto (#153)** — `tab-selected-bg` light: #2c2c2e → **#f0f0f0** (grigio chiaro, coerente con kit Preferences light tab #e8e8e8 e con la palette Apple system). Inoltre fix collaterale: `toolbar-title` (testo "Pods" sulla tab selezionata) era #ffffff (bianco su bianco — invisibile dopo un fix parziale precedente del bg) → **#1d1d1f** (Apple label primary light). Variante Dark non toccata: usa `toolbar-bg` #2c2c2e + `toolbar-title` #f5f5f7, già corretto.

> ❌ **P2** — Light/Dark variant hanno **ordine colonne diverso** nell'header tabella:
>   - Light: `th-name`, `th-status`, `th-ns`, `th-restarts`, `th-age`  
>   - Dark: `th-name`, `th-ns`, `th-status`, `th-age`, `th-restarts`  
>   Inconsistenza strutturale che nella vera app creerebbe due layout di tabella divergenti.

> ⚠️ **P2** — Badge corner radius inconsistente: `all-ns-badge-bg` Light ha r:9, Dark ha r:4. Il radius dovrebbe essere identico tra varianti.

> ⚠️ **P2** — Light titlebar usa #e0e0e0 (non standard) invece di #e8e8e8 (Light variant standard del kit). Stessa inconsistenza in Namespace View e Deployment Detail Light.

> ⚠️ **P2** — Light: `tl-min` #ffbd2e (vs standard #febc2e), `tl-max` #28c940 (vs standard #28c840). Variazioni minime nei colori traffic lights rispetto al kit standard.

> ⚠️ **P2** — Altezza titlebar: 28pt in Namespace/Preferences/Deployment, ma 32pt in MainView — inconsistenza nel "chrome" dell'app. Le finestre dovrebbero usare la stessa altezza titlebar.

---

### 2.10 macOS – Deployment Detail – Light / – Dark (900×600) ❌

**Dark variant**: correttamente implementato con Apple system colors ✅  
**Light variant**: completamente non conforme.

> ❌ **P1** — `macOS - Deployment Detail – Light`: usa sistematicamente colori non Apple:
>   - `titlebar-bg`: #e0e0e0 (ok, ma non standard #e8e8e8)
>   - `titlebar-title`: **#000000** (puro nero — non #1d1d1f Apple label)
>   - `back-button`: **#1a73e8** (Google Material Blue — NON #007aff Apple System Blue)
>   - `avail-badge-bg`: **#d1f5d3** (custom green tint — non Apple system tint)
>   - `avail-badge-txt`: **#1e8f30** (custom green — non Apple system green)
>   - `replicas-txt`: **#555555** (neutral gray custom — non Apple semantics)
>   - `cond-*` values: **#333333** (custom dark — non #1d1d1f)
>   - `pod-name-*`: **#1a73e8** (Google Blue — NON #007aff)
>   - `pod-status-*`: **#34c759** ✅ (questo è corretto)
>
>   La Light variant sembra essere stata creata con un design system diverso (probabilmente Material Design/web) e non allineata con la Dark variant che invece usa correttamente i colori Apple.

> ⚠️ **P2** — Text size inconsistente in Light: `titlebar-title` 14pt, `info-section-lbl` 16pt, `info-lbl-*` 13pt, `info-val-*` 15pt, `deploy-title` 24pt. Il sistema tipografico Apple ha scale precise (Body 13pt, Headline 13pt bold, Title3 15pt, Title2 17pt, Title1 22pt) — il mixing ad-hoc non è conforme.

---

### 2.11 macOS – First Launch – Light / – Dark (600×400) ❌

> ❌ **P1** — `macOS - First Launch – Light` e `– Dark`: **entrambe le varianti mancano completamente del titlebar window**. Nessun elemento `titlebar-bg`, `btn-close`, `btn-min`, `btn-zoom`. Su macOS, anche le finestre di onboarding/first launch mostrano i traffic light buttons (almeno il close button per permettere all'utente di chiudere). L'assenza del titlebar è una violazione del pattern macOS.

> ❌ **P1** — `macOS - First Launch – Light` usa **esclusivamente colori non Apple**:
>   - Logo/button: #6366f1 (Tailwind indigo-500)
>   - Title: **#1e1b4b** (deep indigo custom)
>   - Subtitle: **#6b7280** (Tailwind gray-500 — non #86868b Apple)
>   - Card bg: **#f9fafb** (Tailwind gray-50)
>   - Success text: **#059669** (Tailwind emerald-600 — non #34c759 Apple)
>   - Badge bg: **#eef2ff** (Tailwind indigo-50)
>   - Badge text: **#6366f1** (Tailwind indigo-500)
>   - Step dots inactive: **#d1d5db** (Tailwind gray-300)
>   - Skip link: **#6b7280** (Tailwind gray-500)

> ❌ **P1** — Button height: **44pt** — questa è una dimensione **iOS** (HIG iOS min tap target 44pt). Su macOS, i bottoni standard sono 28-32pt. Il `get-started-btn-bg` (200×44, r:10) non è conforme all'HIG macOS in nessun parametro.

> ❌ **P1** — `macOS - First Launch – Dark` usa #5b5fcf come colore primario per logo/button — non è né Apple System Blue né Apple System Purple standard. È un custom indigo/purple non semantico.

> ⚠️ **P2** — `welcome-title` height: 28pt (light) vs 20pt (dark) — inconsistenza tra varianti.

> ⚠️ **P2** — Logo placeholder corner radius: r:14 (light) vs r:12 (dark) — minima inconsistenza.

> ⚠️ **P3** — Step indicator dots: 12pt attivo, 8pt inattivo — pattern pagination ✅ (ok come indicatore non interattivo).

---

### 2.12 Error Banner Inline – Light / – Dark (400×44) ✅

Board standalone del componente error banner. Dimensioni 400×44pt.

In `MainView – Error`, il banner inline era visualizzato come:
- `err-banner-bg`: 979×40pt, bg_color@0.06 (light) / 0.08 (dark) ✅
- `err-banner-bdr`: stroke opacity 0.35 ✅
- `err-icon`: 12×12pt, `err-msg`: colore sistema rosso ✅
- `err-link`: colore sistema blu ✅

> ⚠️ **P3** — Board standalone (400×44) ha altezza 44pt, ma nel contesto MainView il banner misura 40pt. Minore inconsistenza di 4pt.

---

## Sezione 3 — Riepilogo Problemi per Priorità

### P0 — Critico (accessibilità bloccante)

| ID | Board/Componente | Problema | Azione |
|---|---|---|---|
| ID | Board/Componente | Problema | Azione | Stato |
|---|---|---|---|---|
| P0-01 | MainView – Error (Light/Dark) | `bell-badge` 13×13pt — sotto minimo assoluto 20×20pt | Aumentare a ≥20×20pt con padding interno per hit area | ✅ Risolto (#152) — `bell-badge` 20→22×22pt (light + dark), recentrato sul top-right di `btn-bell` 24×24pt; `bell-badge-n` ricentrato. Swift `MainView+Toolbar.swift` usa SwiftUI `Button` toolbar nativo (hit target sistema), badge decorativo in ZStack — già HIG-conforme. |
| P0-02 | macOS - Namespace View – Light | `tab-selected-bg` usa #2c2c2e (dark) su light theme — tab visivamente rotto | Sostituire con #ffffff (o #f0f0f0) come nelle altre tab bar light | ✅ Risolto (#153) — `tab-selected-bg` #2c2c2e→**#f0f0f0** (grigio chiaro coerente con kit Preferences light); fix collaterale `toolbar-title` #ffffff→**#1d1d1f** (era bianco su bianco dopo fix parziale precedente del bg). Variante Dark non regredita. |

---

### P1 — Alto (violazioni HIG strutturali)

| ID | Board/Componente | Problema | Azione | Stato |
|---|---|---|---|---|
| P1-01 | Tutti i checkbox (kit + Preferences) | Box 18×18pt — sotto minimo HIG 20×20pt | Portare a ≥20×20pt | ✅ Risolto (#140) — kit-checkbox-* box 18→22pt, label x 24→28pt; macOS Native Preferences cb-bg-* 20→22pt; Swift `Toggle(...)` già HIG-conforme |
| P1-02 | macOS – First Launch – Light | Tutti colori Tailwind/non-Apple; button 44pt; nessun titlebar | Rifacimento completo con Apple system colors e dimensioni macOS | ✅ Risolto (#141) — board già ricostruita con palette Apple system (logo `#007aff`, label `#1d1d1f`/`#86868b`, badge `#007aff @ 0.12`, success `#34c759`); button 200×32pt r:6; titlebar 28pt + traffic lights aggiunti; card r:10→8pt |
| P1-03 | macOS – First Launch – Dark | #5b5fcf custom purple; nessun titlebar | Allineare con Apple system colors | ✅ Risolto (#142) — logo/button già `#0a84ff` (Apple system blue dark); titlebar `#2c2c2e` + traffic lights aggiunti; welcome-title `#e8e8f5→#f5f5f7` (label primary dark); contexts-badge `#1e1e40→#0a84ff @ 0.18` bg + `#7b7fe8→#0a84ff` text; logo glyph allineato a "K8s" (parità light) |
| P1-04 | macOS – Deployment Detail – Light | Google Blue #1a73e8, custom greens, colori non Apple | Allineare con Dark variant (che è corretta) | ✅ Risolto (#143) — Google Blue già sostituito con `#007aff` (back button + pod names) e custom green con `.green @ 0.12` (avail badge) in PR precedenti; in questo PR normalizzati i residui: traffic lights `#ffbd2e→#febc2e` / `#28c940→#28c840`, testi primari `#1c1c1e→#1d1d1f` (label primary light), divider `#e0e0e0→#e5e5ea` (separator light), label secondari `#8e8e93→#86868b`. Swift `DeploymentDetailView` già conforme HIG (`.green/.red/.orange/.tint/.secondary`) — nessuna modifica codice. |
| P1-05 | Component Library + Empty/Error/Loading States | Board legacy con colori Tailwind, no dark mode, dimensioni iOS | Deprecare e sostituire con componenti `kit-*` | ✅ Risolto (#144) — board prefissati `[DEPRECATED]`; sostituiti dai board `MainView – Empty/Error – Light/Dark`, `Logs & Errors Panel – Light/Dark`, `Error Banner Inline – Light/Dark` su `macOS Native` che usano i componenti `kit-*` con dark mode parity |
| P1-06 | Preferences – Advanced (TLS) | Toggle 36×20pt (non standard), thumb #98989d dark (non bianco) | Usare toggle dimensioni kit standard (44×26pt); thumb bianco | ✅ Risolto (#145) — TLS toggle già 44×26pt track + 22×22pt thumb (rifatto in PR precedenti); border-radius normalizzato a r:13 (track pill) e r:11 (thumb circle); thumb dark `#f5f5f7`; Swift `Toggle(...)` standard HIG |
| P1-07 | kit-logrow-dark | Manca hover state (presente in light) | Aggiungere elemento hover equivalente a `kit-row-bg-hover-l` | ✅ Risolto (#146) — `kit-row-bg-hover-d` 480×32 #ffffff@0.08 (overlay HIG-corretto per dark mode) garantisce parità con `kit-row-bg-hover-l`; Swift `LogsView` usa `.listStyle(.inset(alternatesRowBackgrounds: true))` che gestisce hover/selection nativamente |
| P1-08 | macOS – First Launch | Nessun titlebar window in entrambe le varianti | Aggiungere titlebar con traffic lights standard | ✅ Risolto (#147) — entrambi i board ora includono `titlebar-bg` 600×28pt + `titlebar-border` 1pt + tre traffic lights (close `#ff5f57`, min `#febc2e`, zoom `#28c840`) 12×12pt; Swift `FirstLaunchView` ospitata in `WindowGroup` standard, quindi i traffic light reali sono forniti dal sistema |

---

### P2 — Medio (inconsistenze e discordanze HIG)

| ID | Board/Componente | Problema | Azione |
|---|---|---|---|
| P2-01 | kit-checkbox-unchecked-dark | Manca border element (presente in light) | Aggiungere `box-border` rect 1pt stroke — ✅ Risolto (#163) — `kit-cb-border-d` convertito da rect filled a 1pt inner stroke `#48484A` (Apple separator dark), border-radius 4pt |
| P2-02 | MainView – Empty/Error/No Config/Select NS (Dark) | Titlebar bg #242424 (non standard vs kit #2c2c2e) | Uniformare a #2c2c2e — ✅ Risolto (#164) — verificato che `titlebar-bg` di tutte e 4 le board MainView Dark è già `#2c2c2e` (allineato a `kit-titlebar-dark`); nessuna modifica Penpot necessaria, doc aggiornata per tracciamento |
| P2-03 | MainView – Empty/Error/No Config/Select NS (Dark) | Toolbar bg #2d2d2d (non documentato nel kit) | Definire valore standard e uniformare — ✅ Risolto (#165) — `toolbar-bg` di tutte e 4 le board MainView Dark portato a `#2C2C2E` (parità titlebar, unified toolbar Sonoma); valore documentato in `docs/cubelite-macos-design-instructions.md` § "Cromia Window Chrome" |
| P2-04 | Logs & Errors Panel – Light | `r6-sb` con ry=6008 — bug posizionamento | Correggere coordinata y |
| P2-05 | Logs & Errors Panel – Light | Elementi titlebar duplicati | Rimuovere duplicati |
| P2-06 | macOS – Namespace View Light/Dark | Ordine colonne tabella diverso tra Light e Dark | Allineare schema colonne tra varianti |
| P2-07 | macOS – Namespace View Light/Dark | Badge radius r:9 (Light) vs r:4 (Dark) | Uniformare — ✅ Risolto (#166) — `all-ns-badge-bg` portato a `r:9` su entrambe le varianti (pill style su altezza 18pt). Probe MCP ha mostrato che entrambi erano in realtà `r:4`; ora entrambi `r:9` |
| P2-08 | macOS – Namespace View / Deployment Detail (Light) | Titlebar bg #e0e0e0 invece di standard #e8e8e8; traffic light colors diversi | Uniformare al kit standard — ✅ Risolto (#167) — verificato via MCP: entrambe le board hanno già `titlebar-bg #e8e8e8` e traffic lights `#ff5f57 / #febc2e / #28c840` (allineati al kit). Rilevato in PR precedenti (#143, #151); doc aggiornata per tracciamento |
| P2-09 | Altezza titlebar | 28pt in Namespace/Preferences/Deployment vs 32pt in MainView | Definire altezza standard per ogni tipo di finestra e documentarla |
| P2-10 | Preferences Advanced (TLS) | Input height 24pt invece di 28pt standard | Portare a 28pt |
| P2-11 | Resource Browser | Icon colors sidebar non standard (#5856d6/#5e5ce6 purple, #ff6b00 orange, #0070c9/#0096ff blue) | Sostituire con Apple system colors — ✅ Risolto (#168) — verificato via MCP: tutte le 12 icone sidebar `icon-*` (Light + Dark) usano già colori Apple system (`systemBlue/Purple/Orange/Green` con varianti light/dark). Mappatura icona→colore documentata in `docs/cubelite-macos-design-instructions.md` § "Mappatura Icone Sidebar Resource Browser" |
| P2-12 | cubelite-icon board | `icon-image` rect ha fill `undefined` | Collegare risorsa immagine |

---

### P3 — Basso (suggerimenti e miglioramenti minori)

| ID | Board/Componente | Problema | Suggerimento |
|---|---|---|---|
| P3-01 | kit-toggle-off/on | Frame width diverso (off: 78pt, on: 74pt) | Uniformare larghezza frame se usati in layout fisso |
| P3-02 | kit-badge-* | Border radius 3pt troppo quadrato per macOS | Aumentare a r:11 (metà altezza 22pt) per stile "pill" |
| P3-03 | kit-button | Mancano varianti: disabled, hover, pressed, secondary, tertiary | Aggiungere stati nel design system |
| P3-04 | kit-dropdown | Mancano stati: disabled, hover, focused | Aggiungere stati nel design system |
| P3-05 | kit-formfield | Mancano stati: focused (ring blu), disabled | Aggiungere stati nel design system |
| P3-06 | MainView Dark (sidebar) | Sidebar #252525 vs statusbar dark #252528 — 3-digit hex diff | Unificare a #252528 |
| P3-07 | MainView – Select NS (Dark) | Namespace list text #888888 invece di standard #98989d | Uniformare |
| P3-08 | Resource Browser | Pod name come link (#007aff) — HIG sconsiglia link in tabelle | Preferire row selection + navigation per visualizzare dettaglio |
| P3-09 | Logs & Errors Panel | Timestamp: verificare uso SF Mono per valori log | Raccomandato SF Mono per leggibilità dati temporali |

---

## Sezione 4 — Checklist HIG Standard (stato attuale)

| Criterio HIG | Kit `kit-*` | macOS Native | Note |
|---|---|---|---|
| Colori Apple system | ✅ | ⚠️ Mix | Alcuni board usano colori custom/Tailwind |
| Supporto dark mode | ✅ | ✅ | Tutte le viste hanno variante Dark |
| Font SF Pro (presunto) | ✅ | ✅ | Non verificabile da dati strutturali |
| Controlli min 20×20pt | ✅ | ✅ | Checkbox 22pt (PR #140), bell-badge 22pt (PR #152) |
| Controlli raccomandati 28×28pt | ⚠️ | ⚠️ | Vari controlli 24-26pt |
| Spaziatura 12pt (con bezel) | ✅ mostly | ✅ mostly | |
| Titolare altezza consistente | N/A | ❌ | 28pt vs 32pt tra finestre diverse |
| Tutti gli stati interattivi | ❌ | N/A | Stati mancanti nel kit |
| Separatori 1pt | ✅ | ✅ | |
| Alternating row colors | ✅ | ✅ | Resource Browser e log rows corretti |
| Contrasto testo ≥4.5:1 | ✅ | ⚠️ | Alcune varianti usano colori non standard |
| Accessibilità focus visible | ❌ | N/A | Focus ring non disegnato nei kit |

---

## Appendice — Mappatura Colori

### Colori Apple System Corretti (riferimento)

| Colore | Light | Dark |
|---|---|---|
| System Red | #FF3B30 | #FF453A |
| System Orange | #FF9500 | #FF9F0A |
| System Yellow | #FFCC00 | #FFD60A |
| System Green | #34C759 | #30D158 |
| System Blue | #007AFF | #0A84FF |
| System Purple | #AF52DE | #BF5AF2 |
| Label Primary | #1D1D1F | #F5F5F7 |
| Label Secondary | #86868B | #98989D |
| Label Tertiary | #AEAEB2 | #636366 |
| Separator | #E5E5EA | #3A3A3C |
| Window Bg | #ECECEC | #1E1E1E |
| Panel Bg | #F5F5F5 | #252528 |
| Titlebar | #E8E8E8 | #2C2C2E |
| Control Bg | #F2F2F7 | #3A3A3C |

### Colori Non Conformi Trovati nel Design

| Colore trovato | Board | Colore Apple corretto | Note |
|---|---|---|---|
| #1A73E8 | Deployment Detail Light, Namespace View Light | #007AFF | Google Material Blue |
| #6366F1 | First Launch Light, Component Library | nessun equivalente Apple | Tailwind indigo-500 |
| #1E1B4B | First Launch Light | #1D1D1F | Custom deep indigo |
| #6B7280 | First Launch Light | #86868B | Tailwind gray-500 |
| #059669 | First Launch Light | #34C759 | Tailwind emerald-600 |
| #5B5FCF | First Launch Dark | #0A84FF o #BF5AF2 | Custom purple |
| #5856D6 / #5E5CE6 | Resource Browser | #AF52DE / #BF5AF2 | Custom purple (non system) |
| #FF6B00 | Resource Browser (nodes) | #FF9500 | Custom orange |
| #0070C9 / #0096FF | Resource Browser (helm) | #007AFF / #0A84FF | Varianti non standard |
| #242424 | MainView Dark (titlebar) | #2C2C2E | Off-dark non standard |
| #2D2D2D | MainView Dark (toolbar) | non documentato | Valore custom |
| #000000 | Deployment Detail Light (title) | #1D1D1F | Pure black invece di Apple label |
| #333333 | Deployment Detail Light | #1D1D1F | Custom dark gray |
| #888888 | MainView Select NS Dark | #98989D | Valore terziario custom |
| #E0E0E0 | Namespace/Deployment Light (titlebar) | #E8E8E8 | Leggera variazione |

---

*Report generato dal Design Agent — solo analisi, nessuna modifica apportata.*
