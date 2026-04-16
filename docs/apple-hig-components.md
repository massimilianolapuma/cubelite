# Apple HIG — macOS Component Design Rules

> Comprehensive reference extracted from Apple Human Interface Guidelines (April 2025).
> Some pages returned 502 errors and are marked with ⚠️ — their sections are based on
> cross-references found in other successfully fetched HIG pages.

---

## 1. SELECTION AND INPUT

### 1.1 Toggles (Switches, Checkboxes, Radio Buttons)

**Best Practices**
- Use a toggle to choose between **two opposing values** that affect the state of content or a view.
- Clearly identify the setting the toggle affects — surrounding context usually suffices.
- Make visual differences between on/off states **obvious** — don't rely solely on color.
- For buttons that behave like toggles, use an interface icon + change the background based on state.

**macOS-Specific Rules**

*Switches:*
- Prefer a switch for settings you want to **emphasize** — switches have more visual weight than checkboxes.
- Use a **mini switch** within grouped forms — its height matches buttons and other controls for consistent row height.
- Regular switch for primary settings; mini switches for subordinate settings within a hierarchy.
- Don't replace existing checkboxes with switches — keep what's already in the interface.

*Checkboxes:*
- Small square button: **empty** = off, **checkmark** = on, **dash** = mixed state.
- Title on the **trailing side**; in editable checklists, can appear without a title.
- Use checkboxes (not switches) to present a **hierarchy of settings** — they align well and communicate grouping via indentation.
- Align along the **leading edge**; use indentation to show dependencies.
- **Mixed state**: show when subordinate checkboxes have different states (e.g., a "Select All" that governs sub-options).
- States: On (blue fill + white checkmark), Off (empty square), Mixed (blue fill + white dash).

*Radio Buttons:*
- Small circular button + label. Typically in groups of **2–5**.
- State: **selected** (filled circle) or **deselected** (empty circle).
- Use for **mutually exclusive** options (more than just on/off).
- Avoid listing more than ~5 radio buttons — use a pop-up button instead.
- For a single on/off setting, prefer a checkbox.
- Use **consistent spacing** when displayed horizontally — measure from the longest label.

**Placement Rule**: Use switches, checkboxes, and radio buttons in the **window body, not the window frame** (no toolbars or status bars).

**API**: `Toggle` (SwiftUI), `NSButton.ButtonType.toggle`, `NSSwitch` (AppKit)

---

### 1.2 Text Fields

**Best Practices**
- Use for **small amounts** of information (name, email). Use text views for larger amounts.
- Show **placeholder text** (hint) describing purpose — it disappears when typing, so also include a separate label.
- Always use **secure text fields** for passwords/sensitive data (`SecureField`).
- **Size the field** to match anticipated text quantity.
- Space multiple fields evenly; **stack vertically** when possible with consistent widths.
- **Tab order** should flow logically.
- **Validate** when appropriate (on field exit for email; before exit for username/password).
- Use **number formatters** for numeric fields.
- Line breaks: default clips; options for word-wrap, character-wrap, or truncation (beginning/middle/end).
- Use **expansion tooltips** to show full text for clipped/truncated content.

**macOS-Specific**
- Consider a **combo box** if you need text input paired with a list of choices.

**API**: `TextField`, `SecureField` (SwiftUI), `NSTextField` (AppKit)

---

### 1.3 Pickers

**Best Practices**
- Use for **medium-to-long lists**. For short lists, use pull-down buttons; for very large sets, use lists/tables.
- Values should be **predictable and logically ordered** (e.g., alphabetized countries).
- Avoid switching views to show a picker — display **in context** (below/near the edited field) or in a popover.
- For minute pickers, consider **less granularity** (e.g., 15-minute intervals).

**macOS-Specific**
- Two date picker styles: **textual** (compact, precise) and **graphical** (calendar browsing, date ranges, clock face).

