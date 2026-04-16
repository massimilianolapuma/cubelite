# Apple HIG — Patterns & Inputs (macOS Focus)

Comprehensive extraction from Apple Human Interface Guidelines.
Source: developer.apple.com/design/human-interface-guidelines

---

## 1. Launching

- Design a streamlined launch that lets people use the app immediately
- Don't require setup at launch — let people jump into the experience
- Restore previous state so people can pick up where they left off
- Avoid showing splash screens or "about" information at launch
- No additional macOS-specific considerations (macOS launches are inherently fast with window restoration)

---

## 2. Onboarding

- Make onboarding **fast, fun, and optional** — people should understand the app by experiencing it
- Onboarding occurs **after** launching is complete; it is NOT part of the launch experience
- Provide only the information people need to get started — avoid tutorials for obvious features
- Let people skip or dismiss onboarding at any time
- Don't frontload all features; reveal complexity gradually
- Avoid requesting permissions during onboarding unless absolutely necessary for core functionality
- No additional macOS-specific considerations

---

## 3. Modality

- **Use modality only when necessary** — it forces people to stop their current task
- Prefer nonmodal alternatives (inline editing, popovers) when possible
- Always provide an obvious, safe way to **dismiss** a modal experience
- Keep modal tasks **simple, short, and narrowly focused**
- Use sheets (attached to parent window) for modal input in macOS
- Use alerts sparingly — only for **critical, actionable information**
- **macOS modal types**: Sheets (document-modal), Alerts, Popovers, Panels
- Related APIs: `NSWindow` modal windows and panels (AppKit)

---

## 4. Managing Accounts

- **Only require an account if core functionality demands it** — otherwise let people use the app without one
- Prefer **Sign in with Apple** for consistent, trusted sign-in
- Delay sign-in as long as possible — let people explore first
- Explain the **value** of creating an account
- Support account deletion (required by App Store guidelines)
- No additional macOS-specific considerations

---

## 5. Entering Data

- **Minimize data entry** — pre-gather information wherever possible
- Support **all available input methods** (keyboard, paste, drag-and-drop)
- Use appropriate field types (date pickers, pop-up menus) to reduce errors
- Provide **sensible defaults** to minimize typing
- Validate input inline and provide clear error messages
- **macOS-specific**: Use **expansion tooltips** to show the full version of clipped/truncated text in a field (appears on hover)

---

## 6. Searching

- Use system search fields for consistent experience
- Support **Cmd-F** (Find in document) and **Cmd-Shift-F** (systemwide) patterns
- Start filtering results **as people type** — don't wait for Enter
- Show **recent searches** and **suggestions** to help people
- Support **scope controls and tokens** for filtering by attributes (date, size, type)
- Index your app's content for **Spotlight** so people can find it without opening the app
- Provide **clear, helpful empty states** when no results are found

---

## 7. Settings

### macOS-Specific Rules:
- Open settings window from **App menu → Settings** (Cmd-,)
- **Never** add a Settings button to a window toolbar — it wastes space for essential commands
- Settings window uses a **toolbar with buttons** to switch between panes
- **Dim the minimize and maximize buttons** on the settings window
- Document-level options go in the **File menu**, not Settings
- Settings window accommodates the size of the current pane — no need to keep it in the Dock
- Standard shortcut: **Cmd-,** opens settings

---

## 8. Drag and Drop

### Best Practices:
- **Support drag and drop throughout your app** — people try it everywhere
- Offer **alternative ways** (menu commands, copy/paste) for the same actions
- **Move** within the same container; **Copy** between different containers
- Support **multi-item drag** when it makes sense
- Prefer letting people **undo** drag-and-drop operations
- Offer **multiple content representations** (highest to lowest fidelity)
- Support **spring loading** (activate controls by dragging over them)

### Feedback Rules:
- Display a **translucent drag image** immediately (~3pt of drag)
- Show whether a destination **can accept** dragged content (highlight valid destinations)
- Show "not allowed" feedback (circle.slash) for invalid destinations
- When a drop fails, animate the item **back to source** or fade it out
- Provide **progress feedback** for time-consuming transfers

