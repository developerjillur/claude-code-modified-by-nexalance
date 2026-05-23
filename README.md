# Claude Code Modified by NexaLance

A **prompt queue manager** for Anthropic's official Claude Code extension. Codex-style — stack up follow-up prompts while Claude is working, and they auto-fire one at a time as each turn finishes.

This is a thin companion: it does **not** chat with Claude itself and does **not** modify Anthropic's extension. It writes pending prompts to a file, and a Claude Code `Stop` hook feeds them into your real Claude Code session each time Claude tries to stop.

---

## Quick start

1. Install the VSIX:
   ```bash
   code --install-extension claude-code-modified-by-nexalance-*.vsix
   ```
2. Restart VS Code. The **Claude Mod** sidebar opens automatically (icon: three stacked horizontal bars).
3. Click the green **Install hook** button in the panel's status card. This edits `~/.claude/settings.json` and copies the hook script to `~/.claude/claude-mod-hook.js`.
4. Open Anthropic's Claude Code chat normally and send your first prompt to Claude.
5. While Claude is working, type follow-up prompts into the Claude Mod queue. They stack as pending.
6. When Claude finishes its current turn, the Stop hook fires and feeds the next pending prompt back into the same Claude conversation. Repeat until the queue is empty.

The history panel at the bottom of the sidebar shows the timestamp + text of each prompt the hook has fired, so you always have visible confirmation that the integration is working.

---

## How the integration works

```
┌──────────────────────┐     writes to     ┌──────────────────────────────────┐
│  Claude Mod sidebar  │ ───────────────▶  │ ~/.claude/claude-mod-queue.json  │
│  (this extension)    │                   └──────────────────────────────────┘
└──────────────────────┘                                ▲
                                                        │ reads, shifts head
                                                        │
                                          ┌──────────────────────────────────┐
                                          │  ~/.claude/claude-mod-hook.js    │
                                          │  (stop hook script)              │
                                          └──────────────────────────────────┘
                                                        ▲
                                          fires every time Claude tries to stop
                                                        │
┌──────────────────────────────────────────────────────────────────────────┐
│  Anthropic Claude Code extension — your real chat                        │
└──────────────────────────────────────────────────────────────────────────┘
```

When Claude tries to stop a turn, Claude Code runs every `Stop` hook listed in `~/.claude/settings.json`. Our hook:

- Reads `~/.claude/claude-mod-queue.json`
- If non-empty, takes the head item
- Atomically rewrites the queue file without that item
- Appends an entry to `~/.claude/claude-mod-history.json` so the UI can show "fired at HH:MM:SS"
- Returns `{"decision":"block","reason":<prompt>}` so Claude Code does **not** stop — it continues with the queued prompt as its next instruction

If the queue is empty, the hook returns `{}` and Claude stops normally.

**Loop protection:** the hook respects the `stop_hook_active` flag on the incoming event, so it never recursively triggers itself.

---

## Why this design (and not, say, typing into Anthropic's chat box programmatically)

VS Code sandboxes each extension's webview — one extension cannot read or type into another's UI. The official Claude Code extension does not expose a "send this text to the active chat" command. So an integration that *injects* into the visible chat input is not possible without brittle OS-level keystroke automation.

Claude Code's `Stop` hook is the supported, documented way to add follow-up work to an in-flight conversation. The queue manager + Stop hook combination achieves what you actually want — pending prompts being submitted as Claude's current turn fully completes — using only official APIs.

---

## Side-by-side with Anthropic's extension

This is its **own** extension, owned by you. It does not touch Anthropic's installation at all:

| | Anthropic Claude Code | This (Claude Mod by NexaLance) |
|---|---|---|
| Publisher | `anthropic` | `DeveloperJillur` |
| Extension ID | `anthropic.claude-code` | `developerjillur.claude-code-modified-by-nexalance` |
| Folder | `~/.vscode/extensions/anthropic.claude-code-*` | `~/.vscode/extensions/developerjillur.claude-code-modified-by-nexalance-*` |
| Sidebar icon | "Claude Code" | "Claude Mod (by NexaLance)" |
| Auto-updates affect the other? | No | No |

When Anthropic releases a new Claude Code version, VS Code updates *that* folder. Your fork's folder stays untouched, and the hook script lives at the stable path `~/.claude/claude-mod-hook.js` — so neither side breaks the other.

---

## Files this extension writes

| Path | Purpose |
|---|---|
| `~/.claude/claude-mod-queue.json` | The pending queue. Written by the extension's UI, read+shifted by the hook. |
| `~/.claude/claude-mod-history.json` | The last 50 prompts the hook has fired, for UI confirmation. |
| `~/.claude/claude-mod-hook.js` | The hook script. Copied from the extension's bundled assets on install + refreshed on every activation, so it always matches the current extension version. |
| `~/.claude/claude-mod-attachments/` | Pasted images and other files attached to queued prompts are stored here. The queued prompt's text references each by absolute path so Claude can Read them when the hook fires. |
| `~/.claude/settings.json` (modified) | The `hooks.Stop` array gets one entry referencing `claude-mod-hook.js`. Other hooks and settings in this file are left alone. |

All file writes are **atomic** (write-to-temp + rename), so an unexpected process exit cannot leave the queue file in a half-written state.

---

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `claudeCodeModified.autoOpenOnStartup` | `true` | Opens the Claude Mod sidebar automatically every time VS Code starts. Turn off if you find it intrusive. |

---

## Commands

| Command | Purpose |
|---|---|
| `Claude Mod: Open Claude Mod queue panel` | Focuses the sidebar. |
| `Claude Mod: Install Stop hook into ~/.claude/settings.json` | Same as clicking the green Install hook button. |
| `Claude Mod: Uninstall Stop hook from ~/.claude/settings.json` | Removes only our hook entry; leaves any other Stop hooks alone. |

---

## Troubleshooting

**The hook is installed but nothing fires when Claude stops.**
- Check `~/.claude/settings.json` — there should be an entry in `hooks.Stop` whose `command` contains `claude-mod-stop-hook`.
- Run the hook script manually with an empty stdin to make sure node can execute it:
  ```bash
  echo '{}' | node ~/.claude/claude-mod-hook.js
  ```
  It should print `{}` (no items) or a JSON object with `decision` (items present).

**`/usr/bin/env: node: No such file or directory`**
- Your shell's `node` isn't visible to Claude Code's hook runner. Either install node system-wide, or edit the hook's `command` in `~/.claude/settings.json` to point at the absolute node path you use (`which node`).

**I want to disable the integration for one session.**
- Click **Pause** is not a thing here — pause your queue by just not adding items, or click **Uninstall hook** in the sidebar status card. The hook script itself stays on disk; only the `settings.json` reference is removed.

**Hooks are running but Claude Code doesn't act on the fed prompts.**
- The `decision: block + reason` flow is a documented Claude Code hooks feature. If you're on an extremely old Claude Code version that doesn't support it, update Claude Code itself.

---

## Self-tested

The repo ships a Node test harness at `src/hook-test.js` that runs against the real compiled hook script + the real hook-setup module under a controlled `~/.claude/` (originals are backed up and restored). It checks 14 invariants across hook behavior, install/uninstall round-trip (including idempotency and foreign-hook preservation), history capping, atomic writes, and stable hook path resolution. All assertions are green before each VSIX is packaged.

```bash
npm run compile && node src/hook-test.js
```

---

## License

MIT — Developer Jillur.