**API**: `Picker`, `DatePicker` (SwiftUI), `NSDatePicker` (AppKit)

---

### 1.4 Sliders ⚠️

**Best Practices** (from cross-references)
- Use to select a value from a continuous range.
- Include **minimum and maximum value labels** at each end.
- Optional: display the current value.
- A slider works best for settings where **relative position** matters more than exact values — for precise numeric input, pair with a text field or use a stepper.

**API**: `Slider` (SwiftUI), `NSSlider` (AppKit)

---

### 1.5 Steppers ⚠️

**Best Practices** (from cross-references)
- A stepper is a pair of +/− buttons for **incrementing/decrementing** a value.
- Always pair with a **text field or label** that displays the current value.
- Define **reasonable min/max bounds**.
- Useful when precision matters and the range is modest.

**API**: `Stepper` (SwiftUI), `NSStepper` (AppKit)

---

### 1.6 Color Wells ⚠️

**Best Practices** (from cross-references)
- A color well opens the system **Colors panel** for color selection.
- macOS only component.
- Display the currently selected color in the well.

**API**: `ColorPicker` (SwiftUI), `NSColorWell` (AppKit)

---

### 1.7 Segmented Controls ⚠️

**Best Practices** (from cross-references)
- Provide **two to five segments** — each represents a mutually exclusive option.
- Use for switching between views, filtering content, or sorting.
- Each segment should have a **short label or icon** — don't mix text and icons.
- All segments should have **equal width** when using text labels.
- The selected segment should be visually distinct.
- Use in toolbars, below navigation, or inline with content.

**API**: `Picker` with `.segmented` style (SwiftUI), `NSSegmentedControl` (AppKit)

---

## 2. MENUS AND ACTIONS

### 2.1 Buttons ⚠️

**Best Practices** (from cross-references and toolbar/alert sections)
- Use **verbs or verb phrases** — "Save", "Cancel", "Delete".
- Use **title-style capitalization**, no ending punctuation.
- Use the `.prominent` style for key actions (Done, Submit) — place on **trailing side**.
- Use the **destructive style** for buttons that perform actions people didn't deliberately choose.
- macOS button types: push buttons, help buttons (question mark circle), gradient buttons.
- Help buttons: round button with a question mark; opens context-specific help or documentation.

**API**: `Button` (SwiftUI), `NSButton` (AppKit)

---

### 2.2 Toolbars

**Best Practices**
- Don't overcrowd — define which items move to the **overflow menu** when the toolbar narrows.
- The system automatically adds an overflow menu in macOS — don't add one manually.
- Add a **More menu** for additional actions; include all actions if possible.
- Let people **customize** the toolbar (add/remove/rearrange items) — especially in apps with many actions.
- Reduce toolbar backgrounds and tinted controls — use the content layer to inform color.
- Prefer **standard components** with concentric corner radii.
- Consider temporarily hiding toolbars for **distraction-free** experiences.

**Titles**
- Provide a useful title for each window — don't use the **app name** as title.
- Write **concise titles** — aim for under 15 characters.

**Navigation**
- Use standard **Back** and **Close** buttons — prefer standard symbols, no text labels.

**Actions**
- Prioritize most important commands.
- Prefer **simple, recognizable symbols** over text for toolbar items.
- Use **system-provided symbols without borders** — the section provides a visible container.
- Use `.prominent` style for one primary action (Done/Submit) on the **trailing side**.

**Item Groupings — Three Locations:**
1. **Leading edge**: Back, sidebar toggle, view title, document menu. Not customizable.
2. **Center area**: Common controls. Customizable by users. Collapses to overflow when window shrinks.
3. **Trailing edge**: Important persistent items, inspector buttons, search field, More menu, primary action. Remains visible at all sizes.
- Maximum **3 groups**; group by function and frequency.
- Keep text-labeled actions **separate** from symbol-labeled actions.