### macOS-Specific:
- Let people drag content from your app **into the Finder** (as appropriate file types)
- Let people drag selected content from an **inactive window** without making it active first
- Let people drag individual items from inactive windows **without affecting existing selection**
- Display a **badge** (count oval) during multi-item drag operations
- **Change pointer appearance** to indicate drop result (copy, link, disappearing item, not allowed)
- Let people **select and drag content with a single motion** (no pause between select and drag)
- Check for **Option key at drop time** — Option forces copy within same container

### Drop Acceptance:
- Auto-scroll destination content when people drag over it
- Pick the **richest version** of dropped content your app can accept
- Extract only the **relevant portion** of dropped content
- Apply appropriate **text styling** to dropped text
- **Maintain selection state** after a drop

---

## 9. Undo and Redo

### Best Practices:
- Help people **predict results** of undo/redo — describe the action in menu item labels (e.g., "Undo Typing", "Redo Bold")
- **Show results** — scroll to reveal restored content if it's offscreen
- Let people **undo multiple times** without unnecessary limits
- Consider **batch undo** for related incremental changes
- Only provide dedicated undo/redo buttons if necessary; people expect system-supported ways

### macOS-Specific:
- Place Undo and Redo in the **Edit menu** at the top
- Support standard shortcuts: **Cmd-Z** (undo), **Shift-Cmd-Z** (redo)

---

## 10. Feedback

### Best Practices:
- Make **all feedback accessible** — use color, text, sound, and haptics together
- Integrate **status feedback inline** near the items it describes
- Use **alerts only for critical, actionable information** — overuse dilutes impact
- **Warn** when actions can cause unexpected, irreversible data loss
- **Don't warn** when data loss is the expected result (e.g., deleting a file in Finder)
- Confirm **significant completed actions** (e.g., successful payment)
- Show people when a command **can't be carried out** and explain why
- No additional macOS-specific considerations

---

## 11. Loading

### Best Practices:
- **Show something immediately** — don't make people wait for a blank screen
- Use **placeholder content** (text, graphics, animations) while loading
- Let people **do other things** while content loads in the background
- For long loads, show **interesting content** (tips, features) while waiting
- Use **determinate progress indicators** when you know the duration
- Use **indeterminate progress indicators** when you don't
- No additional macOS-specific considerations

---

## 12. Managing Notifications

### Best Practices:
- Get **permission** before sending any notification
- Accurately represent **urgency** — don't abuse interruption levels
- Use **Time Sensitive** only for events happening now or within an hour
- **Never** use Time Sensitive for marketing notifications
- Get **explicit opt-in** before sending marketing/promotional notifications
- Provide **in-app settings** to manage notification preferences

### Interruption Levels:
| Level | Breaks Focus | Breaks Scheduled Delivery | Overrides Silent |
|-------|-------------|--------------------------|-----------------|
| Passive | No | No | No |
| Active (default) | No | No | No |
| Time Sensitive | Yes | Yes | No |
| Critical | Yes | Yes | Yes |

- No additional macOS-specific considerations

---

## 13. Offering Help

### Best Practices:
- Let **tasks inform help types** — inline descriptions for simple tasks, tutorials for complex ones
- Use **relevant, consistent language** and images for the platform
- Make help content **inclusive**
- Don't explain how **standard components work** — explain the specific action in your app
- Help should be **easy to dismiss**

### Tips (TipKit):
- Use tips for **simple features** only (≤3 actions)
- Keep tips to **1–2 sentences**, actionable and engaging
- Define **display rules** so tips only show to the intended audience
- Set **frequency** (e.g., once per 24 hours) to avoid overwhelming people
- Use **filled variant** symbols in tips
- Don't repeat an image in both the tip and the UI element it points to

### macOS-Specific — Tooltips (Help Tags):
- Tooltips appear when the **pointer rests on an element**
- Describe **only the control** that people are interested in
- Explain the **action** the control initiates (start with a verb)
- **Don't repeat** the control's name in its tooltip
- Be brief: **60–75 characters maximum**
- Use **sentence case**; omit ending punctuation
- Offer **context-sensitive tooltips** for different control states
- Help menu: provide Help Book format documentation for searchable help

---

## 14. Playing Haptics

