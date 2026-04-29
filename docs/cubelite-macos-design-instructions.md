# CubeLite macOS — Apple HIG Design Instructions

Linee guida di design per l'app macOS di CubeLite, derivate dall'analisi completa
delle Apple Human Interface Guidelines (Foundations, Components, Patterns, Inputs).

> **Questo documento è il riferimento obbligatorio** per ogni review di componenti
> Penpot e per ogni implementazione SwiftUI nell'app macOS.

---

## 1. Tipografia

### Font di Sistema

- Font: **SF Pro** (sistema macOS)
- macOS **NON supporta Dynamic Type** — le dimensioni sono fisse

### Stili di Testo

| Stile | Peso | Dimensione | Interlinea | Enfatizzato |
|-------|------|-----------|------------|-------------|
| Large Title | Regular | **26 pt** | 32 | Bold |
| Title 1 | Regular | **22 pt** | 26 | Bold |
| Title 2 | Regular | **17 pt** | 22 | Bold |
| Title 3 | Regular | **15 pt** | 20 | Semibold |
| Headline | **Bold** | **13 pt** | 16 | Heavy |
| Body | Regular | **13 pt** | 16 | Semibold |
| Callout | Regular | **12 pt** | 15 | Semibold |
| Subheadline | Regular | **11 pt** | 14 | Semibold |
| Footnote | Regular | **10 pt** | 13 | Semibold |
| Caption 1 | Regular | **10 pt** | 13 | Medium |
| Caption 2 | Medium | **10 pt** | 13 | Semibold |

### Regole

- Dimensione corpo di default: **13 pt**
- Dimensione minima leggibile: **10 pt** — mai scendere sotto
- **Evitare pesi leggeri** (Ultralight, Thin, Light) per testo body
- Capitalizzazione dei titoli dei bottoni: **Title-Style** (ogni parola maiuscola)
- Capitalizzazione intestazioni colonne tabelle: **Title-Style**, senza punteggiatura finale
- Gerarchia label: `label` → `secondaryLabel` → `tertiaryLabel` → `quaternaryLabel`

---

## 2. Colori e Temi

### Supporto Obbligatorio

- Supportare **sempre Light e Dark Mode**
- Usare **colori semantici** (`labelColor`, `secondaryLabelColor`, `controlColor`, `separatorColor`, ecc.) — si adattano automaticamente al tema
- **Mai hard-codare** valori RGB di colori di sistema
- **Mai ridefinire** il significato semantico dei colori di sistema
- **Mai usare** lo stesso colore per due significati diversi
- **Mai affidarsi solo al colore** per comunicare informazioni — aggiungere testo/forma/pattern

### Colori di Sistema macOS (RGB Approssimativo)

| Colore | Light | Dark |
|--------|-------|------|
| Red | `#FF3B30` | `#FF453A` |
| Orange | `#FF9500` | `#FF9F0A` |
| Yellow | `#FFCC00` | `#FFD60A` |
| Green | `#34C759` | `#30D158` |
| Blue | `#007AFF` | `#0A84FF` |
| Indigo | `#5856D6` | `#5E5CE6` |
| Purple | `#AF52DE` | `#BF5AF2` |
| Pink | `#FF2D55` | `#FF375F` |

### Colore Accent

- Di default: **selezionato dall'utente** nelle Impostazioni di Sistema
- **Non fissare** il colore delle icone sidebar — usare il colore accent dell'utente
- Azione distruttiva: stile **destructive** (rosso), ma solo per azioni non intenzionali

### Cromia Window Chrome (CubeLite)

Riferimento per i mockup Penpot e l'allineamento con i kit `kit-titlebar-*`. macOS Sonoma adotta una **toolbar unificata** con titlebar dello stesso colore (no separazione visiva).

| Elemento | Light | Dark | Note |
|---|---|---|---|
| Titlebar bg | `#E8E8E8` | `#2C2C2E` | `kit-titlebar-light` / `kit-titlebar-dark` |
| Toolbar bg | `#E8E8E8` | `#2C2C2E` | **Parità con titlebar** (unified toolbar HIG) — applicato a tutte le `MainView – */Dark` board |
| Window bg | `#FFFFFF` | `#1C1C1E` | Contenuto principale |
| Sidebar bg (Dark) | — | `#252528` | `kit-statusbar-dark` |
| Traffic light close | `#FF5F57` | `#FF5F57` | |
| Traffic light min | `#FEBC2E` | `#FEBC2E` | |
| Traffic light max | `#28C840` | `#28C840` | |