**macOS-Specific**
- Toolbar lives in the **window frame** (top), below or integrated with title bar.
- Items **don't include a bezel**.
- Every toolbar item must also be available as a **menu bar command**.
- Not every menu item needs a toolbar item.

**API**: `NSToolbar` (AppKit), SwiftUI `Toolbars`

---

### 2.3 Menus ⚠️

**Best Practices** (from cross-references)
- Organize items logically; group related items with **separator lines**.
- Include **keyboard shortcuts** for frequently used items.
- Use **sentence-style capitalization** or **title-style** as appropriate.
- Dim (disable) items that don't apply to the current context — don't remove them.
- Use **ellipsis (…)** after items that require additional information before executing.

---

### 2.4 Context Menus ⚠️

**Best Practices** (from cross-references)
- Triggered via right-click (Control-click on macOS).
- Include only the **most relevant actions** for the clicked item.
- Keep menus **short and focused**.
- Don't make context menus the only way to access important actions.

---

### 2.5 Pop-up Buttons ⚠️

**Best Practices** (from cross-references)
- Display a **single selected value** from a list of mutually exclusive choices.
- Use instead of radio buttons when there are **more than ~5 options**.
- The button label shows the **currently selected item**.
- Good for settings panels where space is limited.

**API**: `Picker` with `.menu` style (SwiftUI), `NSPopUpButton` (AppKit)

---

### 2.6 Pull-down Buttons ⚠️

**Best Practices** (from cross-references)
- Display a menu of **actions** (not selections) — the button title doesn't change.
- Use to group related actions under a single button.
- Show the most important action first.
- Avoid in visionOS toolbars (may obscure window controls).

**API**: `Menu` (SwiftUI), `NSPopUpButton` with pull-down behavior (AppKit)

---

## 3. LAYOUT AND ORGANIZATION

### 3.1 Tab Views ⚠️

**Best Practices** (from cross-references)
- Use to organize content into **distinct sections** within the same view.
- Each tab should have a **short, descriptive label**.
- Place **most frequently used** tab first.
- macOS uses top or bottom positioned tabs.

**API**: `TabView` (SwiftUI), `NSTabView` (AppKit)

---

### 3.2 Split Views

**Best Practices**
- Persistently **highlight the current selection** in each pane that leads to the detail view.
- Consider letting people **drag and drop** content between panes.

**macOS-Specific**
- Panes can be arranged **vertically, horizontally, or both**.
- Includes **dividers** between panes that support dragging to resize.
- Set **reasonable min/max pane sizes** — keep dividers visible.
- Let people **hide a pane** for distraction-free editing (e.g., Keynote navigator).
- Provide **multiple ways** to reveal hidden panes (toolbar button, menu command, keyboard shortcut).
- Prefer the **thin divider style** (1pt) — maximum space for content.
- Only use thicker dividers when strong linear elements might obscure a thin one.

**API**: `NavigationSplitView`, `VSplitView`, `HSplitView` (SwiftUI), `NSSplitViewController` (AppKit)

---

### 3.3 Lists and Tables

**Best Practices**
- Prefer displaying **text** in lists/tables — the row format is ideal for scanning.
- Let people **edit** tables (reorder, select) when it makes sense.
- Provide appropriate **selection feedback** — persistent highlight for navigation, brief highlight + checkmark for options.
- Use **descriptive column headings** with title-style capitalization, no ending punctuation.

**macOS-Specific**
- Let people **click column headings** to sort; re-sort in opposite direction on second click.
- Let people **resize columns**.
- Consider **alternating row colors** in multicolumn tables for tracking across wide rows.
- Use an **outline view** (with disclosure triangles) for hierarchical data instead of a flat table.

**Styles**: macOS defines a **bordered style** with alternating row backgrounds for large tables.

**API**: `List`, `Table` (SwiftUI), `NSTableView` (AppKit)

---

### 3.4 Sidebars

