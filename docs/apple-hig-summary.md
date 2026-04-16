# Apple Human Interface Guidelines — Comprehensive Summary

> Extracted from Apple HIG (developer.apple.com), April 2026.
> Focus: macOS-relevant guidance for CubeLite.

---

## 1. Accessibility

### Vision

- **Support larger text sizes** — allow at least 200% enlargement (140% on watchOS). Adopt Dynamic Type where available.
- **Recommended default/minimum font sizes by platform:**

  | Platform | Default | Minimum |
  |----------|---------|---------|
  | macOS | **13 pt** | **10 pt** |
  | iOS/iPadOS | 17 pt | 11 pt |
  | visionOS | 17 pt | 12 pt |

- **Font weight matters** — thin weights are harder to read; aim for larger sizes when using thin weights.
- **Color contrast minimums (WCAG AA):**

  | Condition | Ratio |
  |-----------|-------|
  | Text up to 17 pt, any weight | **4.5:1** |
  | Text 18 pt+, any weight | **3:1** |
  | Any size, bold weight | **3:1** |

- If your app doesn't meet minimum contrast by default, at least ensure it when Increase Contrast is on.
- Check contrast in **both light and dark** appearances.
- **Prefer system-defined colors** — they have accessible variants that auto-adapt to Increase Contrast, light/dark.
- **Never rely on color alone** to convey information — supplement with shapes, icons, or text labels.
- Describe your app's interface for **VoiceOver** — provide accessibility descriptions for all custom elements.

### Hearing

- Support text-based alternatives for audio (captions, subtitles, transcripts).
- Augment audio cues with visual cues.

### Mobility

- **Minimum control sizes:**

  | Platform | Recommended | Minimum |
  |----------|------------|---------|
  | macOS | **28×28 pt** | **20×20 pt** |
  | iOS/iPadOS | 44×44 pt | 28×28 pt |

- **Spacing between controls** — ~12 pt padding around elements with bezels; ~24 pt around elements without bezels.
- Support simple gestures for common interactions; avoid custom multi-finger gestures.
- Offer onscreen alternatives to gestures.
- Support **Full Keyboard Access** — let people navigate and interact using keyboard alone; don't override system keyboard shortcuts.
- Support **Voice Control** and **Switch Control**.

### Cognitive

- Keep actions simple and intuitive; prefer familiar system gestures.
- Minimize time-boxed UI elements (auto-dismissing views).
- Let people control audio/video playback; avoid autoplaying without controls.
- Be cautious with fast-moving/blinking animations.
- Respond to **Reduce Motion** accessibility setting:
  - Tighten animation springs to reduce bounce
  - Track animations directly with gestures
  - Avoid animating depth changes in z-axis
  - Replace x/y/z transitions with fades
  - Avoid animating into/out of blurs

---

## 2. App Icons

### Design Rules

- **Embrace simplicity** — find a core concept, express it with minimal shapes.
- Provide a **visually consistent icon** across all supported platforms.
- Base design around **filled, overlapping shapes** (especially with transparency/blurring for depth).
- **Include text only when essential** — text doesn't support accessibility or localization.
- **Prefer illustrations over photos** — photos don't work well at small sizes or across appearances.
- Don't use replicas of Apple hardware products.
- Don't replicate UI components or use app screenshots.

### Specifications

| Platform | Shape | Canvas Size | Format |
|----------|-------|-------------|--------|
| iOS, iPadOS, **macOS** | Square → rounded-rect mask | **1024×1024 px** | Layered |
| tvOS | Rectangle (landscape) | 800×480 px | Layered (Parallax) |
| visionOS/watchOS | Square → circular mask | 1024×1024 / 1088×1088 px | Layered |

- Supported color spaces: sRGB, Gray Gamma 2.2, Display P3 (macOS included).
- Provide **unmasked square layers** — system applies rounded corners on macOS.
- Keep primary content centered to avoid truncation.

### Appearances (macOS)

- iOS/iPadOS/macOS support **default, dark, clear, and tinted** icon variants.
- Keep core visual features consistent across all appearance variants.
- Use your **light icon as basis for dark** — choose complementary, more subdued colors.

### macOS Document Icons