### macOS-Specific (Magic Trackpad):
Three available haptic patterns for drag operations or force clicks:

| Pattern | Use Case |
|---------|----------|
| **Alignment** | Dragged item aligns with another shape; reaching min/max of a scrubber |
| **Level change** | Movement between discrete pressure levels (e.g., fast-forward speed) |
| **Generic** | General feedback when other patterns don't apply |

- Use `NSHapticFeedbackPerformer` (AppKit)

### General Rules:
- Use system haptics according to **documented meanings**
- Use haptics **consistently** — build cause-and-effect relationships
- **Complement** visual and auditory feedback with haptics
- **Avoid overusing** haptics — test for balance
- Make haptics **optional** — let people turn them off

---

## 15. File Management

### Creating and Opening:
- Use **app menus and keyboard shortcuts** for New/Open
- macOS: "New" and "Open" go in the **File menu**
- Support **Open Recent** submenu (list files by name, not path; most recent first)
- Include a **Clear Menu** item in Open Recent

### Saving:
- **Auto-save** periodically — don't require explicit save actions
- Hide file extensions by default; let people view them optionally
- Show **unsaved changes** with a dot on the close button and in the Window menu (when autosave is off)
- Append "Edited" to the title bar for unsaved changes

### macOS-Specific:
- Use the **default file browser** (Finder-like) unless you have a strong reason to customize
- Custom file-opening: provide **"open recent"** and **multi-file selection**
- Customize the Open button title to reflect the task (e.g., "Insert")
- Save: default to "Untitled", let people name and choose location
- Consider **extending the Save dialog** with custom accessory views
- Support **Finder Sync extensions** for sync status badges and contextual menu items
- When autosave is off: show a **dot on the close button** and confirm save on close/quit

### Quick Look:
- Implement a **Quick Look viewer** to preview files your app can't open
- Implement a **Quick Look generator** for custom file types (visible in Finder, Files, Spotlight)

---

## 16. Going Full Screen

### Best Practices:
- Support full-screen mode when it makes sense (games, media, in-depth tasks)
- **Don't programmatically resize** the window — adjust layout proportionally
- Keep **essential features accessible** without exiting full-screen
- Let people reveal the **Dock** in full-screen mode (except in games)
- **Pause** and restore state when people leave/return to full-screen
- Let people **choose when to exit** — don't end full-screen automatically

### macOS-Specific:
- Use the **system-provided full-screen experience** (`toggleFullScreen(_:)`)
- **Don't change display mode** when going full-screen in games
- Let people use the **Enter Full Screen button**, **View menu**, or **Ctrl-Cmd-F**
- Avoid custom "window mode" menus
- In games, provide a custom toggle for full-screen on/off
- The menu bar **hides** in full-screen; people reveal it by moving the pointer to the top

---

## 17. The Menu Bar

### Menu Order (Standard):
1. **Apple menu** (system, leading side)
2. **App menu** (your app name, bold)
3. **File**
4. **Edit**
5. **Format**
6. **View**
7. **App-specific menus**
8. **Window**
9. **Help**
10. **Menu bar extras** (trailing side)

### Best Practices:
- Support **default system-defined menus and their ordering**
- **Always show the same set of menu items** — dim unavailable items, don't hide them
- Use **familiar icons** for common actions
- Support **standard keyboard shortcuts** for standard menu items
- Prefer **short, one-word menu titles** (title-style capitalization if multi-word)

### App Menu:
- About YourAppName (first, with separator after)
- Settings… (Cmd-,) — app-level settings only
- Custom app-configuration items
- Services (macOS only)
- Hide YourAppName / Hide Others / Show All
- Quit YourAppName (Option changes to "Quit and Keep Windows")

### File Menu:
- New, Open, Open Recent, Close, Save, Save All, Duplicate, Rename…, Move To…, Export As…, Revert To, Page Setup…, Print…
- **Auto-save** periodically; prompt for name/location on first save
- Prefer **Duplicate** over Save As/Export/Copy To
- Save in multiple formats via **pop-up menu** in the Save sheet

