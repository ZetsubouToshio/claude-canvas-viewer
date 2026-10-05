# Roadmap to 1.0

Claude Canvas Viewer is a **read-only viewer** for Claude Code Design canvases inside VS Code. 1.0 means:
*you can install it from a store, open any real canvas and trust what you see; it stays fast with large
canvases; it is tested where it runs; and its commands, settings and view IDs won't change under you.*

Versions below are milestones, not promises: each one is shippable on its own, and scope may move
between them. Checked items are done.

## Where we are: 0.3 — Stabilisation ✅

Outcome of the code review (see the [changelog](CHANGELOG.md) for the full list).

- [x] Per-editor state (no module globals), debounced live reload of the canvas **and** its artboards
- [x] Manifest matches registrations (a test enforces it); working commands, menu and keybinding
- [x] Artboard scripts run (CSP fixed), sandboxed, off in untrusted workspaces, setting to disable
- [x] Path containment for artboard files; no markup built from file contents
- [x] Robust to bad input (`null`, empty `file`, directories, half-written JSON)
- [x] Pan/zoom works over artboards, persisted across reloads; interactive mode per artboard
- [x] Layout fidelity (no forced body size/margin, no quirks mode), `srcdoc` instead of `data:` URLs
- [x] Unit tests, headless-browser tests, ESLint, CI, release workflow, build docs

## 0.4 — Fidelity: show what Claude Design shows

The biggest remaining gap between "renders an artboard" and "renders *the* artboard".

- [ ] **Relative assets**: `<img src="img/a.png">`, `<link href="style.css">`, local fonts and scripts next
  to a `.dc.html`. Plan: rewrite relative URLs to `webview.asWebviewUri(...)` and extend
  `localResourceRoots` to the allowed roots. A `<base href>` is the obvious shortcut but turns every
  `href="#x"` into a navigation, so prefer rewriting. Needs real-VS-Code verification.
- [ ] **Real samples and a format spec**: collect real Claude Code Design projects as fixtures, write
  `docs/canvas-format.md`, ship a JSON Schema (`jsonValidation`) so editing `canvas.json` as text gets
  completion and diagnostics. Find out which fields beyond `artboards`/`annotations` exist and decide
  which to support.
- [ ] **Script/resource policy**: decide on remote scripts, `unsafe-eval` for CDN frameworks, `fetch` for
  local data — each behind an explicit setting; show artboard script errors somewhere visible.
- [ ] **Crisp zoom**: check blurry text when zooming a CSS-scaled iframe; consider re-rasterising at
  the current scale.
- [ ] **Integration tests in a real VS Code** (`@vscode/test-electron` under `xvfb` in CI): activation,
  custom editor registration, commands, watcher-driven reload. The unit tests currently use a fake
  `vscode` module — good for logic, blind to API misuse.

## 0.5 — Navigation and UX

- [ ] Keyboard navigation between artboards (←/→, `PageUp`/`PageDown`), a notion of the *current* artboard,
  `F` to focus it
- [ ] Space+drag pan; `claudeCanvas.wheelBehavior` (`zoom` | `pan`, with `Ctrl`/pinch always zooming) for trackpads
- [ ] Minimap; filter/search in the artboard list; artboard info (size, file) and "copy path"
- [ ] Follow the VS Code colour theme (light, dark, high contrast); background colour and grid toggle
- [ ] Zoom presets (50 / 100 / 200 %), zoom-to-selection
- [ ] Leave interactive mode when keyboard focus is inside an artboard (today only a click on the canvas does)

## 0.6 — Scale and performance

Target: a canvas with **100 artboards** or **20 MB of HTML** stays responsive and does not balloon memory.

- [ ] Lazy artboards: load only what is near the viewport (`IntersectionObserver`), unload far ones,
  show a placeholder (title + size) in between
- [ ] Host side: cache by mtime/content hash and post only changed artboards (today every reload re-reads
  and re-posts all of them; the webview skips re-rendering unchanged ones)
- [ ] Reconsider `retainContextWhenHidden` (memory) now that view state is persisted
- [ ] Size guard with a clear message for absurdly large files; profiling notes in `docs/`

## 0.7 — Accessibility, localisation, polish

- [ ] Accessibility pass: roles and labels, focus order and visible focus, screen-reader friendly artboard
  list, `prefers-reduced-motion`, high-contrast theme