- Document icons: classic folded-corner paper appearance.
- If you don't supply one, macOS creates one by compositing your app icon + file extension.
- Supply: background fill, center image, and/or text.
- Background fill sizes: 512, 256, 128, 32, 16 px @1x and @2x.
- Center image: half the document icon canvas size.
- Define 10% margin on center images; keep content within ~80% of canvas.
- Avoid important content in top-right corner (system draws folded corner there).
- Reduce complexity at small sizes (fewer lines, thicker strokes at 32px; remove details at 16px).

---

## 3. Color

### Best Practices

- **Don't use same color for different meanings** — use color consistently for status/interactivity.
- **Support light AND dark appearances** — even if you ship single-mode, provide both for Liquid Glass adaptivity.
- Provide **increased contrast** variants for each custom color.
- **Test under varying lighting** — sunny, dim, True Tone, different color profiles (P3, sRGB).
- Consider artwork/translucency effects on nearby colors.
- Use system-provided color pickers (`ColorPicker` in SwiftUI).

### Inclusive Color

- **Never rely solely on color** to differentiate objects or communicate essential info.
- Ensure sufficient contrast (see Accessibility section).
- Consider cultural color meanings (red = danger in some cultures, positive in others).

### System Colors

- **Never hard-code system color values** — they fluctuate across releases.
- Use APIs like `Color` (SwiftUI), `UIColor` (UIKit), `NSColor` (AppKit).
- Use **semantic/dynamic colors** defined by purpose, not appearance (e.g., `labelColor`, `separatorColor`).
- **Don't redefine semantic meanings** — don't use `separator` as text color, etc.

### macOS-Specific System Colors

| Color | Purpose | API |
|-------|---------|-----|
| `controlAccentColor` | User-selected accent color | `controlAccentColor` |
| `controlBackgroundColor` | Large interface elements (browsers, tables) | `controlBackgroundColor` |
| `controlColor` | Surface of a control | `controlColor` |
| `controlTextColor` | Text on available control | `controlTextColor` |
| `disabledControlTextColor` | Text on unavailable control | `disabledControlTextColor` |
| `labelColor` | Primary content text | `labelColor` |
| `secondaryLabelColor` | Subheadings, additional info | `secondaryLabelColor` |
| `tertiaryLabelColor` | Lesser labels | `tertiaryLabelColor` |
| `quaternaryLabelColor` | Lowest importance labels | `quaternaryLabelColor` |
| `selectedContentBackgroundColor` | Selected content in key window | `selectedContentBackgroundColor` |
| `separatorColor` | Separators between sections | `separatorColor` |
| `shadowColor` | Virtual shadow for raised elements | `shadowColor` |
| `alternateSelectedControlTextColor` | Text on selected surface in list/table | `alternateSelectedControlTextColor` |
| `alternatingContentBackgroundColors` | Alternating row/column backgrounds in tables | `alternatingContentBackgroundColors` |

### macOS App Accent Colors

- macOS lets users choose a system-wide accent color in System Settings.
- Sidebar selection indicators follow the user's accent color setting.

### System Color Specifications (RGB Values)

| Color | Light Default | Dark Default | Light High Contrast | Dark High Contrast |
|-------|--------------|-------------|--------------------|--------------------|
| Red | (255,59,48) | (255,69,58) | (215,0,21) | (255,105,97) |
| Orange | (255,149,0) | (255,159,10) | (201,52,0) | (255,179,64) |
| Yellow | (255,204,0) | (255,214,10) | (178,80,0) | (255,212,38) |
| Green | (52,199,89) | (48,209,88) | (36,138,61) | (48,219,91) |
| Blue | (0,122,255) | (10,132,255) | (0,64,221) | (64,156,255) |
| Indigo | (97,85,245) | (109,124,255) | (86,74,222) | (167,170,255) |
| Purple | (203,48,224) | (219,52,242) | (176,47,194) | (234,141,255) |
| Pink | (255,45,85) | (255,55,95) | (231,18,77) | (255,138,196) |
| Brown | (172,127,94) | (183,138,102) | (149,109,81) | (219,166,121) |

### Color Management

- Apply color profiles to images (sRGB for most displays).
- Use asset catalogs to provide different versions for each color space.
- Test with P3 and sRGB profiles.

---

## 4. Dark Mode

### Best Practices

- **Don't offer app-specific appearance setting** — respect systemwide choice.
- **Ensure content looks good in both modes** (including with Auto switching).
- **Test with Increase Contrast + Reduce Transparency turned on** (both separately and together).
- In rare cases, dark-only is acceptable (e.g., immersive media viewing apps).