### Edit Menu:
- Undo (Cmd-Z), Redo (Shift-Cmd-Z)
- Cut, Copy, Paste, Paste and Match Style
- Delete (not "Erase" or "Clear")
- Select All
- Find (submenu: Find, Find and Replace, Find Next, Find Previous, Use Selection for Find, Jump to Selection)
- Spelling and Grammar, Substitutions, Transformations, Speech
- Start Dictation, Emoji & Symbols (system-added automatically)

### View Menu:
- Show/Hide Tab Bar, Show All Tabs/Exit Tab Overview
- Show/Hide Toolbar, Customize Toolbar
- Show/Hide Sidebar
- Enter/Exit Full Screen
- **Always reflect current state** in show/hide item titles

### Window Menu:
- Minimize (Option → Minimize All)
- Zoom (Option → Zoom All) — **not** for full-screen; that's View menu
- Show Previous/Next Tab, Move Tab to New Window, Merge All Windows
- Enter/Exit Full Screen (only if no View menu)
- Bring All to Front (Option → Arrange in Front)
- List of open windows (alphabetical order)

### Help Menu:
- Search field (automatic with Help Book format)
- Send Feedback to Apple
- YourAppName Help
- Keep additional items minimal

### Dynamic Menu Items:
- Change behavior when modifier key is pressed (e.g., Minimize → Minimize All with Option)
- **Never the only way** to accomplish a task
- Use primarily in **menu bar menus** (not contextual/Dock menus)
- Require only a **single modifier key**

### Menu Bar Extras:
- Use a **symbol** (SF Symbols or custom icon) to represent your menu bar extra
- Display a **menu** (not a popover) when clicked
- Let **people decide** whether to show your menu bar extra (via Settings)
- Don't **rely** on the presence of menu bar extras (system may hide them)
- Also provide a **Dock menu** as alternative access
- Menu bar height: **24pt**

---

## 18. Keyboards

### Best Practices:
- Support **Full Keyboard Access** when possible
- **Respect standard keyboard shortcuts** — don't repurpose them
- People expect standard shortcuts to work consistently across apps

