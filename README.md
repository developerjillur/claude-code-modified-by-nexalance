# Claude Code Modified by NexaLance

A **prompt queue manager** for Anthropic's official Claude Code extension. Stack up follow-up prompts while Claude is working, and they auto-fire one at a time as each turn finishes — Codex-style for Claude Code.

This is a **thin companion** extension: it does NOT chat with Claude itself, does NOT modify Anthropic's extension, and does NOT inject keystrokes into the chat input. It writes pending prompts to a queue file, and a Claude Code `Stop` hook feeds them back into your real Claude Code session each time Claude finishes a turn.

**Current stable version: `v0.3.1` ✅ Confirmed working.** Earlier versions (v0.2.4 → v0.3.0) all silently failed in monorepo projects — do not use them. See [Version history & lessons learned](#version-history--lessons-learned) below for the full story.

---

## Quick start

1. Download the latest VSIX from [GitHub Releases](https://github.com/developerjillur/claude-code-modified-by-nexalance/releases/latest).
2. Install it:
   ```bash
   code --install-extension claude-code-modified-by-nexalance-0.3.1.vsix
   ```
3. Reload VS Code. The **Claude Mod** sidebar opens automatically.
4. Click the green **Install hook** button in the panel's status card. This:
   - Writes a Stop hook into `~/.claude/settings.json`
   - Copies the bundled hook script to `~/.claude/claude-mod-hook.js` (a stable path so extension upgrades don't break it)
5. **If your project has its own `.claude/settings.json`** (most monorepos do — many template repos register their own hooks), you need to **also register our hook in that file**. See [Monorepo / project-settings setup](#monorepo--project-settings-setup) below — this is the most common gotcha.
6. Open Anthropic's Claude Code chat normally and send your first prompt.
7. While Claude is working, type follow-up prompts into the Claude Mod sidebar. They stack as pending.
8. When Claude finishes its turn, the Stop hook fires → drains the queue head → Claude continues with that prompt → chain runs until queue is empty.

The history panel at the bottom of the sidebar shows the timestamp + text of each prompt the hook has fired, so you have visible confirmation that the integration is working.

---

## How v0.3.1 works (the architecture you actually need to know)

```
┌──────────────────────┐                                ┌─────────────────────────────────────────────────────┐
│  Claude Mod sidebar  │  writes per-workspace queue   │  ~/.claude/claude-mod-queues/<root>-<sha1>/         │
│  (this extension)    │ ───────────────────────────▶  │    queue.json   ← pending prompts                   │
│                      │  watches files for changes    │    history.json ← drained prompts (last 50)         │
│                      │                                │    block-chain.json ← consecutive-fire counter      │
└──────────────────────┘                                └─────────────────────────────────────────────────────┘
                                                                              ▲
                                                                              │ reads, shifts head, atomic write
                                                                              │
                                                       ┌──────────────────────────────────────────────────┐
                                                       │  ~/.claude/claude-mod-hook.js  (stable path)     │
                                                       │  • reads event.cwd                               │
                                                       │  • walks UP parent dirs to find populated queue  │  ◀── v0.3.1 fix
                                                       │  • returns {decision:"block", reason:<prompt>}   │
                                                       └──────────────────────────────────────────────────┘
                                                                              ▲
                                                                              │ fires every Stop event
                                                                              │
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  Anthropic Claude Code extension (anthropic.claude-code) — your real chat                              │
│  • Hook command is registered in either ~/.claude/settings.json (user) OR <project>/.claude/settings.json (project)
│  • Project-level settings OVERRIDE user-level for hooks                                                │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### The key invariants

1. **Per-workspace queues.** Each VS Code workspace gets its own queue at `~/.claude/claude-mod-queues/<basename>-<sha1[0..8]>/queue.json`. Switching projects in VS Code doesn't cross-contaminate queues.
2. **Path canonicalization.** The workspace name is computed from `fs.realpathSync(path.resolve(workspacePath))` so `Kvanti-3`, `Kvanti-3/`, `Kvanti-3/./`, and a symlink pointing to it all hash to the **same** queue dir.
3. **Walk-UP for monorepos (v0.3.1).** When the hook fires, it reads Claude Code's `event.cwd`. If `cwd` is a subfolder of the workspace (the common monorepo layout — e.g. `Kvanti-3/frontend/`), the hook walks UP parent dirs (bounded to 12 levels) and uses the first parent whose `queue.json` has at least one item. Drain + history are written back to **that found dir**, so the sidebar UI (watching the root dir) sees drains in real time.
4. **Atomic writes.** Every queue / history / chain-counter write is `write-tmp + rename`. Process exit during write can't corrupt anything.
5. **Loop protection.** The hook tracks consecutive `decision:block` fires per workspace in `block-chain.json`. Capped at 200 fires per 5-minute window — if exceeded, the hook returns `{}` so Claude can stop. Reset after 5 min of inactivity.
6. **Stable hook path.** Hook script lives at `~/.claude/claude-mod-hook.js`, NOT inside the extension's versioned install folder. Extension upgrades replace the bundled asset and refresh the stable path on activation, so the reference in `settings.json` never breaks.
7. **`decision: block + reason` is the only submission method.** No osascript, no native injection, no Claude Code internal commands. The "Stop hook feedback:" label that Claude shows is cosmetic — Claude treats the content as instructions.

---

## Monorepo / project-settings setup

**Read this if your queue items aren't draining.** This is the gotcha that wasted 23 days of development.

### The problem

Claude Code reads hook settings from FIVE sources in order: `userSettings` (your `~/.claude/settings.json`), then `projectSettings` (`<project>/.claude/settings.json`), then `localSettings` (`<project>/.claude/settings.local.json`), then flag/policy. **Project hooks OVERRIDE user hooks.** If your project has its own `.claude/settings.json` with a `hooks.Stop` entry (many template projects do — for MemPalace, Wiki ingest, etc.), our hook in your user-level settings will be **silently ignored**.

You can confirm this is happening if:
- The sidebar's `Install hook` button shows ✓ installed
- You have queued items pending
- Claude finishes turns but the queue never drains
- The project has a `<project>/.claude/settings.json` file

### The fix

Add our hook command to the project-level `.claude/settings.json` Stop array, **alongside** (not replacing) any existing entries. Both run.

Example: a project that already has a mempalace Stop hook. Edit `<project>/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 -m mempalace.hooks.save_hook 2>>~/.mempalace-hook.log || true"
          },
          {
            "type": "command",
            "command": "/usr/bin/env node \"/Users/<you>/.claude/claude-mod-hook.js\" # claude-mod-stop-hook"
          }
        ]
      }
    ]
  }
}
```

Both hooks fire on every Stop event. mempalace does its thing; ours drains our queue.

### Future versions will automate this

The extension's `Install hook` button currently only writes to `~/.claude/settings.json`. A planned enhancement (tracked for v0.3.2+) will:
- Detect when the current workspace has a `<workspace>/.claude/settings.json`
- Offer a "Also install in project settings" button
- Merge (not overwrite) our hook into the project's existing Stop array

Until then, do the project-settings edit manually if your queue isn't draining.

---

## Files this extension writes

| Path | Purpose |
|---|---|
| `~/.claude/claude-mod-queues/<basename>-<sha1>/queue.json` | Pending queue (per-workspace). Written by sidebar, read+shifted by hook. |
| `~/.claude/claude-mod-queues/<basename>-<sha1>/history.json` | Last 50 fired prompts (per-workspace), for sidebar's "Last fired by hook" panel. |
| `~/.claude/claude-mod-queues/<basename>-<sha1>/block-chain.json` | Consecutive `decision:block` fires counter, for loop-protection cap. |
| `~/.claude/claude-mod-hook.js` | The hook script (stable path). Refreshed on every extension activation. |
| `~/.claude/claude-mod-attachments/` | Pasted images and attached files. Queued prompt text references absolute paths so Claude can `Read` them when the hook fires. |
| `~/.claude/settings.json` (modified) | One entry added to `hooks.Stop`. Other hooks/settings left alone. |
| `<project>/.claude/settings.json` (you may need to modify manually) | Add our hook to the existing `Stop` array if the project has its own settings file — see [Monorepo setup](#monorepo--project-settings-setup). |

All file writes are **atomic** (`write-to-temp + rename`).

---

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `claudeCodeModified.autoOpenOnStartup` | `true` | Open the Claude Mod sidebar automatically every time VS Code starts. Turn off if intrusive. |

---

## Commands

| Command | Purpose |
|---|---|
| `Claude Mod: Open Claude Mod queue panel` | Focus the sidebar. |
| `Claude Mod: Install Stop hook into ~/.claude/settings.json` | Same as clicking the green Install hook button. |
| `Claude Mod: Uninstall Stop hook from ~/.claude/settings.json` | Removes only our hook entry; leaves other Stop hooks intact. |

---

## Version history & lessons learned

This section exists so the next person (including future-you) doesn't repeat the 23 days of dead ends we already went through. Read it before changing the submission method.

### The dream vs. the achievable

| Dream (user's original ask) | What's actually achievable |
|---|---|
| Add prompts → walk away → all auto-fire even when Claude is idle | Not possible. Anthropic doesn't expose a submit command for external use. Stop hook only fires when Claude **finishes** a turn. |
| Prompts appear in Claude's chat as real user messages (no "Stop hook feedback:" label) | Not possible reliably. Claude's webview React handler ignores synthesized Enter keys, so osascript paste lands in the input box but never submits. |
| Closest achievable: **add prompts → continue normal chat → each Claude turn drains one queue item → chain runs until empty** | ✅ This is what v0.3.1 delivers. |

### Version-by-version

| Version | Approach | Result | Lesson |
|---|---|---|---|
| **v0.1.0–v0.1.4** | Extension ran its own `claude` CLI subprocess in the sidebar | ❌ Wrong mental model — each prompt got its own Claude session, never integrated with the user's existing Claude Code chat | The queue must feed into the **same Claude conversation**, not spawn new ones |
| **v0.2.0** ⭐ | Removed own chat. Queue → file → `Stop` hook returns `{decision:"block", reason:<prompt>}` to continue Claude's existing turn | ✅ User confirmed "okay great now it is that what i looking for" | The `Stop` hook + `decision:block` flow is the **right architecture**. Never re-litigate this. |
| **v0.2.1** | Stable hook path at `~/.claude/claude-mod-hook.js`, atomic writes, history panel, robust file watching | ✅ Improvements only, design unchanged | Versioned extension paths break on upgrade — always use a stable path |
| **v0.2.2** | Critical: fixed `const idx` duplicate declaration that broke the entire webview script silently | ✅ Added permanent webview boot regression test | One syntax error in webview = entire panel becomes inert; needs a boot smoke test |
| **v0.2.3** | File attachments + paste-image support | ✅ | Attached files are referenced by absolute path in the prompt text; Claude `Read`s them when the hook fires |
| **v0.2.4** | First osascript "auto-kick" — when queue goes from empty → non-empty and Claude looks idle, paste the head item via System Events + Cmd+V + Return | ⚠ Worked sometimes, but caused "kick storms" when Claude was actually mid-turn | Inferring "Claude is idle" from Stop event history is unreliable |
| **v0.2.5** | Rolled back auto-kick to manual "Fire now" button only | ⚠ Removed the kick storm but lost auto-drain when Claude was idle | |
| **v0.2.6** | Tried native submit by default in the Stop hook itself (osascript first, feedback fallback) | ❌ macOS Accessibility permission missing on fresh machines → 6-second timeout per fire | Hook timeout must be short or it blocks Claude's stop event |
| **v0.2.7** | 2s timeout + native-submit status pill + Probe button + Open prefs button + setup walkthrough | ⚠ Helped users grant permission but submission still flaky in practice | OS-level permission UX is a rabbit hole; even when granted, the underlying submit method was unreliable |
| **v0.2.8** | **Per-workspace queues** at `~/.claude/claude-mod-queues/<root>-<sha1>/...` (replaced single global queue file) | ⚠ Architecturally correct, but introduced **the monorepo silent-fail bug** (sidebar uses workspace root, hook uses Claude cwd — different sha1 hashes when cwd is a subfolder) | **This is the bug nobody noticed for 23 days.** When sidebar and hook compute different queue dirs, they never meet, and the symptom is indistinguishable from "hook didn't fire" |
| **v0.2.9** | UI cleanup + inline permission help card | Cosmetic | |
| **v0.2.10** | Re-introduced auto-kick with 4 safeguards (in-flight mutex, 60s cooldown, hook-recent threshold, setting) | ⚠ Better, but still chasing the wrong problem (the silent monorepo failure) | |
| **v0.2.11** | Path canonicalization (`fs.realpathSync` for trailing slash + symlink consistency), queue integrity validation, 10 MB image cap, in-flight spinner | ✅ Useful improvements, but the monorepo bug remained hidden | Atomic writes + canonical paths are non-negotiable, but solving them doesn't solve the deeper config-path mismatch |
| **v0.2.12** | Hook drains the whole `stop_hook_active` chain (previously stopped after one item per Claude continuation) | ✅ Important fix | Loop protection should be a *cap* (e.g. 200 fires / 5 min), not a hard "first fire only" |
| **v0.2.13** | 30-second periodic watchdog auto-kick | ⚠ Added because hooks "sometimes don't fire" — turned out the real cause was the monorepo bug, not Claude Code missing events | Don't add timers to compensate for what you think is a flaky event source; instead, log and verify the event source is actually being called |
| **v0.2.14** | Source-tagged history entries (`source: 'hook'` vs `'extension-kick'`) so watchdog doesn't fire mid-turn | ✅ Useful refinement | |
| **v0.2.15** | Added a second hook (`UserPromptSubmit`) to precisely detect Claude's busy state | ⚠ More moving parts, same root bug | |
| **v0.2.16** | In-memory `_lastSuccessfulKickAt` to close file-write race | ✅ Fix for a real race, but symptoms still showed because of the monorepo bug | |
| **v0.2.17** | Stale-submit recovery (kick anyway if LASTSUB > 2 min and no Stop) | ⚠ Still chasing symptoms | |
| **v0.2.18** | `claude-vscode.focus` call before osascript + post-kick verification with 5s poll | ❌ Verification kept reporting "kick didn't reach Claude" because of the monorepo bug, not because focus failed | |
| **v0.2.19** | Reversed: feedback (`decision:block`) became default, osascript opt-in | ⚠ Right direction, but auto-kick still disabled by default — too conservative | |
| **v0.2.20** | Re-enabled auto-kick + native by default with v0.2.18's verification safety net | ❌ User explicitly: "what the mother fucking it's still not getting working ?????????" | |
| **v0.3.0** | **Dropped osascript entirely.** Stop hook + `decision:block + reason` only. Removed ~1500 lines of unreliable osascript code. | ⚠ Honest design, but the monorepo bug **was still present** because nobody had spotted it yet | Removing a flaky path makes the real bug visible. Don't keep adding code on top of a broken layer. |
| **v0.3.1** ⭐ | **Hook walks UP parent dirs from `cwd` to find the active queue.** Closes the monorepo silent-fail by making the hook tolerant of cwd-vs-workspace mismatch. | ✅ **CONFIRMED WORKING** in real Kvanti-3 monorepo session. This is the version to use. | Always log what the hook is actually doing. The monorepo bug was found in ~10 minutes once we added a per-invocation diagnostic logger to `~/.claude/claude-mod-hook.js` — should have done that on day one |

### The actual root cause of 23 days of failed versions

**Versions 0.2.8 through 0.3.0 all had a silent monorepo bug:**

- Sidebar used `vscode.workspace.workspaceFolders[0]` (the VS Code workspace root) to compute its queue dir.
- Hook used Claude Code's `Stop` event `cwd` (often a subfolder in monorepos) to compute its queue dir.
- The two SHA-1 hashes were different, so the two pieces wrote to / read from completely different folders.
- The hook fired correctly on every Claude turn — it just found an empty queue in its computed dir and returned `{}`.

That "returned `{}`" is **indistinguishable from "hook didn't fire" to the user**. So every diagnostic version (v0.2.13 watchdog, v0.2.15 UserPromptSubmit, v0.2.17 stale-submit recovery, v0.2.18 verification, etc.) was building elaborate machinery to "make the hook fire when it isn't" — when in reality, the hook was firing fine, just looking in the wrong place.

**Detection (v0.3.1):** appended one line per hook invocation to `~/.claude-mod-invocations.log`. Within 10 minutes saw entries like:

```
2026-05-24T14:04:21.126Z  cwd=/Users/.../Kvanti-3/kvanti-nextjs-frontend  argv=...
```

while the sidebar's queue was at `~/.claude/claude-mod-queues/Kvanti-3-3f2a19c9/...` — confirming cwd-vs-workspace mismatch.

**Fix (v0.3.1):** hook walks UP parent dirs of `event.cwd` and uses the first parent whose `queue.json` has items. All reads + writes go to that parent so the sidebar sees drains.

### What NOT to try again (ever)

1. **osascript / System Events / synthesized Enter to submit to Claude's chat.** Claude Code's React handler ignores synthesized Enter. 16+ versions of trying this; never reliable.
2. **Polling for "is Claude idle" to trigger auto-kicks.** Inferring busy/idle from event history is brittle. The Stop event itself is the only reliable signal — if Claude is idle, you cannot get the queue to drain without a real user turn.
3. **Spawning the standalone `claude` CLI with queued prompts.** This creates a separate Claude session, doesn't integrate with the user's active Claude Code chat.
4. **Looking for an internal Claude Code "submit" command.** v2.1.145 of Anthropic's extension does not expose one. Verified by grepping `extension.js` for all `commands.registerCommand` calls — the closest is `claude-vscode.focus`, which focuses the input but does not submit.
5. **Hard cooldowns or timers to compensate for "hook not firing".** If the hook isn't firing as you expect, **add an invocation logger first** and find the real reason. Don't build machinery on top of a misdiagnosis.

### What to ALWAYS do

1. Use the `Stop` hook + `decision:block + reason` flow. It is the only reliable submission method.
2. Use a stable hook path (`~/.claude/claude-mod-hook.js`), not a versioned extension folder.
3. Canonicalize workspace paths (`fs.realpathSync(path.resolve(p))`) before hashing them.
4. Atomic file writes for everything (`write-tmp + rename`).
5. Walk UP from `event.cwd` to find the active queue (monorepo fix).
6. Cap consecutive `decision:block` fires (200 / 5-min window) so a runaway loop can't lock Claude.
7. When debugging "hook isn't firing," **first** add a one-line invocation logger to the hook script and observe what `cwd` and `argv` Claude Code is actually passing. Don't add code based on assumptions.

---

## Troubleshooting

### "Hook is installed but queue items aren't draining"

The most likely cause is the **monorepo / project-settings issue**. Diagnose in order:

**1. Verify the hook script itself works.**
```bash
echo '{"cwd":"'"$PWD"'"}' | node ~/.claude/claude-mod-hook.js
```
If your workspace has queued items, this should print a `{"decision":"block","reason":"..."}` JSON. If it prints `{}` and you know you have queued items, it's a path-mismatch issue (see step 3).

**2. Verify Claude Code is actually invoking our hook.**

Add a temporary invocation logger to `~/.claude/claude-mod-hook.js` right after the `require()` lines:

```js
try {
  fs.appendFileSync(
    require('os').homedir() + '/.claude-mod-invocations.log',
    new Date().toISOString() + '  cwd=' + process.cwd() + '\n'
  );
} catch(_) {}
```

Then trigger a Claude turn in your project. Check the log:

```bash
cat ~/.claude-mod-invocations.log
```

- **Log gets new lines when Claude finishes turns** → hook IS being invoked. Skip to step 3.
- **Log stays empty** → Claude Code is NOT invoking the hook at all. Check `<project>/.claude/settings.json` — it's overriding your user-level settings. See [Monorepo setup](#monorepo--project-settings-setup).

**3. Verify cwd matches your sidebar's workspace.**

Compare:
- The `cwd` in the invocation log (where Claude Code is running)
- The path next to "Queue file" in the sidebar's status card (where the sidebar saved the queue)

If they're different (typical monorepo: cwd is a subfolder, sidebar is the repo root), v0.3.1's walk-UP logic handles it automatically. If you're on v0.3.0 or earlier, upgrade.

**4. After diagnosis, remove the invocation logger** to avoid filling `~/.claude-mod-invocations.log` over time.

### `/usr/bin/env: node: No such file or directory`

Your shell's `node` isn't on the PATH Claude Code spawns. Either install node system-wide, or edit the hook's `command` in `~/.claude/settings.json` to use an absolute path (`which node` to find it).

### "I want to disable the integration for one session"

Click **Uninstall hook** in the sidebar status card. The hook script stays on disk; only the `settings.json` reference is removed. Reinstall later.

### "Claude Code doesn't act on the fed prompts"

The `decision: block + reason` flow is documented Claude Code hooks behavior. If you're on an extremely old Claude Code version that doesn't support it, update Claude Code itself. Anthropic's extension version 2.1.145 (the one this was developed against) supports it cleanly.

---

## Self-tests

The repo ships two test harnesses:

```bash
npm run compile && node src/hook-test.js       # unit tests (60+ assertions)
node src/live-e2e-test.js                       # live E2E (33 assertions) — uses installed ~/.claude/claude-mod-hook.js
```

Both run against the real compiled hook + setup module under a controlled `~/.claude/` (originals backed up + restored). All assertions must be green before each VSIX is packaged.

Coverage highlights:

- Hook drains queue head + writes to history with `source: 'hook'`
- Multi-item chain drain via `stop_hook_active`
- Consecutive-block safety cap (200 / 5-min window) + chain reset after idle
- Per-workspace isolation (workspace A and B never see each other's queue)
- Path canonicalization: trailing slash, redundant `./`, and symlinks all resolve to the same dir
- **Walk-UP (v0.3.1):** subfolder cwd finds parent queue, same-folder cwd uses own queue, no-queue-anywhere returns `{}`, populated-subfolder-takes-priority-over-parent
- Atomic writes: no `.tmp` residue after `atomicWriteFile`
- Install / uninstall round-trip with foreign-hook preservation
- v0.3.0 cleanup: legacy `UserPromptSubmit` hook entry stripped on upgrade

---

## Side-by-side with Anthropic's extension

This is its **own** extension, owned by you. It does not touch Anthropic's installation:

| | Anthropic Claude Code | Claude Mod (this) |
|---|---|---|
| Publisher | `anthropic` | `DeveloperJillur` |
| Extension ID | `anthropic.claude-code` | `developerjillur.claude-code-modified-by-nexalance` |
| Folder | `~/.vscode/extensions/anthropic.claude-code-*` | `~/.vscode/extensions/developerjillur.claude-code-modified-by-nexalance-*` |
| Sidebar icon | "Claude Code" | "Claude Mod (by NexaLance)" |
| Auto-updates affect the other | No | No |

When Anthropic ships a new Claude Code version, VS Code updates *that* folder. This fork's folder stays untouched. The hook script lives at the stable path `~/.claude/claude-mod-hook.js`, so neither side breaks the other.

---

## Releasing a new version (maintainer notes)

1. Make code changes + update tests (add new ones for new behavior).
2. Bump `package.json` version.
3. Add a CHANGELOG entry — be honest about what worked, what didn't, and why. Include a table for breaking changes.
4. Run all tests:
   ```bash
   npm run compile && node src/hook-test.js && node src/live-e2e-test.js
   ```
   Both must be green.
5. Package:
   ```bash
   rm -f *.vsix && npx vsce package
   ```
6. Install locally to verify in your real workspace:
   ```bash
   code --uninstall-extension DeveloperJillur.claude-code-modified-by-nexalance
   code --install-extension ./claude-code-modified-by-nexalance-<version>.vsix
   ```
7. Commit + tag + push:
   ```bash
   git add . && git commit -m "vX.Y.Z — <one-line summary>"
   git push origin main
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
8. Create GitHub release with VSIX attached:
   ```bash
   gh release create vX.Y.Z ./*.vsix --title "vX.Y.Z — ..." --notes "..."
   ```
9. If the release is confirmed working in a live session, update the `stable` moving tag:
   ```bash
   git tag -f stable vX.Y.Z && git push origin stable --force
   ```

---

## License

MIT — Developer Jillur (DeveloperJillur).

---

## Acknowledgments

- Built against Anthropic's official Claude Code extension v2.1.145.
- Inspired by Codex CLI's prompt queue UX.
- The 23-day debugging odyssey that produced this design is documented above as a service to anyone who tries to extend Claude Code with external automation in the future.
