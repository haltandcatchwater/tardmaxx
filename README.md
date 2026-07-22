# Inquire Within

A first-principles mind mapping tool where every node is an AI endpoint. Double-click to edit. Press `<` to expand into richer branches. Click 🤿 for a deep dive. The AI responds in tree form — you curate, prune, and explore.

## Quick Start

1. Download and unzip
2. Copy `config.example.js` to `config.js` and add an API key (Groq is fast and cheap)
3. Open `index.html` in any browser
4. Start typing in the center node, or click **Inquire Within** in the sidebar

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

- **AI-native** — Every node can be expanded by AI. Click `<` for tree branches, 🤿 for prose deep dives
- **Multi-model** — Switch between Groq, DeepSeek, Claude, and GPT-4o in the sidebar
- **Semi-deep dives** — Node expansions produce rich synopsis paragraphs, not one-word labels
- **Glass UI** — Dark theme with frosted glass nodes, animated thinking indicators
- **File linking** — Link local files or Drive/Dropbox URLs to any node
- **Markdown export** — Download your mind map as .md for LLM handoff
- **PWA** — Install to desktop, works offline
- **Zero dependencies** — One HTML file, one CSS file, one JS file. No npm, no build step, no server

## API Keys

Get an API key from [Groq](https://console.groq.com) (fast, dirt cheap — fractions of a cent per request). Paste it into `config.js` on the first profile line. More keys for other providers go in the same file or in Settings (🎨).

## Sharing

The folder IS the app. Zip it and email it. Delete `config.js` before sharing — recipients copy `config.example.js` and add their own keys.

## License

**PolyForm Shield** — Free for personal, academic, and non-commercial use. Businesses using this tool to generate revenue need a commercial license. Contact the repo owner for terms.