**Best Practices**
- Extend content **beneath the sidebar** (use background extension effect in Liquid Glass layer).
- Let people **customize** sidebar contents.
- Group hierarchy with **disclosure controls** for lots of content.
- Use **SF Symbols** for sidebar items.
- Let people **hide/show** the sidebar — don't hide by default.
- Show **no more than two levels** of hierarchy; for deeper hierarchies, use a split view with content list.
- Use **succinct, descriptive labels** for group titles.

**macOS-Specific**
- Sidebar row height, text, and glyph size depend on **overall size** (small/medium/large) — people can change this in General settings.
- Don't fix icon colors — let them use the user's **accent color** by default.
- Consider **auto-hiding/revealing** sidebar when the container window resizes.
- Avoid putting critical info or actions at the **bottom** of a sidebar.

**API**: `NavigationSplitView` (SwiftUI), `NSSplitViewController` (AppKit)

---

### 3.5 Labels

**Best Practices**
- Use for **small amounts of uneditable text**. Use text field for editable, text view for large amounts.
- Prefer **system fonts**; support Dynamic Type.
- Use system-provided **label colors** for visual hierarchy:
  | Level | Purpose | SwiftUI | AppKit |
  |-------|---------|---------|--------|
  | Label | Primary information | `label` | `labelColor` |
  | Secondary Label | Subheading/supplemental | `secondaryLabel` | `secondaryLabelColor` |
  | Tertiary Label | Unavailable item/behavior | `tertiaryLabel` | `tertiaryLabelColor` |
  | Quaternary Label | Watermark text | `quaternaryLabel` | `quaternaryLabelColor` |
- Make useful label text **selectable** (error messages, IP addresses, etc.) for copy/paste.

**macOS-Specific**
- Use `isEditable` property of `NSTextField` to display uneditable text in a label.

**API**: `Label`, `Text` (SwiftUI), `NSTextField` (AppKit)

---

### 3.6 Disclosure Controls

**Best Practices**
- Use to **hide details until they're relevant**.
- Place most-used controls at the **top** of the disclosure hierarchy, advanced functionality hidden.

**Disclosure Triangles** (macOS-primary)
- Point **right** when collapsed, **down** when expanded.
- Used in outline views, lists, and option sections.
- `NSButton.BezelStyle.disclosure` (AppKit)

**Disclosure Buttons** (macOS-primary)
- Show/hide functionality associated with a specific control.
- Point **down** when hidden, **up** when visible.
- Place **near the content** it shows/hides.
- Use **no more than one** disclosure button in a single view.
- `NSButton.BezelStyle.pushDisclosure` (AppKit)

**API**: `DisclosureGroup` (SwiftUI)

---

## 4. NAVIGATION AND SEARCH

### 4.1 Search Fields

**Best Practices**
- Display **placeholder text** describing searchable content (not just "Search").
- Start searching **immediately** as people type when possible.
- Show **suggested search terms** before/during search.
- Simplify results — prioritize most relevant; consider **categorized** results.
- Let people **filter** results (scope controls).

**Scope Controls and Tokens**
- **Scope control**: acts like a segmented control for choosing a search category.
- **Token**: visual representation of a search term that acts as a filter.
- Default to a **broader scope** — let people refine.

**macOS-Specific (iPadOS, macOS combined)**
- Place search field at the **trailing side of the toolbar** for common uses.
- Include search at **top of sidebar** when filtering sidebar content/navigation.
- Include search as a **sidebar or tab bar item** for dedicated discovery areas.
- Account for **window resizing** with field placement.

**API**: `searchable(text:placement:prompt:)` (SwiftUI), `NSSearchField` (AppKit)

---

### 4.2 Navigation Bars → Toolbars

**Note**: As of WWDC 2025, Apple consolidated navigation bar guidance into the **Toolbars** page. The navigation bar URL now redirects to Toolbars. See Section 2.2 above.

---

## 5. PRESENTATION

### 5.1 Alerts

