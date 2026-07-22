# TardMaxx

A mind mapping tool for structuring thoughts and projects — with optional AI that responds in tree form so you can explore, prune, and expand. Works great as a standalone mind mapper: no API key required, zero dependencies, just open the file and start organizing.

## Quick Start

1. Download and unzip
2. Open `index.html` in any browser
3. Start typing in the center node

That's it. No install, no server, no account. For AI features, copy `config.example.js` to `config.js` and add an API key.

## Two Ways to Use It

**Standalone mind mapper (no AI)**
- Double-click to edit nodes
- Tab / Enter to build out trees
- Drag and drop to rearrange
- Five built-in themes (Light, Dark, Forest, Ocean, Sunset)
- Link files by path or URL, export as PNG/JPEG/PDF/Markdown
- Save to your browser's local storage, download as JSON
- Collapse branches, zoom and pan large maps
- All keyboard shortcuts work without AI

**With AI (optional)**
- Copy `config.example.js` → `config.js`, add an API key
- Click `<` on any node to expand with AI-generated synopses
- Click 🤿 for a prose deep dive overlay
- Switch models in the sidebar (Groq, DeepSeek, Claude, GPT-4o)
- AI responses become part of your map — you edit, delete, and build on them
- Use **TardMaxx** to generate an entire map from a prompt

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Tab | Add child |
| Enter | Add sibling (AI expansion when editing) |
| Shift+Enter | New line in node |
| F2 | Edit text |
| Delete | Delete selected node |
| Ctrl+Z / Y | Undo / Redo |
| Ctrl+S | Save |
| Ctrl+L | Auto-layout |

## Features

- **Glass UI** — Dark theme with frosted glass nodes, five built-in themes
- **File linking** — Link local files or Drive/Dropbox URLs to any node
- **Export** — PNG, JPEG, PDF, Markdown, and JSON
- **PWA** — Install to desktop, works offline
- **AI-native** — Optional AI expansion on every node, multiple model support
- **Zero dependencies** — One folder, no npm, no build step, no server

## API Keys

For AI features only. Get an API key from [Groq](https://console.groq.com) (fast, dirt cheap — fractions of a cent per request). Paste it into `config.js` on the first profile line. More keys in Settings (🎨).

## Sharing

The folder IS the app. Zip it and email it. Delete `config.js` before sharing — recipients copy `config.example.js` and add their own keys.

## License

**PolyForm Shield** — Free for personal, academic, and non-commercial use. Businesses using this tool to generate revenue need a commercial license.
