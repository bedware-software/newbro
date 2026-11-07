# Vimperium logo brief — round 2: CYBERPUNK, complex form, V as the hero

## What it is
A desktop browser (Electron, React) being rebranded from "Newbro" to **Vimperium** (Vim + Imperium).
Keyboard-driven, with a real Vim mode: modal COMMAND / INSERT, hjkl, `:` commands, `dd`, `gg`/`G`, workspaces,
tab groups, split panes, a command palette. The owner's feedback on the first round, verbatim:
"Ну как-то ты зажался. Только примитивы использовал. Давай что-то посложнее с формой. То, что акцент на V — это хорошо.
Попробуй вдохновиться стилистикой cyberpunk." So:
- **The V is the hero.** Every concept is built around a V (Vim's V, Vimperium's V).
- **Complex form, not primitives.** Facets, chamfers, bevels, cut corners, notches, stencil breaks, layered depth,
  double outlines, inner structure (traces, bands, segments), asymmetry. A mark that rewards a second look at 128–1024px.
- **Cyberpunk.** Neon tubes and glow, chamfered 45° typography (Cyberpunk 2077's titles), HUD / targeting brackets
  and readout bars (Ghost in the Shell, Deus Ex), PCB traces and chips, holographic strips and scanlines, Blade Runner
  signage, Akira / Tron light lines, cyber-samurai blades and visors, hazard stripes, data corruption and pixel sorting.
  Dark backplates with glowing edges are welcome. Avoid clichés that say "generic sci-fi" rather than Vim: skulls,
  random hexagon spam, binary rain, a plain gradient blob.
- **It must still say Vim** somewhere: the V itself, the block cursor, the `:` prompt, the `~` tilde, the diamond, hjkl.
- **Glitch** is part of the brand: the gallery animates every mark with slice / RGB-split / scanline / mode-flip glitches.
  Marks whose geometry already suggests a tear or a split take it best.

## Where it lives
1. The app icon: 1024px, rounded square on macOS, .ico on Windows. This is where the complex form shines.
2. The **top-left corner of the browser toolbar**: a 36px button holding the mark at ~20px, and a 16px favicon in tabs.
   A complex mark turns to mush there, so EVERY concept also ships a **small variant** (see contract): the same idea
   reduced to 1–3 strong shapes, like a favicon cut from the big mark. The two must read as the same logo.

## Colours (through variables; the gallery swaps them live)
The app already animates Vim's mode around the address bar as a "comet on rail" in the mode's three colours; those trios ARE the brand:
- COMMAND: c1 blue `oklch(0.74 0.14 240)`, c2 violet `oklch(0.66 0.19 292)`, c3 cyan `oklch(0.83 0.12 205)`
- INSERT:  c1 green `oklch(0.80 0.18 142)`, c2 lime `oklch(0.89 0.16 110)`, c3 teal `oklch(0.77 0.13 182)`
- plus an optional hot accent `--hot`: magenta `oklch(0.72 0.22 350)` in COMMAND, amber `oklch(0.78 0.18 60)` in INSERT — use it sparingly, for one glowing detail.
- `--bg` is the UI background (dark `oklch(0.21 0 0)` / deep `oklch(0.14)` / light `oklch(0.965)`), `--fg` the UI text colour.
A mark may carry its own dark backplate (a chamfered plate, a chip body): fill it with `var(--bg, #1a1a1a)` or a tone mixed from a trio colour, e.g. `color-mix(in oklch, var(--c2) 25%, var(--bg))`. color-mix() is fine in fills and stops. Never a bare literal colour.
The mark must look right with EITHER trio and on BOTH dark and light. On light, a neon mark can sit on its own dark plate.

## Hard contract
- Files: `concepts/<id>.svg` (the full mark) and `concepts/<id>.small.svg` (the small variant, REQUIRED), optional `concepts/<id>.wordmark.svg`.
  `<id>` = `<angle>-<nn>-<slug>`, lowercase ascii, e.g. `neon-02-broken-tube`.
- Root: `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">` (wordmark: `viewBox="0 0 320 64"`). NO width/height on the root.
- Colours ONLY via `var(--c1, #7aa2f7)`, `var(--c2, #bb9af7)`, `var(--c3, #7dcfff)`, `var(--hot, #ff5fb0)`, `var(--fg, #e0e0e0)`, `var(--bg, #1a1a1a)`,
  and `color-mix(in oklch, var(--cX) N%, var(--bg))` / `transparent` for tones. Opacity attributes are fine. Never a bare brand colour.
- Gradients (linear/radial) are welcome. `<filter>` (feGaussianBlur glow, feTurbulence) is allowed in the FULL mark only, and the mark must still
  read if filters are dropped. The small variant: no filters, no gradients needed, 1–3 shapes, nothing thinner than 3 units.
- No `<text>`: draw letters as paths. No `<image>`, `<script>`, `<style>`, `<foreignObject>`.
- Full mark ≤ 10 KB, small ≤ 3 KB. Internal ids are fine; the tooling namespaces them.
- Design on the 64 grid. The full mark may bleed to ~1 unit from the edge; the small variant keeps ~3 units of margin.

## Proofing loop (mandatory)
From the `logo` directory:
    node lint.mjs concepts/<id>.svg concepts/<id>.small.svg
    node render.mjs concepts/<id>.svg
`render.mjs` writes `renders/<id>.png`: the FULL mark at 128px in both trios, the SMALL variant at 32/24/16px, a pixel-zoomed 16px,
and the small variant sitting in a mock of the browser toolbar's top-left button (20px) and in a tab (16px), on dark (row 1) and light (row 2),
plus a row for the wordmark if present. LOOK at it with the Read tool (it shows images). Iterate: at least two render-and-look passes per concept.
Ask yourself: is this complex and cyberpunk at 128, and is the small variant the same logo at 16? Ship only what you'd sign.