**Best Practices**
- Use **sparingly** — each alert should offer only essential information and useful actions.
- Don't use alerts merely to provide information — find alternative in-context methods.
- Don't alert for **common, undoable** destructive actions (e.g., deleting an email).
- Don't show alerts **at app startup** — design discoverable alternatives.

**Content**
- Title: **clearly and succinctly** describe the situation. Title-style capitalization for fragments; sentence-style for full sentences.
- Informative text: only if it **adds value**; keep as short as possible.
- Don't explain button actions in the alert text.
- macOS alerts can include: **suppression checkbox**, **Help button**, **accessory view**, **icon/symbol**.

**Buttons**
- 1–2 word titles using **title-style capitalization**.
- Use verbs that relate to the alert text ("View All", "Reply", "Ignore").
- Avoid "OK" unless purely informational; use "Cancel" for cancellation.
- Default button on **trailing side** of row or **top** of stack.
- Cancel button on **leading side** of row or **bottom** of stack.
- **Destructive style**: only when the button performs a destructive action the user didn't deliberately choose.
- Include Cancel to give a safe escape from destructive actions.
- Support Escape/Cmd-Period to cancel.

**macOS-Specific**
- System auto-displays the **app icon** in alerts (you can supply an alternative).
- Support **repeating alert suppression**.
- Use **caution symbol** (`exclamationmark.triangle`) sparingly — only when extra attention is truly needed.

**API**: `alert(_:isPresented:actions:)` (SwiftUI), `NSAlert` (AppKit)

---

### 5.2 Sheets ⚠️

**Best Practices** (from cross-references)
- A sheet is a **modal view** attached to a parent window.
- Use for focused tasks that require completion or dismissal before returning.
- Include a **Cancel** or **Close** button.
- Include a **default action** button (e.g., Save, Done).
- Keep sheets **focused** — don't overload with too many tasks.
- Sheets slide down from the **top** of the parent window in macOS.

**API**: `sheet(isPresented:content:)` (SwiftUI), `NSWindow.beginSheet()` (AppKit)

---

### 5.3 Windows

**Best Practices**
- Ensure windows **adapt fluidly** to different sizes for multitasking.
- Choose the **right moment** to open new windows — avoid excessive clutter.
- Offer the option to view content in a new window via **context menu** or File menu.
- Don't create **custom window UI** — use system-provided frames and controls.
- Use the term **"window"** in user-facing content (not "scene").

**macOS-Specific**

*Window Anatomy:*
- **Frame**: top area with window controls and toolbar. Can include a bottom bar (rare).
- **Body**: main content area below the frame.
- Move by dragging frame; resize by dragging edges.

*Window States:*
| State | Description | Appearance |
|-------|-------------|------------|
| **Main** | Frontmost window of the app (one per app) | Colored title bar controls |
| **Key** | Active window accepting input (one system-wide) | Colored title bar controls |
| **Inactive** | Background window | Gray title bar controls, no vibrancy |

- Custom windows must use **system-defined appearances** for each state.
- Avoid critical info in the **bottom bar** — people often hide the bottom edge.
- For small info, use a **status bar**; for more, use an **inspector** (trailing split view pane).

**API**: `WindowGroup` (SwiftUI), `NSWindow` (AppKit)

---

## 6. STATUS

### 6.1 Progress Indicators

**Best Practices**
- Prefer **determinate** indicators when possible — helps people estimate wait time.
- Be **accurate** with advancement pace — avoid 90% in 5 seconds then 10% in 5 minutes.
- Keep indicators **moving** — stationary = stalled perception.
- Switch from **indeterminate to determinate** when duration becomes known.
- Don't switch between **circular and bar** styles — it disrupts the interface.
- Display in a **consistent location**.
- Let people **halt processing** (Cancel button; Pause if interruption has side effects).

**Types:**
- **Determinate**: bar (fills leading→trailing) or circular (fills clockwise).
- **Indeterminate**: spinner (circular animation) or animated bar (macOS only).