### Titlebar Height (CubeLite)

Altezza canonica **28pt** per la titlebar di tutte le finestre principali, dialog e panel. Allineata a `kit-titlebar-light/dark` (h=30pt nel kit, 28pt nelle istanze applicative — il kit include 2pt di margine visivo del board).

| Tipo finestra | Titlebar | Toolbar (se presente) | Totale chrome |
|---|---|---|---|
| MainView (con toolbar unificata) | `28pt` | `44pt` | `72pt` |
| Preferences (panel) | `28pt` | `52pt` (tabbar) | `80pt` |
| Namespace View / Deployment Detail | `28pt` | — (toolbar inline) | `28pt` |
| Logs & Errors Panel | `28pt`* | — | `28pt`* |
| First Launch | `28pt` | — | `28pt` |

\* La board `Logs & Errors Panel – Light` ha `titlebar-bg h=32pt` come residuo storico; `– Dark` è già a `28pt`. Allineamento futuro tracciato (non bloccante).

**Centratura traffic lights**: i tre cerchi 12×12pt sono centrati verticalmente nella titlebar:
- Per `h=28`: `y = (28 − 12) / 2 = 8pt` dal top della titlebar
- Per `h=32` (legacy): `y = 10pt`

**Centratura titolo**: testo titolo ~15pt di altezza, centrato:
- Per `h=28`: `y ≈ (28 − 15) / 2 = 6.5pt` → `7pt` dal top

> Convenzione: ogni nuova board macOS deve usare `h=28pt` per la titlebar. Eccezioni richiedono giustificazione esplicita nel design review.

### Dark Mode

- Rispettare la scelta di sistema — **mai offrire impostazione app-specifica** per aspetto
- Contrasto minimo: **4.5:1** (testo normale), **3:1** (testo grande/bold), ideale **7:1**
- Usare SF Symbols con colori dinamici
- **Desktop tinting**: aggiungere trasparenza ai background custom di componenti neutrali, così si armonizzano con lo sfondo del desktop
- Non aggiungere trasparenza quando il componente usa colore (evita fluttuazioni)

### Mappatura Icone Sidebar Resource Browser

Le icone sidebar della **Resource Browser** usano colori semantici Apple system con varianti light/dark coerenti. Il raggruppamento riflette i domini Kubernetes:

| Gruppo | Risorse | Light | Dark | Apple |
|---|---|---|---|---|
| Workloads | pods, deployments, jobs, cronjobs | `#007AFF` | `#0A84FF` | `systemBlue` |
| Networking | services, ingress | `#AF52DE` | `#BF5AF2` | `systemPurple` |
| Config | configmaps, secrets | `#FF9500` | `#FF9F0A` | `systemOrange` |
| Storage | pvc | `#34C759` | `#30D158` | `systemGreen` |
| Cluster | nodes | `#FF9500` | `#FF9F0A` | `systemOrange` |
| Helm | helm-releases, helm-charts | `#007AFF` | `#0A84FF` | `systemBlue` |

> Nota HIG: Apple raccomanda generalmente di rispettare l'`accentColor` utente per le icone sidebar. Per le **icone "categoria"** di una resource browser è ammesso fissare colori semantici purché provengano dalla palette system, in modo che il cambio di tema light/dark sia automatico e il contrasto resti garantito.

### Namespace View — Pod Table

Schema canonico delle colonne della Pod table nella **Namespace View** (entrambe le varianti Light e Dark). Allineato alla convenzione `kubectl get pods` per famigliarità immediata agli utenti Kubernetes.

| Posizione | Element name | Header text | Tipo dato | Esempio |
|---|---|---|---|---|
| 1 | `th-name` | `Name` | nome pod | `nginx-deployment-7d9c6b` |
| 2 | `th-ns` | `Namespace` | namespace | `default`, `kube-system` |
| 3 | `th-status` | `Status` | fase pod | `Running`, `Pending`, `CrashLoop` |
| 4 | `th-age` | `Age` | età pod | `2d`, `5h`, `10m` |
| 5 | `th-restarts` | `Restarts` | conteggio restart | `0`, `14` |

