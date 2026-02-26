# WCAG Contrast Checker (Figma Plugin)

Checks contrast pairs inside a selected frame and flags failures first.

## What it does
- Analyzes nested visible layers in a frame.
- Uses WCAG-style thresholds for text/non-text.
- Hides same-color and fully-covered pairs.
- Supports optional surface-pair auditing.
- Clicking a card highlights the layer visually (no selection jump).

## Run locally
1. In Figma, open `Plugins` -> `Development` -> `Import plugin from manifest...`
2. Select `manifest.json`
3. Run `WCAG Contrast Checker`

## Files
- `manifest.json`
- `code.js`
- `ui.html`