### Dark Mode Colors

- Dark palette uses **dimmer backgrounds, brighter foregrounds** — not simple inversions.
- **Use semantic colors** (`labelColor`, `controlColor`, `separatorColor`) — they adapt automatically.
- Add Color Set assets with bright and dim variants; avoid hard-coded values.
- **Minimum contrast ratio: 4.5:1**; strive for **7:1** especially for small text.
- **Soften white backgrounds** in content images to prevent glowing in dark context.

### Icons & Images in Dark Mode

- Use **SF Symbols** — auto-adapt to Dark Mode with dynamic colors.
- Design **separate icon variants** for light/dark if needed (e.g., dark outline for dark backgrounds).
- Make full-color images work in both appearances, or provide separate light/dark assets via asset catalogs.

### Text in Dark Mode

- Use **system-provided label colors** (primary, secondary, tertiary, quaternary) — auto-adapt.
- Use **system views** to draw text fields/views — auto-adjust for vibrancy.

### macOS-Specific Dark Mode

- **Desktop tinting** — when graphite accent is selected, window backgrounds pick up color from desktop picture.
- **Add transparency to custom component backgrounds** (neutral state only) so they harmonize with desktop tinting.
- Don't add transparency when component uses color (avoids color fluctuation when background changes).

---

## 5. Icons (Interface Icons / Glyphs)

### Best Practices

- Create **recognizable, highly simplified** designs — use familiar visual metaphors.
- **Maintain visual consistency** across all icons: same size, detail level, stroke weight, perspective.
- **Match icon weight to adjacent text weight** for consistent appearance.
- Add **padding for optical alignment** on asymmetric icons.
- System handles selected-state appearance automatically for standard components (toolbars, tab bars, buttons).
- Use **inclusive, gender-neutral** figures.
- Include text only when essential; localize characters.
- **Use vector formats** (PDF, SVG) for custom icons — they scale automatically for high-res.
- Provide **alternative text labels** (accessibility descriptions) for all custom icons.
- Don't replicate Apple hardware products.

### macOS Document Icons

- Custom document type icons: folded-corner paper appearance.
- Supply combination of background fill, center image, and text.
- Size sets for backgrounds: 512, 256, 128, 32, 16 (each @1x and @2x).
- Center image sizes: 256, 128, 32, 16 (each @1x and @2x).
- 10% margins on center image; content occupies ~80% of canvas.
- Reduce complexity at small sizes.
- Avoid important content in top-right corner.
- Use short, capitalized terms for unfamiliar file extensions.

---

## 6. Layout

### Best Practices

- **Group related items** using negative space, backgrounds, colors, separators.
- Give essential information **sufficient space**; make secondary info available elsewhere.
- **Extend content to fill screen/window** edges; backgrounds should be full-bleed.
- Use **background extension views** to provide content appearance under sidebars/inspectors.

### Visual Hierarchy

- Use **Liquid Glass** for controls to distinguish from content layer.
- Place items in **reading order** (top-to-bottom, leading-to-trailing).
- **Align components** for easier scanning and perceived organization.
- Use **progressive disclosure** to reveal hidden content.
- Provide enough **space around controls**; group in logical sections.

### macOS-Specific Layout

- **Don't place controls or critical info at window bottom** — people often move windows below screen edge.
- **Don't display content within camera housing** area at top edge.
- Use `NSPrefersDisplaySafeAreaCompatibilityMode` for camera housing avoidance.

### Adaptability

- Design layouts that adapt gracefully while remaining recognizably consistent.
- Support text-size changes (Dynamic Type where available — note: **macOS does not support Dynamic Type**).
- Preview on multiple devices with different orientations, localizations, text sizes.
- Scale artwork when aspect ratio changes; don't change aspect ratio.

### Guides & Safe Areas

- Use predefined layout guides for standard margins and text width.
- Respect safe areas to avoid overlapping with toolbars, tab bars, camera housings.
- Use `NSLayoutGuide` (AppKit) for macOS guides.

---

## 7. Materials

### Liquid Glass

- Forms a **distinct functional layer** for controls/navigation that floats above content.
- **Don't use Liquid Glass in the content layer** — reserve for interactive/navigation elements.
- **Use sparingly** — standard system components adopt it automatically.
- Two variants:
  - **Regular** — blurs/adjusts luminosity of background for legibility. Use for components with significant text (alerts, sidebars, popovers).
  - **Clear** — highly translucent, prioritizes visibility of underlying content. Use for components floating above media.