- [ ] Localisation (`vscode.l10n`, `package.nls.json`); English plus Russian
- [ ] Extension icon, gallery banner, screenshots/GIF in the README, icon for canvas files/tabs
- [ ] Friendlier errors: link to docs, "Open as text", "Reveal in Explorer" from the banner

## 0.8 — Distribution and project hygiene

- [ ] Register a publisher ID (replace `"local"`); publish to the **VS Code Marketplace** and **Open VSX**
  from the release workflow (tokens as repository secrets); a pre-release channel (`--pre-release`)
- [ ] CI matrix: Linux / macOS / Windows × minimum supported VS Code (1.85) / stable / Insiders
- [ ] Remote: verify SSH, WSL, Dev Containers, Codespaces; decide on `extensionKind`. Web
  (`vscode.dev`/`github.dev`) needs `vscode.workspace.fs` instead of `fs` and a `browser` entry —
  go/no-go decision here
- [ ] `SECURITY.md` (threat model from the README, how to report), `CONTRIBUTING.md`, issue and PR templates,
  Dependabot for dev dependencies and actions, `npm audit` in CI
- [ ] Decide on TypeScript or `// @ts-check` + `@types/vscode` for the host code

## 0.9 — Release candidate

- [ ] Feature freeze; only fixes
- [ ] Dogfood on real Claude Code Design projects for a couple of weeks; fix what hurts
- [ ] Manual test checklist (`docs/RELEASE_CHECKLIST.md`) executed on all three OSes
- [ ] Docs review: README matches behaviour, every setting/command/key documented

## 1.0 — Definition of done

- [ ] No open bugs of high severity; no known security issues; threat model published
- [ ] Verified on the minimum supported and the latest VS Code, on Windows, macOS and Linux, and in at
  least one remote scenario
- [ ] Automated: unit + webview + real-VS-Code integration tests, all green in CI
- [ ] Published on the Marketplace (and Open VSX) under a real publisher, with icon and screenshots
- [ ] Performance targets from 0.6 met and measured
- [ ] Compatibility promise (semver): view type, command IDs, setting names and the supported subset of
  the canvas format are stable until 2.0; breaking changes need a deprecation release first
- [ ] `CHANGELOG.md` and the README are complete and accurate

## Beyond 1.0 (ideas, not commitments)

- Editing: drag artboards and notes and write positions back to the canvas file (turns the viewer into
  an editor: needs undo/redo and a `CustomEditorProvider` with documents)
- Export an artboard or the whole canvas as PNG/PDF
- Claude Code integration: "reference this artboard in Claude Code" (insert an `@file` mention), jump from an
  artboard to the source line it came from
- Version comparison: slide through git history of an artboard, side-by-side diff
- Device frames and responsive previews

## Decisions needed from the maintainer

1. **Viewer or editor?** Read-only forever, or editing after 1.0? It affects the provider architecture,
   so decide before 0.5.
2. **Where does it ship?** Marketplace/Open VSX (a public product with support obligations) or GitHub
   Releases only (the current `"local"` publisher)?
3. **Canvas format authority.** Is there an official spec or sample set for Claude Code Design canvases?
   The supported subset today is inferred from the first implementation.
4. **Default editor for `canvas.json`.** It is a generic file name and `*.canvas` collides with Obsidian's
   canvases. Keep the viewer as the default (current), or make it opt-in (`priority: "option"`)?
5. **Remote scripts in artboards.** Allowed today (CDN libraries are common in generated designs), but it
   is a policy choice: keep, gate behind a separate setting, or block?
6. **Web support** (`vscode.dev`) — worth the porting cost?

## Known limitations carried over from the review

| Area | Limitation | Planned |
| --- | --- | --- |
| Rendering | Relative assets in artboards don't load | 0.4 |
| Rendering | Remote-script policy is all-or-nothing | 0.4 |
| Input | Keyboard focus inside an interactive artboard can't leave it with `Esc` | 0.5 |
| Scale | All artboards are loaded eagerly | 0.6 |
| Testing | No test runs inside a real VS Code yet (blocked in the review sandbox) | 0.4 |
| Packaging | Publisher is `"local"`, no icon | 0.7–0.8 |
| Accessibility | Only basic labels and focus styles | 0.7 |