### Standard macOS Keyboard Shortcuts (Key Subset):
| Shortcut | Action |
|----------|--------|
| Cmd-, | Open app Settings |
| Cmd-Q | Quit |
| Cmd-W | Close window |
| Cmd-N | New document |
| Cmd-O | Open |
| Cmd-S | Save |
| Cmd-Z | Undo |
| Shift-Cmd-Z | Redo |
| Cmd-X/C/V | Cut/Copy/Paste |
| Cmd-A | Select All |
| Cmd-F | Find |
| Cmd-G / Shift-Cmd-G | Find Next / Find Previous |
| Cmd-H | Hide app |
| Cmd-M | Minimize window |
| Cmd-P | Print |
| Cmd-Tab | Switch apps |
| Ctrl-Cmd-F | Enter full screen |
| Cmd-` | Cycle windows in frontmost app |
| Cmd-? | Open Help |

### Custom Keyboard Shortcuts:
- Define only for **most frequently used** app-specific commands
- Modifier key order: **Control, Option, Shift, Command**
- Prefer **Command** as main modifier
- Use **Shift** as secondary modifier to complement related shortcuts
- Use **Option** sparingly for power features
- **Avoid Control** as modifier (system uses it extensively)
- Don't add Shift to shortcuts using the upper character of a two-character key
- Avoid creating shortcuts by adding modifiers to unrelated existing shortcuts
- Let the system **localize and mirror** shortcuts

---

## 19. Pointing Devices

### Best Practices:
- Be **consistent** when responding to mouse/trackpad gestures
- **Don't redefine** systemwide trackpad gestures
- Provide **consistent experience** across gestures, pointer, and keyboard
- Let people use the pointer to **reveal and hide** auto-minimizing controls

### macOS Standard Interactions:
| Interaction | Mouse | Trackpad |
|-------------|-------|----------|
| Primary click | ● | ● |
| Secondary click | ● | ● |
| Scrolling | ● | ● |
| Smart zoom | ● | ● |
| Swipe between pages | ● | ● |
| Swipe between full-screen apps | ● | ● |
| Mission Control | ● | ● |
| Force click | — | ● |
| Zoom (pinch) | — | ● |
| Rotate (two fingers) | — | ● |
| App Exposé | — | ● |
| Launchpad (pinch with thumb + 3 fingers) | — | ● |
| Show Desktop (spread with thumb + 3 fingers) | — | ● |

### macOS Pointer Styles:
| Pointer | Name | Use |
|---------|------|-----|
| Arrow | Standard selection/interaction |
| Closed hand | Dragging to reposition content |
| Open hand | Dragging is possible |
| I-beam | Text selection/insertion (horizontal) |
| Crosshair | Precise rectangular selection |
| Pointing hand | URL/link beneath pointer |
| Drag copy (+) | Option-drag; item will be copied |
| Drag link (↗) | Option-Cmd-drag; alias will be created |
| Disappearing item (✕) | Item will vanish on drop |
| Operation not allowed (⊘) | Can't drop here |
| Resize arrows | Various directional resize handles |
| Contextual menu | Right-click menu available |

---

## 20. Focus and Selection

### Best Practices:
- **Rely on system-provided focus effects** — they're precisely tuned
- **Don't change focus** without user interaction (exception: focused item disappears)
- Be **consistent with the platform** for focus behavior
- macOS: support focus for **content elements** (list items, text fields, search fields), not controls (buttons use Full Keyboard Access)
- Use **accent-color highlight** for focused list items; gray background for unfocused
- Use **focus ring** for text/search fields; **highlight** for lists/collections

### macOS/iPadOS Behavior:
- Tab key moves focus **among focus groups** (sidebars, grids, lists)
- Arrow keys navigate **within** a focus group
- Focus ring (halo effect) outlines the focused component
- Highlighted appearance uses the app's **accent color** for text

---

## 21. Gestures

### Best Practices:
- Give people **more than one way** to interact (voice, keyboard, Switch Control)
- Respond to gestures **consistently with expectations** — don't repurpose standard gestures
- Handle gestures **as responsively as possible** with immediate feedback
- **Indicate when a gesture isn't available** — don't let people think the app is frozen

### Custom Gestures:
- Add only when **necessary** for specialized tasks not covered by existing gestures
- Must be **discoverable, straightforward, distinct, and not the only way**
- Make them **easy to learn** — if hard to describe, they may be hard to perform
- Use as **supplements**, not replacements for standard gestures
- **Don't conflict** with system gestures

### macOS-Specific:
- People primarily interact via **keyboard and mouse**
- Standard gestures work on **Magic Trackpad, Magic Mouse**, and game controllers with touch surfaces

### Standard Gestures (All Platforms):
| Gesture | Action |
|---------|--------|
| Tap/Click | Activate a control; select an item |
| Swipe | Reveal actions; dismiss views; scroll |
| Drag | Move a UI element |
| Touch/Click and hold | Reveal additional controls (contextual menu) |
| Double tap/click | Zoom in; zoom out if already zoomed |
| Pinch (zoom) | Zoom a view; magnify content |
| Rotate (two fingers) | Rotate a selected item |

---

## Cross-Cutting macOS Design Principles

1. **Menu bar is essential** — put all commands in the menu bar, even infrequently used ones
2. **Keyboard shortcuts are expected** — support all standard shortcuts; add custom ones for frequent actions
3. **Full Keyboard Access** — support it so people can navigate everything via keyboard
4. **Drag and drop everywhere** — support it throughout with proper feedback and undo
5. **Tooltips on hover** — provide brief, actionable descriptions for controls (60–75 chars)
6. **Auto-save** — save work automatically; show unsaved state via close-button dot
7. **Settings via Cmd-,** — always in App menu, never in toolbar
8. **Undo/Redo via Cmd-Z / Shift-Cmd-Z** — always in Edit menu, describe the action
9. **Respect inactive windows** — allow dragging from background selections
10. **Focus ring for text fields** — highlight for lists/collections
11. **Full-screen via system** — use `toggleFullScreen(_:)`, menu bar hides at top
12. **Feedback matches significance** — inline for status, alerts only for critical info
13. **Loading shows progress** — use determinate/indeterminate indicators appropriately
14. **Don't require accounts** unless core functionality demands it
15. **Notifications respect user control** — accurate urgency levels, opt-in for marketing