- For clear variant over bright content: add dark dimming layer at **35% opacity**.

### Standard Materials

- Use blur, vibrancy, and blending modes for structure in content beneath Liquid Glass.
- Choose materials by **semantic meaning**, not apparent color.
- Use **vibrant colors on top of materials** for legibility.
- Thicker materials (more opaque) = better contrast for text. Thinner (more translucent) = more context.

### macOS-Specific Materials

- macOS provides standard materials with designated purposes + vibrant versions of all system colors.
- **Choose when to allow vibrancy** in custom views — test in variety of contexts.
- Two background blending modes: **behind window** and **within window** (`NSVisualEffectView.BlendingMode`).

---

## 8. Motion

### Best Practices

- **Add motion purposefully** — don't animate for the sake of it.
- **Make motion optional** — never use motion as the only way to communicate important info.
- Supplement with haptics and audio.
- **Brief and precise** feedback animations — lightweight and unobtrusive.
- **Avoid adding motion to frequent UI interactions** in non-game apps — system already provides subtle animations.
- **Let people cancel motion** — don't block interaction waiting for animations.
- Consider **animated SF Symbols** where appropriate.

### Reduce Motion Support

- When Reduce Motion is active:
  - Tighten animation springs (reduce bounce)
  - Track animations with gestures
  - Avoid z-axis depth animations
  - Replace x/y/z transitions with fades
  - Avoid blurring animations

### Performance

- Maintain **30–60 fps** for games.
- Let people customize visual experience for performance/battery.

---

## 9. SF Symbols

### Rendering Modes

1. **Monochrome** — one color, all layers.
2. **Hierarchical** — one color, varying opacity per layer level.
3. **Palette** — two+ colors, one per layer.
4. **Multicolor** — intrinsic colors reflecting real-world meaning (e.g., `leaf` = green).

- System colors ensure symbols auto-adapt to accessibility, vibrancy, Dark Mode.
- Check rendering mode works well in every context (size, background contrast).

### Gradients (SF Symbols 7+)

- Smooth linear gradient from single source color. Best at larger sizes.

### Variable Color

- Represent characteristics that change over time (capacity, strength).
- Applies color to layers as value reaches thresholds (0–100%).
- Use for **change, not depth** — use Hierarchical for depth.

### Weights & Scales

- **9 weights**: Ultralight → Black, corresponding to San Francisco font weights.
- **3 scales**: Small, Medium (default), Large — relative to SF font cap height.
- Match symbol weight to adjacent text weight.

### Design Variants

- **Outline** — no solid areas, resembles text; best for toolbars, lists alongside text.
- **Fill** — solid areas, more visual emphasis; good for tab bars, selection indicators.
- **Slash** — indicates unavailability.
- **Enclosed** (circle, square, rectangle) — improved legibility at small sizes.
- Variants auto-adapt based on context (tab bar → fill; toolbar → outline).
- Language/script variants auto-adapt to device language.

### Animations

Available animations: Appear, Disappear, Bounce, Scale, Pulse, Variable Color, Replace, Magic Replace, Wiggle, Breathe, Rotate, Draw On/Off.

- **Apply judiciously** — too many overwhelm the interface.
- Ensure each animation **serves a clear purpose**.
- Use to communicate information efficiently without taking visual space.
- Consider app's tone and brand identity.

### Custom Symbols

- Export similar symbol template, modify with vector editor.
- Follow template guide for consistency (detail, weight, alignment, perspective).
- Assign negative side margins for optical horizontal alignment when badges increase width.
- Annotate layers in SF Symbols app for animation support.
- Test animations thoroughly — shapes may behave unexpectedly in motion.
- Use component library for common variants (enclosures, badges).
- Provide accessibility labels.
- Don't replicate Apple products.

---

## 10. Typography

### Ensuring Legibility

- **Recommended font sizes:**

  | Platform | Default | Minimum |
  |----------|---------|---------|
  | **macOS** | **13 pt** | **10 pt** |
  | iOS/iPadOS | 17 pt | 11 pt |
  | visionOS | 17 pt | 12 pt |

- **Avoid light font weights** (Ultralight, Thin, Light) — prefer Regular, Medium, Semibold, Bold.
- Test legibility in different contexts (lighting, device, etc.).

### Conveying Hierarchy