> Variante Dark è la **canonica di riferimento** per element-name → testo. La variante Light deve allineare semantica colonne, posizioni `x` e contenuto rows alla Dark (vedere issue #185 per defects strutturali residui sul Light).

---

## 3. Dimensioni e Spaziatura

### Controlli

| Metrica | Valore |
|---------|--------|
| Dimensione minima controllo (raccomandata) | **28×28 pt** |
| Dimensione minima controllo (assoluta) | **20×20 pt** |
| Padding controllo con bezel | **~12 pt** |
| Padding controllo senza bezel | **~24 pt** |

### Layout

- Raggruppare elementi correlati con spazi negativi, sfondi, colori, separatori
- Dare spazio sufficiente alle informazioni essenziali
- Estendere i contenuti fino ai bordi della finestra — sfondi full-bleed
- **Non posizionare controlli o info critiche in basso** alla finestra (gli utenti spesso spostano le finestre oltre il bordo inferiore)
- Allineare i componenti per facilitare la scansione visiva
- Ordinare in ordine di lettura: dall'alto verso il basso, dal leading al trailing
- Usare progressive disclosure per contenuti nascosti
- Divisore split view: preferire stile **thin (1 pt)**

### Sidebar

- Le dimensioni delle righe sidebar dipendono dall'impostazione **Small/Medium/Large** dell'utente
- Non fissare i colori delle icone — rispettare il colore accent
- Considerare auto-hide/show sidebar quando la finestra si ridimensiona
- Mostrare **max 2 livelli** di gerarchia; per strutture più profonde, usare split view
- Evitare info critiche in fondo alla sidebar

### Toolbar

- Tre zone: **leading / center / trailing**
- Ogni elemento toolbar deve avere un comando corrispondente nella menu bar
- Elementi senza bezel
- Massimo **3 gruppi** di toolbar

---

## 4. Componenti — Regole Specifiche

### 4.1 Toggle/Switch

- Dimensione: regular o mini
- Preferire switch per enfasi, checkbox per gerarchia
- Colore default on: verde di sistema (modificabile ma usare colore contrastante)

### 4.2 Checkbox

- Stati: on / off / mixed (indicatore a trattino per mixed)
- Titolo al trailing del checkbox
- Allineamento al leading edge
- Stato on: **fill blu + checkmark bianco**

### 4.3 Radio Button

- 2–5 opzioni, mutuamente esclusive
- Selezionato: **cerchio pieno**

### 4.4 Text Field

- Placeholder text descrittivo (non solo "Cerca")
- Validare all'uscita dal campo
- Campo sicuro per password (input mascherato)
- Tooltip di espansione per testo troncato

### 4.5 Bottoni

- Titoli con **Title-Style caps** (verbi che descrivono l'azione)
- Stile prominent per azione chiave della vista
- Stile destructive (rosso) solo per azioni distruttive non intenzionali

### 4.6 Dropdown / Pop-up Button

- Mostra valore selezionato corrente
- Usare al posto di radio buttons quando ci sono **>5 opzioni**

### 4.7 Segmented Control

- 2–5 segmenti
- Per scelte mutuamente esclusive in contesti compatti

### 4.8 Tabelle e Liste

- Preferire testo nelle tabelle — formato ideale per scansione
- Click su intestazione colonna per ordinamento; secondo click = ordine inverso
- Permettere ridimensionamento colonne
- Considerare **colori di riga alternati** in tabelle multi-colonna
- Usare outline view con triangoli di disclosure per dati gerarchici

### 4.9 Progress Indicator

- Preferire **determinato** quando possibile
- Mantenere l'indicatore in movimento — se fermo sembra bloccato
- Spinner per operazioni in background o spazi ridotti

### 4.10 Alert

- Usare con **parsimonia** — solo informazioni essenziali
- Titolo chiaro e conciso (Title-Style se frammento, sentence-style se frase completa)
- 1–2 parole per bottoni, Title-Style caps
- Bottone default lato trailing, Cancel lato leading
- Supportare Escape/Cmd-Period per cancel
- Non usare alert all'avvio dell'app

### 4.11 Sheet

- Modale attaccata alla finestra parent
- Scorre dal top della finestra
- Includere Cancel/Close + bottone azione default (Save, Done)
- Mantenere focus — non sovraccaricare con troppi task

### 4.12 Finere (Windows)

| Stato | Aspetto |
|-------|---------|
| Main | Controlli titlebar colorati |
| Key | Controlli titlebar colorati |
| Inactive | Controlli titlebar grigi, no vibrancy |

### 4.13 Search Field

- Placeholder: descrivere il contenuto cercabile (non solo "Search")
- Cercare immediatamente mentre l'utente digita
- Posizionare lato trailing della toolbar
- In sidebar: in alto per filtrare contenuto della sidebar

### 4.14 Disclosure Controls

- Triangoli: destra (chiuso) → giù (aperto) — usati in outline view, liste
- Disclosure buttons: giù (nascosto) → su (visibile) — max 1 per vista

---

## 5. Stati Visivi dei Componenti

Ogni componente interattivo deve supportare questi stati macOS:

| Stato | Aspetto |
|-------|---------|
| **Normal** | Aspetto di riposo predefinito |
| **Hover** | Evidenziazione sottile o cambio cursore al passaggio mouse |
| **Pressed** | Aspetto più scuro/premuto durante il click |
| **Disabled** | Attenuato/grigio; non interattivo |
| **Selected/On** | Evidenziato, riempito, o con accento |
| **Focused** | Anello di focus blu (focus da tastiera) |
| **Mixed** | Indicatore trattino (checkbox) |

---

## 6. Accessibilità

### Contrasto

- Minimo testo normale: **4.5:1**
- Minimo testo grande/bold: **3:1**
- Ideale: **7:1**

### Dimensioni

- Target di tocco/click minimo: **28×28 pt** (raccomandato), **20×20 pt** (assoluto)
- Font minimo: **10 pt**

### Regole

- Ogni componente interattivo deve essere **accessibile via tastiera** (Full Keyboard Access, Switch Control)
- Fornire **accessibility labels** per tutti i controlli
- Non affidarsi solo al colore — supplementare con testo, forma, pattern
- Supportare VoiceOver con descrizioni contestuali
- Focus ring per text field, highlight per liste/collezioni

---

## 7. Pattern di Interazione macOS

### Avvio

- Ripristinare lo stato precedente — non splash screen
- Non mostrare alert all'avvio

### Onboarding

- Veloce e opzionale — l'utente deve poter saltare

### Settings

- Sempre **Cmd-,** dal menu App (mai dalla toolbar)
- Toolbar con pulsanti di pannello
- Attenuare pulsanti minimize/maximize nella finestra Settings

### Drag and Drop

- Muovere dentro lo stesso container, copiare tra container diversi
- Supportare drag da finestre inattive
- Mostrare badge per multi-item
- Verificare tasto Option al drop (copia vs sposta)
- Supportare spring loading
- Supportare undo per ogni operazione drag

### Undo/Redo

- **Cmd-Z** / **Shift-Cmd-Z** — sempre nel menu Edit
- Descrivere l'azione nel menu ("Undo Delete", non solo "Undo")

### Menu Bar

Ordine standard menus:
1. Menu App (nome dell'app, bold)
2. File
3. Edit
4. Format (se applicabile)
5. View
6. Menu specifici dell'app
7. Window
8. Help

- **Mostrare sempre gli stessi item** di menu — disabilitare quelli non disponibili, mai nasconderli
- Supportare tutte le scorciatoie standard (Cmd-Q, Cmd-W, Cmd-N, Cmd-S, ecc.)
- Menu titles: preferire una sola parola, Title-Style

### Tooltip

- Appaiono quando il puntatore staziona su un elemento
- Descrivere **l'azione** che il controllo inizia (iniziare con un verbo)
- Max **60–75 caratteri**, sentence case, senza punteggiatura finale
- Non ripetere il nome del controllo nel tooltip

---

## 8. Keyboard Shortcuts Standard

| Scorciatoia | Azione |
|-------------|--------|
| Cmd-, | Apri Settings |
| Cmd-Q | Esci |
| Cmd-W | Chiudi finestra |
| Cmd-N | Nuovo documento |
| Cmd-O | Apri |
| Cmd-S | Salva |
| Cmd-Z | Undo |
| Shift-Cmd-Z | Redo |
| Cmd-X/C/V | Taglia/Copia/Incolla |
| Cmd-A | Seleziona tutto |
| Cmd-F | Trova |
| Cmd-H | Nascondi app |
| Cmd-M | Minimizza finestra |
| Ctrl-Cmd-F | Schermo intero |
| Cmd-` | Cicla finestre dell'app |
| Cmd-? | Apri Help |

### Scorciatoie Personalizzate

- Solo per comandi **più frequenti** specifici dell'app
- Ordine modificatori: **Control, Option, Shift, Command**
- Preferire **Command** come modificatore principale
- Evitare **Control** (il sistema lo usa estensivamente)

---

## 9. Icona App

- Canvas: **1024×1024 px**
- Formato stratificato (layered)
- Strati quadrati senza maschera
- Ridurre complessità nelle dimensioni piccole
- Non replicare prodotti Apple

---

## 10. SF Symbols

### Modalità di Rendering

1. **Monochrome**: un colore, tutti i layer
2. **Hierarchical**: un colore, opacità variabile per livello
3. **Palette**: 2+ colori, uno per layer
4. **Multicolor**: colori intrinseci (es. `leaf` = verde)

### Varianti e Pesi

- 9 pesi: da Ultralight a Black (corrispondenti ai pesi SF Pro)
- 3 scale: Small, Medium (default), Large
- **Abbinare il peso del simbolo al peso del testo adiacente**
- **Outline**: senza aree piene, simile a testo — migliore per toolbar, liste
- **Fill**: aree piene, più enfasi — per tab bar, indicatori di selezione

### Animazioni

- Applicare con parsimonia — ogni animazione deve servire uno scopo chiaro
- Tipi disponibili: Appear, Disappear, Bounce, Scale, Pulse, Variable Color, Replace, Wiggle, Breathe, Rotate

---

## 11. Materiali e Liquid Glass

- **Liquid Glass**: layer funzionale distinto per controlli/navigazione
- **Non usare Liquid Glass nel layer dei contenuti**
- Usare con parsimonia — i componenti di sistema lo adottano automaticamente
- Due varianti: **Regular** (blur per leggibilità) e **Clear** (altamente translucido)
- Su macOS: blending modes **behind window** e **within window** (`NSVisualEffectView.BlendingMode`)

---

## 12. Checklist per Review Componenti Penpot

Per ogni componente nel kit di CubeLite, verificare:

- [ ] **Tipografia**: font SF Pro, dimensioni conformi alla tabella stili (§1)
- [ ] **Colori**: corrispondono ai colori semantici macOS; funzionano in light E dark (§2)
- [ ] **Contrasto**: minimo 4.5:1 per testo, 3:1 per testo grande/bold (§6)
- [ ] **Dimensioni**: controlli ≥ 28×28 pt raccomandato, ≥ 20×20 pt assoluto (§3)
- [ ] **Spaziatura**: padding conforme (12pt bezel, 24pt senza bezel) (§3)
- [ ] **Stati visivi**: Normal, Hover, Pressed, Disabled, Selected, Focused presenti (§5)
- [ ] **Allineamento**: allineamento leading edge, baseline consistente (§3)
- [ ] **Gerarchia label**: usa label/secondaryLabel/tertiaryLabel correttamente (§1)
- [ ] **Capitalizzazione**: Title-Style per bottoni e intestazioni, sentence-style per descrizioni
- [ ] **Icone**: SF Symbols con peso coerente al testo adiacente (§10)
- [ ] **Accessibilità**: nessuna informazione solo per colore; target accessibili (§6)
- [ ] **Regole componente**: conformità alle regole specifiche del componente (§4)

---

*Documento derivato dall'analisi di ~60 pagine Apple HIG (Foundations, Components, Patterns, Inputs).  
Riferimenti completi in `docs/apple-hig-summary.md`, `docs/apple-hig-components.md`, `docs/apple-hig-patterns-inputs.md`.*