**macOS-Specific**
- Both bar and circular **indeterminate** styles available.
- Prefer a **spinner** for background operations or constrained spaces (within text fields, next to buttons).
- Avoid **labeling** a spinner — it's usually initiated by user action.

**API**: `ProgressView` (SwiftUI), `NSProgressIndicator` (AppKit)

---

### 6.2 Gauges

**Anatomy**
- Circular or linear path representing a range of values.
- Standard: indicator at current value. Capacity: fill up to current value.

**Best Practices**
- Write **succinct labels** for current value and range endpoints (VoiceOver reads them).
- Consider **gradient fills** to communicate purpose (e.g., red→blue for temperature).

**macOS-Specific — Level Indicators**
- macOS also supports **level indicators** (in addition to gauges):
  - **Continuous**: horizontal translucent track with solid fill bar.
  - **Discrete**: horizontal row of separate rectangular segments.
- Use **continuous** for large ranges.
- Default fill color: **green**. Change to indicate significant levels.
- **Tiered state**: show a sequence of colors in one indicator (e.g., red→yellow→green).
- **Relevance style**: shaded horizontal bar for search result relevancy (rare).

**API**: `Gauge` (SwiftUI), `NSLevelIndicator` (AppKit)

---

## 7. CONTENT

### 7.1 Charts

**Anatomy**: marks, axes, grid lines, ticks, labels, legends, annotations.

**Mark Types**
- **Bar marks**: compare values across categories; good for sums (e.g., daily steps).
- **Line marks**: show change over time; slope reveals magnitude of change.
- **Point marks**: individual values; show relationships, outliers, clusters.
- **Combine mark types** when it adds clarity (e.g., line + points).

**Axes**
- **Fixed range**: when min/max are meaningful (e.g., 0–100% battery).
- **Dynamic range**: when values vary widely and marks should fill the plot area.
- Use **familiar value sequences** for ticks (0, 5, 10... not 1, 6, 11...).
- Tailor grid line **density** to use case — too many overwhelm; too few hamper estimation.

**Best Practices**
- Make data **most prominent** — descriptions/axes provide context without competing.
- **Maximize plot area width** in compact environments.
- Make every chart **accessible** — support VoiceOver, Audio Graphs.
- Let people **interact** with data when sensible (scrub to reveal values), but don't require it for critical info.
- Expand **hit targets** to full plot area when marks are too small.
- Support keyboard/Switch Control navigation.
- **Animate** important changes (marks, axes) and also communicate non-visually.
- **Align** chart leading edge with surrounding interface elements.

**Color**
- Don't rely **solely on color** to differentiate data — use shapes/patterns too.
- Add **visual separation** between contiguous color areas (separators in stacked bars).

**Accessibility**
- Support **Audio Graphs** — provides tones representing data values and trends.
- Write **accessibility labels** that support the chart's purpose.
- Prioritize **clarity** — include context (date, location) with values.
- Avoid **subjective terms** (rapidly, gradually); use actual values.
- Spell out abbreviations (60 minutes, not 60m).
- Describe **what data represents**, not what it looks like.
- **Hide** visible axis/tick labels from assistive technologies.

**API**: `Swift Charts` framework

---

## 8. CROSS-CUTTING RULES

### Accessibility
- Every interactive component must be **keyboard accessible** (Full Keyboard Access, Switch Control).
- Provide **accessibility labels** for all controls.
- Support **Dynamic Type** where applicable.
- Don't rely solely on **color** to convey meaning — supplement with text, shape, or pattern.
- Label values for VoiceOver should be **descriptive and contextual**.

### Visual States
Across all components, the common macOS visual states are:
| State | Appearance |
|-------|------------|
| **Normal** | Default resting appearance |
| **Hover** | Subtle highlight or cursor change on mouse-over |
| **Pressed** | Darker/depressed appearance during click |
| **Disabled** | Dimmed/grayed out; non-interactive |
| **Selected/On** | Highlighted, filled, or accented appearance |
| **Focused** | Blue focus ring (keyboard focus) |
| **Mixed** | Dash indicator (checkboxes) |