- Adjust **weight, size, and color** to emphasize important information.
- **Minimize typefaces** — too many obscure hierarchy and hinder readability.
- **Prioritize important content** when responding to text-size changes.

### System Fonts

- **SF Pro** — system font on macOS (and iOS/iPadOS/tvOS/visionOS).
- **SF Compact** — system font on watchOS.
- **New York (NY)** — serif family, works alongside SF fonts. Available for Mac Catalyst apps.
- All available in **variable font format** with dynamic optical sizes.
- Weights: Ultralight → Black.
- Widths: Condensed, Regular, Expanded (SF only).
- SF Symbols use equivalent weights for precise matching with adjacent text.

### macOS Built-in Text Styles

| Style | Weight | Size | Leading | Emphasized |
|-------|--------|------|---------|------------|
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

(Point sizes based on 144 ppi @2x)

### macOS Dynamic System Font Variants

| Usage | API |
|-------|-----|
| Control content | `controlContentFont(ofSize:)` |
| Label | `labelFont(ofSize:)` |
| Menu | `menuFont(ofSize:)` |
| Menu bar | `menuBarFont(ofSize:)` |
| Message | `messageFont(ofSize:)` |
| Palette | `paletteFont(ofSize:)` |
| Title bar | `titleBarFont(ofSize:)` |
| Tool tips | `toolTipsFont(ofSize:)` |
| Document text | `userFont(ofSize:)` |
| Monospaced document text | `userFixedPitchFont(ofSize:)` |
| Bold system font | `boldSystemFont(ofSize:)` |
| System font | `systemFont(ofSize:)` |

### macOS Typography Notes

- **macOS does NOT support Dynamic Type**.
- Use `Font.Design.default` for system font; `Font.Design.serif` for New York.
- Modify text styles with symbolic traits (bold, leading adjustments).
- Loose leading: better for wide columns/long passages.
- Tight leading: constrained heights (but avoid for 3+ lines).

### macOS Tracking Values (SF Pro, selected)

| Size (pt) | Tracking (1/1000 em) | Tracking (pt) |
|-----------|---------------------|---------------|
| 10 | +12 | +0.12 |
| 11 | +6 | +0.06 |
| 12 | 0 | 0.0 |
| 13 | -6 | -0.08 |
| 14 | -11 | -0.15 |
| 15 | -16 | -0.23 |
| 16 | -20 | -0.31 |
| 17 | -26 | -0.43 |
| 20 | -23 | -0.45 |
| 22 | -12 | -0.26 |
| 24 | +3 | +0.07 |
| 26 | +8 | +0.22 |
| 28 | +14 | +0.38 |
| 32 | +13 | +0.41 |
| 36 | +10 | +0.37 |
| 48 | +8 | +0.35 |

### Custom Fonts

- Must be legible at all viewing distances/conditions.
- Implement accessibility features (Dynamic Type support where available, Bold Text response).
- Use `Applying custom fonts to text` SwiftUI API.

---

## Quick Reference: macOS-Critical Values

| Metric | Value |
|--------|-------|
| Default body font size | **13 pt** |
| Minimum readable font size | **10 pt** |
| Minimum control size (recommended) | **28×28 pt** |
| Minimum control size (absolute) | **20×20 pt** |
| Control padding (with bezel) | **~12 pt** |
| Control padding (without bezel) | **~24 pt** |
| Min contrast ratio (normal text) | **4.5:1** |
| Min contrast ratio (large/bold text) | **3:1** |
| Ideal contrast ratio | **7:1** |
| App icon canvas | **1024×1024 px** |
| System font | **SF Pro** |
| Headline weight | **Bold** (13 pt) |
| Body weight | **Regular** (13 pt) |
| Desktop tinting support | Add transparency to neutral-state custom backgrounds |

---

## Key Don'ts (All Platforms)

- ❌ Don't hard-code system color values
- ❌ Don't redefine semantic meanings of system colors
- ❌ Don't use same color for different meanings
- ❌ Don't rely solely on color for information
- ❌ Don't offer app-specific appearance settings (respect system dark/light)
- ❌ Don't use light font weights (Ultralight, Thin, Light) for body text
- ❌ Don't add gratuitous animation
- ❌ Don't use Liquid Glass in the content layer
- ❌ Don't replicate Apple hardware products
- ❌ Don't place critical controls at bottom of macOS windows
- ❌ Don't mix too many typefaces