### Spacing and Layout Principles
- Use **system-provided spacing** and layout guides.
- Align controls to a **consistent grid** — leading edges, baselines.
- Group related controls with **consistent spacing**.
- Stack form fields **vertically**; use consistent widths per group.
- macOS sidebar sizes: **small, medium, large** — set by user in System Settings.
- Toolbar items should be grouped into **leading, center, trailing** sections.
- Maximum **3 toolbar groups**.
- Split view divider: prefer **1pt thin style**.

### Typography
- Use **system fonts** by default.
- Label hierarchy: label → secondaryLabel → tertiaryLabel → quaternaryLabel.
- Button titles: **title-style capitalization**, no ending punctuation.
- Alert titles: sentence-style if complete sentence; title-style if fragment.
- Column headings: **title-style capitalization**, no ending punctuation.

### Color and Theming
- Support **both Light and Dark** appearances.
- Use **semantic colors** (labelColor, secondaryLabelColor, etc.) for automatic theme adaptation.
- Default accent color: **user's system preference**. Don't fix sidebar icon colors.
- Destructive actions: use the **destructive button style** (red), but only for unintended destructive actions.
- Switch default color: system green (changeable, but use a contrasting color).
- Checkbox on state: **blue fill + white checkmark**.
- Radio button selected: **filled circle**.

---

## API Quick Reference (macOS / AppKit + SwiftUI)

| Component | SwiftUI | AppKit |
|-----------|---------|--------|
| Toggle/Switch | `Toggle` | `NSSwitch` |
| Checkbox | `Toggle` + `.checkbox` style | `NSButton` (.toggle type) |
| Radio Button | `Picker` + `.radioGroup` style | `NSButton` (.radio type) |
| Text Field | `TextField`, `SecureField` | `NSTextField` |
| Picker | `Picker`, `DatePicker` | `NSDatePicker` |
| Slider | `Slider` | `NSSlider` |
| Stepper | `Stepper` | `NSStepper` |
| Color Well | `ColorPicker` | `NSColorWell` |
| Segmented Control | `Picker` + `.segmented` style | `NSSegmentedControl` |
| Button | `Button` | `NSButton` |
| Toolbar | `toolbar {}` modifier | `NSToolbar` |
| Pop-up Button | `Picker` + `.menu` style | `NSPopUpButton` |
| Pull-down Button | `Menu` | `NSPopUpButton` (pull-down) |
| Search Field | `.searchable()` | `NSSearchField` |
| Tab View | `TabView` | `NSTabView` |
| Split View | `NavigationSplitView`, `HSplitView`, `VSplitView` | `NSSplitViewController` |
| Table | `Table`, `List` | `NSTableView` |
| Sidebar | `NavigationSplitView` + `.sidebar` | `NSSplitViewController` |
| Label | `Label`, `Text` | `NSTextField` (non-editable) |
| Disclosure | `DisclosureGroup` | `NSButton` (.disclosure) |
| Alert | `.alert()` modifier | `NSAlert` |
| Sheet | `.sheet()` modifier | `NSWindow.beginSheet()` |
| Window | `WindowGroup` | `NSWindow` |
| Progress | `ProgressView` | `NSProgressIndicator` |
| Gauge | `Gauge` | `NSLevelIndicator` |
| Chart | `Swift Charts` | `Swift Charts` |

---

*Document generated from Apple HIG pages fetched April 2025. Pages that returned 502 errors (Buttons, Segmented Controls, Sliders, Steppers, Color Wells, Sheets, Tab Views, Menus, Context Menus, Pop-up Buttons, Pull-down Buttons) are noted with ⚠️ and supplemented from cross-references.*
