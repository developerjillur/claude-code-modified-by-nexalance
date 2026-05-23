# Changelog

## [0.2.12] - 2026-05-23 — Queue drains the whole Stop-hook chain

### Fixed — Only one item was firing per Claude continuation chain

Symptom (visible to the user): hook fired once, queue went from 7 → 6, then nothing else happened even as Claude completed multiple subsequent turns.

Root cause: when our hook returns `{decision:"block", reason:...}` Claude continues, completes the work, then fires the next Stop event with `stop_hook_active: true`. Previous versions treated that flag as a hard "loop-protection: bail" signal and returned `{}` immediately. So the queue only ever drained ONE item per continuation chain. Every subsequent Stop in the same chain was ignored.

This was over-defensive. Our hook is safe to fire repeatedly because **it drains the queue every fire** — the queue is naturally bounded, so a real infinite loop is impossible. The `stop_hook_active` check belonged to hooks that always emit `decision:block` (those would loop forever); ours doesn't, so the check just stalled normal usage.

### How v0.2.12 handles it

- The early `if (stop_hook_active) return {}` is removed. Every Stop fire drains one queue item until the queue is empty.
- A new per-workspace `block-chain.json` counter tracks consecutive `decision:block` fires within a 5-minute window. If we ever fire more than **200 consecutive block-responses** in a single chain (truly pathological — would only happen with a multi-hundred-item queue that all use the feedback fallback path), we let Claude stop as a last-resort safety. Resets automatically after 5 minutes of idle.
- When osascript native submit succeeds, that path doesn't carry `stop_hook_active` forward at all — each item becomes a clean separate user turn. The cap only matters for the feedback fallback path.

### Tests

```
=== v0.2.12 — drain continues across stop_hook_active chain ===
  ✓ stop_hook_active=true still drains queue (was the v0.2.11 bug)
  ✓ queue advanced from 2 → 1 even with stop_hook_active=true
  ✓ second fire with stop_hook_active continues to drain
  ✓ queue fully drained
=== v0.2.12 — consecutive-block safety cap ===
  ✓ count > MAX_CONSECUTIVE_BLOCK_FIRES → no decision (cap honoured)
```

## [0.2.11] - 2026-05-23 — Hardening pass (gaps audit + improvements)

### Fixed — Workspace dir mismatch when paths weren't canonicalized

The extension fed `vscode.workspace.workspaceFolders[0].uri.fsPath` into the workspace hasher, the hook fed `event.cwd`. These usually match, but a **trailing slash, redundant `./`, or symlinked workspace path** produced different SHA-1 prefixes → the extension and hook silently wrote to different per-workspace dirs and never saw each other's queue.

`canonicalizeWorkspacePath()` now wraps both inputs in `fs.realpathSync(path.resolve(p))` (with a graceful fallback when realpath fails). Same function in both `src/hook-setup.ts` and `assets/stop-hook.js`. A self-test proves `foo`, `foo/`, `foo/./`, and a symlink to `foo` all hash to the identical workspace dir.

### Fixed — Malformed queue entries no longer crash the UI

`loadQueueFromFile` used to return the raw parsed array as-is. A partial corruption or hand-edit could leave entries missing `id`/`text`, and the webview's `onclick="steerItem('undefined')"` then failed silently. The loader now drops invalid entries, repairs missing `createdAt` to `Date.now()`, and filters attachment arrays down to string entries only.

Self-test feeds a 9-element mixed-validity JSON and asserts 4 valid entries survive with attachments correctly filtered.

### Added — 10 MB cap on pasted-image attachments

`saveBase64Image` now throws `ImageTooLargeError` (with `actualBytes`/`maxBytes`) when the decoded payload exceeds 10 MB. The extension surfaces a friendly note: *"Image too large (X MB). Limit is 10 MB per paste. Resize or screenshot a smaller region."* This prevents `~/.claude/claude-mod-attachments/` from silently filling up when someone pastes a 6K monitor screenshot.

### Added — In-flight spinner on Fire-now + a VS Code notification when permission is missing

- The Fire-now button shows a spinner labelled "Firing…" while osascript runs, so multi-second kicks are visually accounted for.
- When a kick fails because of macOS permission (ETIMEDOUT / -1743 / "not authorized"), the extension now pops a VS Code warning with two action buttons:
  - **Open System Settings** — deep-links to Privacy → Automation
  - **Run Probe** — re-attempts the osascript probe
- The Native-submit status pill + inline help card update from the same event.

### Tests — 12 groups, 90+ assertions, all green

```
=== Webview script boots cleanly                          ✓
=== Per-workspace queue isolation                          ✓
=== Stop-event loop protection                             ✓
=== Native-vs-feedback paths                               ✓
=== Setup module — install/uninstall + stable hook script  ✓
=== getPathsForWorkspace returns workspace-scoped paths    ✓
=== Atomic write integrity                                 ✓
=== v0.2.11 path canonicalization                          ✓  ← new
=== v0.2.11 queue integrity validation                     ✓  ← new
=== v0.2.11 image size cap                                 ✓  ← new
=== Auto-kick safeguard surface                            ✓
=== Attachment helpers                                     ✓
```

## [0.2.10] - 2026-05-23 — Auto-kick is back (with v0.2.4's "kick storm" bug fixed)

### Diagnosed — pending items sat forever when Claude was already idle

Since v0.2.5 the queue only drained via two paths: the Stop hook (when Claude finishes a turn) and the manual ▶ Fire now button. Neither fires when Claude is already idle waiting for input. So if you added 7 prompts to a queue while Claude was sitting at "Tell me when to proceed", nothing happened until you clicked Fire now — and the user kept asking why their pending items weren't going through.

### Fixed — Safer auto-kick reintroduced

The auto-kick gate now checks **four** things before firing (v0.2.4 only checked the queue transition, which was why it kept storming):

1. `claudeCodeModified.autoKickWhenIdle` is `true` (default — flip off if you don't want any auto-firing)
2. No other kick is currently in flight (`_kickInFlight` mutex, same as Fire-now)
3. Last auto-kick was more than **60 seconds** ago (`AUTO_KICK_COOLDOWN_MS`)
4. Stop hook hasn't fired in the last **30 seconds** (`HOOK_RECENT_THRESHOLD_MS`) — if it has, Claude is mid-flow and the hook is already draining the queue, no need to inject

The 60s cooldown is the key safeguard. Even if the user rapid-adds 10 prompts (each one technically a 0→1 transition after the previous kick consumes the head), only the first one auto-kicks. The other 9 just queue, and the hook drains them as Claude finishes each subsequent turn.

### Two trigger sites

- **On `saveQueue` from the webview** — typing a prompt into an empty queue fires the head if Claude looks idle.
- **On webview resolve (sidebar open)** — if there are pending items already in the queue when you open VS Code (or switch workspaces) AND Claude is idle, the head fires automatically. Same safeguards apply.

### Setting

`claudeCodeModified.autoKickWhenIdle` (default `true`) controls both trigger sites.

## [0.2.9] - 2026-05-23 — UI cleanup + inline permission setup help

### Removed — Long intro paragraph above the status card

The "This panel does NOT chat with Claude…" paragraph cluttered the top of the sidebar without adding much practical info after the first read. Removed.

### Added — Inline permission-help panel when native submit is failing

When `nativeStatus.ok === false` the sidebar now shows an amber inline help card with the exact step-by-step:

1. Click **Open prefs** → System Settings opens to Privacy & Security → Automation
2. Find **Visual Studio Code** in the list (Probe native first if it isn't there — that adds it)
3. Expand it and turn on **System Events**
4. Come back and click **Probe native** — pill should flip to ✓ working

Plus a copy-able `tccutil reset AppleEvents com.microsoft.VSCode` command for the case where macOS got into a stuck-denied state and needs to be reset.

The card disappears automatically once the pill flips to ok.

## [0.2.8] - 2026-05-23 — Per-workspace queues

### Changed — Queues are now scoped to the project / workspace

v0.2.7 stored one global queue at `~/.claude/claude-mod-queue.json`. Items added while working on project A were visible — and would fire — when switching to project B. Not what most users want.

v0.2.8 keeps queue, history, and native-status per workspace:

```
~/.claude/claude-mod-queues/
  Kvanti-3-a3f5b2c1/
    queue.json
    history.json
    native-status.json
  psychgate-c41fd9a3/
    queue.json
    history.json
    native-status.json
  ...
```

- The workspace directory name combines a sanitized basename with a short SHA-1 hash of the absolute path, so it's stable across runs and tells you at a glance which project the dir belongs to.
- The **extension** resolves the workspace from `vscode.workspace.workspaceFolders[0].uri.fsPath`. Switching folders inside VS Code re-points the panel automatically.
- The **hook script** resolves the workspace from the Stop event's `cwd` field. Each Claude Code session reads/writes only its own project's queue.
- A **one-time migration** on first activation moves any existing `~/.claude/claude-mod-queue.json` contents into the current workspace's queue and renames the legacy file to `.migrated`.

### Self-tests

```
=== Per-workspace queue isolation (v0.2.8 core feature) ===
  ✓ workspace A has its own 2 items
  ✓ workspace B has its own 1 item
  ✓ hook with cwd=A returns A first prompt
  ✓ A queue now has 1 item
  ✓ B queue is UNTOUCHED (still 1 item)
  ✓ B item is unchanged
  ✓ hook with cwd=B returns B first prompt
  ✓ B queue is now empty
  ✓ A queue still has 1 item (cross-workspace isolation holds)
  ✓ A history has only A entry
  ✓ B history has only B entry
=== getPathsForWorkspace returns workspace-scoped paths ===
  ✓ different workspaces → different queue files
=== hook source ===
  ✓ hook source reads workspace from event.cwd
```

Plus all 60+ prior assertions still green.

## [0.2.7] - 2026-05-23 — Native-submit setup flow + 2s timeout

### Diagnosed — v0.2.6 fell back to feedback because Accessibility permission was missing

v0.2.6's hook tried `osascript` → System Events → keystroke into Claude's chat, but on a fresh machine the macOS Accessibility / Automation permission for VS Code isn't yet granted. The system silently blocks `System Events` calls until the user grants permission, so the call hung for the full 6-second timeout, and the hook fell back to its `decision:block + reason` path — every fired prompt kept appearing under the "Stop hook feedback:" label.

### Fixed in v0.2.7

- **Hook timeout 6s → 2s.** Bails fast on permission failure so Claude Code's Stop event isn't delayed.
- **Native-submit status breadcrumb.** The hook writes `~/.claude/claude-mod-native-status.json` with `{ok, lastError, timedOut, at}` on every fire. The extension reads this and surfaces it in the sidebar as a status pill.
- **New "Native submit" status pill** in the sidebar status card — green when working, red `✗ permission missing` when osascript times out, yellow `unknown — click Probe` before the first fire.
- **Two new buttons** in the status card:
  - **Probe native** — runs a 2.5s osascript ping to either confirm permission is OK or to trigger the macOS "Visual Studio Code wants to control System Events" prompt.
  - **Open prefs** — deep-links to System Settings → Privacy & Security → Automation so you can flip the toggle for VS Code.
- New commands: `claude-code-modified.probeAccessibility`, `claude-code-modified.openAccessibilityPrefs`.

### How to enable native submit (one-time)

1. Click **Probe native** in the sidebar status card.
2. macOS shows: *"Visual Studio Code wants to control System Events"* → click **OK**.
3. Pill flips to `✓ working`. From now on, every Stop hook fire types the prompt into Claude's chat as a real user message — no "Stop hook feedback:" prefix.

If you missed the prompt:

1. Click **Open prefs**.
2. In Automation, find **Visual Studio Code** in the list, expand it, enable **System Events**.
3. Click **Probe native** again — pill should flip to green.

## [0.2.6] - 2026-05-23 — Native submit (Stop hook types prompts as real user messages)

### Changed — Stop hook now delivers via osascript by default, falls back to feedback

Until now, every prompt the Stop hook fed to Claude appeared under the **"Stop hook feedback:"** label — Claude Code's standard rendering for `{decision:"block", reason:<text>}` hook responses. Functional, but visually unlike a regular user message.

v0.2.6 changes the hook to try a **native delivery first**:

1. Activate VS Code, focus the chat input via ⌘ Esc, paste the prompt from the clipboard, press Return.
2. The prompt shows up in Claude's chat as a real user message — same look as if you'd typed it yourself.
3. Claude responds to it as a normal user turn — no "Stop hook feedback:" prefix.

If osascript fails (Accessibility permission denied, VS Code not focusable, etc.) the hook **falls back** to the original `decision:block + reason` path so the prompt still reaches Claude — just under the old prefix. Either way the queue advances and the prompt is fed; the only difference is presentation.

Bypassable for headless / CI / debugging:

```bash
CLAUDE_MOD_DISABLE_NATIVE=1
```

…forces the feedback path. The self-test sets this so it never spawns osascript and never types into the developer's session.

### Tested before release

```
=== v0.2.6 native-vs-feedback delivery paths ===
  ✓ feedback fallback returns decision:block
  ✓ feedback fallback returns prompt as reason
  ✓ feedback fallback still consumes queue item
  ✓ hook source defines tryNativeSubmit
  ✓ hook source honours the disable env var
  ✓ hook source spawns osascript for native delivery
```

Plus all 14 prior test groups (66+ assertions) still green.

## [0.2.5] - 2026-05-23 — Fire on click (rolled back v0.2.4's auto-kick)

### Fixed — Runaway auto-kicks when Claude was already busy

v0.2.4's auto-kick fired the osascript helper every time the queue transitioned from empty → non-empty. The problem: `addPrompt` persists on every Enter, and the auto-kick checked only "no Stop hook fire in the last 45 seconds" — which is a poor proxy for "Claude is idle." If Claude was already mid-turn (after a previous kick), the next addPrompt would still see "no recent hook fire" and fire another kick. Rapid-add gave a barrage of kicks at a Claude that was still processing the previous one, and the sidebar filled with "Auto-kicked Claude with:" notes.

v0.2.5 rolls that back to a **fire-on-click** model:

- **The auto-kick on `saveQueue` is removed.** Adding a prompt now only writes to the queue file. Nothing else.
- The **▶ Fire now** button in the queue panel header is the explicit way to push the head item into Claude's chat via osascript.
- The Stop hook continues to drain the queue automatically as Claude finishes each turn — unchanged.
- Successful kicks no longer add a persistent "Auto-kicked Claude with:" note. Instead they record into the existing `~/.claude/claude-mod-history.json`, which the "Last fired by hook" panel already renders with a timestamp and a Clear button.
- A `_kickInFlight` guard prevents two kicks from overlapping (e.g. rapid Fire-now double-clicks).

The `claudeCodeModified.autoKickWhenIdle` setting is now `false` by default and reserved — no current code path reads it. A future version with reliable "Claude is mid-turn" detection (transcript-path inspection, busy-state pinging via a UserPromptSubmit hook, etc.) can re-introduce a controlled auto-kick.

## [0.2.4] - 2026-05-23 — Auto-kick (close the "Claude is already idle" gap)

### Added — Push pending prompts into Claude's chat when Claude is idle

Until now the queue only drained when Claude itself stopped (Stop-hook driven). If you added a prompt while Claude was already sitting idle at "Tell me when to proceed", nothing fired — the hook was waiting for a Stop event that never came.

v0.2.4 closes that gap by actively pushing the head pending prompt into Claude's chat input via macOS scripting:

1. Activate the VS Code app
2. Fire **⌘ Esc** (Anthropic's documented "focus chat input" shortcut)
3. Set the clipboard from a UTF-8 temp file, paste with **⌘ V**
4. Press **Return** to submit

Two trigger paths:

- **Manual:** new **▶ Fire now** button in the queue panel header (green, only visible when items are pending). Click anytime to push the head pending prompt.
- **Automatic:** when the queue transitions from empty → non-empty AND the Stop hook hasn't fired in the last 45 seconds (i.e. Claude appears idle), the head item is auto-pushed. Setting `claudeCodeModified.autoKickWhenIdle` (default `true`) controls this.

Safety: on kick failure the item is put back at the head of the queue (nothing is lost). First run shows the standard macOS Accessibility permission prompt for VS Code — once granted, kicks run silently.

### Why this required osascript

VS Code's extension API does not let one extension type into another extension's webview. Anthropic's Claude Code chat input is inside their webview. Without osascript, "fire a prompt into Claude's chat from outside" is impossible — which is the structural reason the queue had to wait for a Stop event. Osascript bridges the gap by interacting with VS Code at the OS level (System Events / Accessibility), which is the only sanctioned way to type into webview controls on macOS.

### Tested

```
=== Auto-kick module wiring (v0.2.4) ===
  ✓ kickClaudeCodeChat is exported
  ✓ empty text → success:false (no osascript spawned)
[Webview wiring]
  ✓ fireNow exposed on window (Fire-now button wired)
  ✓ fireNow() posts fireNow message to host
```

osascript itself is not invoked in tests (it would actually type into the user's session). The kick path is integration-tested by running the extension live.

## [0.2.3] - 2026-05-23 — File attachments + paste-image support

### Added — Attach files and paste images directly into a queued prompt

The input box now has a paperclip button and accepts pasted images. Both flows produce a small attachment chip above the input (with filename + remove button); when the prompt is added to the queue, its text gets an explicit `Attached files (please Read each one before answering):` block listing each absolute path. When the Stop hook fires that prompt, Claude sees the paths in context and can Read each one (PNG / JPG / etc. read by Read return as visual input for image-aware reasoning).

How it works:

- **Paperclip button → VS Code file picker.** Picked paths are sent from the host to the webview as `fileAttached` events and rendered as chips.
- **Paste image into textarea.** The paste listener captures `image/*` clipboard items, sends the base64 data to the extension host, which writes it to `~/.claude/claude-mod-attachments/paste-<ts>.<ext>` (atomic write, mime → extension mapping). Saved path comes back as a `fileAttached` event and becomes a chip.
- **Up to 10 attachments per prompt** to keep things sane.
- **Files stay on disk** at the saved path — Claude reads them on demand when the hook fires.

### Tested before release

Eight new self-test assertions cover the attachment flow:

```
[Attachment helpers]
  ✓ getAttachmentsDir returns non-empty path
  ✓ attachments dir exists after first call
  ✓ saveBase64Image returns .png path
  ✓ saveBase64Image writes a valid PNG (header bytes check)
  ✓ image/jpeg → .jpg extension
  ✓ unknown mime → .png fallback
[Webview wiring]
  ✓ pickFiles exposed on window (paperclip button wired)
  ✓ removeAttachment exposed on window (chip × button wired)
  ✓ pickFiles() posts pickFiles message to host
  ✓ fileAttached → addPrompt produces queued text containing the file path
  ✓ queued item carries attachments[] alongside text
```

## [0.2.2] - 2026-05-23 — Critical webview fix

### Fixed — Webview script error left the panel inert

A duplicate `const idx` declaration inside `openMoreMenu()` made the entire webview script throw a `SyntaxError` at load time. Symptoms:

- Stop hook status pill stuck on `checking…`
- Queue file label stuck on `—`
- Install hook / Uninstall hook button does nothing when clicked
- Add prompt textarea inert

The error happened before `window.addEventListener('message', ...)` registered, so the host's `status` / `restoreQueue` / `history` messages were dropped. Removed the redundant declaration.

### Added — Permanent webview boot regression test

The test harness now boots the compiled webview script under a mocked DOM + `vscode` API, then asserts that:

- `window.addEventListener('message', ...)` registered
- `onSetupClick`, `addPrompt`, `steerItem`, `deleteItem`, `moveUp`, `moveDown`, `openMoreMenu` all exposed on `window`
- An initial `requestStatus` message was posted to the host
- The host's `status` reply updates the pill text + queue file label
- Toggling `hookInstalled: true` flips the pill to `✓ installed`

This catches any future "panel renders but is inert" regression at build time, not in production.

## [0.2.1] - 2026-05-23 — Robustness, visible feedback, and UI polish

### Added — Visible hook activity (the missing feedback loop)

Previously, when the hook fired and consumed a pending prompt, the queue panel showed the item disappearing but gave no other confirmation. You had to trust that the hook actually fired.

The hook now appends each consumed prompt to `~/.claude/claude-mod-history.json` (last 50 entries, atomic write). The extension watches that file and renders a "Last fired by hook" panel with timestamp + prompt preview, so you can see in real time when the integration is working.

### Changed — Hook script lives at a stable path

v0.2.0 referenced the hook script inside the extension's versioned install folder (`~/.vscode/extensions/developerjillur.claude-code-modified-by-nexalance-0.2.0/assets/stop-hook.js`). When the extension updated to 0.2.1, that path no longer existed and the reference in `~/.claude/settings.json` broke.

v0.2.1 copies the hook to a stable location at `~/.claude/claude-mod-hook.js` on install and refreshes the copy automatically on every activation. The `settings.json` reference points to that stable path. Result: extension updates never break the hook.

### Changed — All file writes are now atomic

The queue file and the history file are written via a write-temp + rename pattern. The target file is never observed in a half-written state, even if the process exits mid-write. A `rapid-write × 20` consistency test exercises this in the self-tests.

### Changed — More reliable file watching

`fs.watch` is known to miss events on macOS when changes come from a different process (like our hook). The extension now combines `fs.watch` (responsive) with `fs.watchFile` polling (reliable), so external changes are always reflected in the sidebar within ~800ms.

### Changed — Hook command works with nvm / asdf node

The `command` in `settings.json` is now `/usr/bin/env node "<stable path>"` instead of bare `node`. This resolves to whichever node binary the shell finds on PATH, which means installations that use nvm or asdf no longer need to hard-code an absolute path.

### Changed — UI polish

- Steer button is hidden on the head item (it would be a no-op there).
- The ⋯ More menu gains **Move up** and **Move down** entries — visible only when the row can actually move in that direction.
- Textarea placeholder now mentions the Shift+Enter behavior so multi-line prompts are discoverable.
- Status card and history panel use consistent colour cues (green = active integration, orange = paused, red = not installed).

### Changed — Hook safety

- Uninstall removes ONLY our hook entry. Any other Stop hooks the user has configured are preserved (verified in a foreign-hook-preservation self-test).
- History file is capped at 50 entries to keep `~/.claude/` tidy.
- The hook tolerates malformed queue files (treats them as empty and allows the stop).

### Tested before release

Self-test harness (`src/hook-test.js`) runs the **real** compiled hook script + the **real** hook-setup module under a controlled `~/.claude/` (originals backed up and restored). 14 test groups covering 54 individual assertions:

```
[1]  empty queue → hook allows stop                       ✓
[2]  one pending → hook blocks stop and consumes it       ✓
[3]  history log appended on consumption                  ✓
[4]  multiple pending → consumed one at a time            ✓
[5]  stop_hook_active loop protection                     ✓
[6]  malformed queue file → safe fallback                 ✓
[7]  history is bounded (capped at 50 entries)            ✓
[8]  refreshStableHookScript copies bundled hook          ✓
[9]  refresh is idempotent (no rewrite when unchanged)    ✓
[10] install uses STABLE path, /usr/bin/env node          ✓
[11] re-install is idempotent (only one entry)            ✓
[12] uninstall preserves foreign hook entries             ✓
[13] atomicWriteFile leaves no .tmp residue               ✓
[14] saveQueueToFile rapid-write consistency × 20         ✓
                                                       54/54 PASS
```

## [0.2.0] - 2026-05-23 — Hook-Integrated (major rewrite)

### Changed — Architecture rewritten to match the actual user vision

v0.1.x was conceptually wrong: it ran its own Claude CLI subprocess inside the sidebar, which gave each prompt its own session and never integrated with the user's existing Anthropic Claude Code chat.

The user's actual ask: the queue panel **only manages pending prompts** — the actual chat must happen in Anthropic's official Claude Code extension, and pending prompts must be auto-fed into that session when the current turn fully finishes (including any clarifying questions Claude asks).

v0.2.0 implements that:

- **Chat UI removed.** This extension no longer spawns `claude` or renders messages. It is purely a queue manager.
- **Queue persisted to `~/.claude/claude-mod-queue.json`** so an external hook script can read it.
- **Stop hook installed into `~/.claude/settings.json`** via a one-click setup button. The hook runs every time Claude Code finishes a turn, reads the next pending prompt, removes it from the queue file, and returns `{"decision":"block","reason":<prompt>}` so Claude Code continues with that prompt as its next instruction.
- **Loop protection.** The hook honours `stop_hook_active` from the incoming event so we never recursively trigger ourselves.
- **Status card** at the top of the panel shows hook install state with an Install/Uninstall button.
- **Behaviour the user explicitly asked for:** prompts only fire once the current turn is fully done. If Claude asks the user a clarifying question mid-turn, the queue does NOT fire — Claude only "stops" once the conversation reaches a natural quiet point, and that is exactly when our hook gets called.

### Self-tested before release

A Node.js test harness (`src/hook-test.js`) runs the real compiled hook script against a controlled queue file and verifies all 22 invariants:

```
Test 1: empty queue → hook allows stop                            ✓
Test 2: queue with one pending → hook blocks stop with the prompt ✓
Test 3: queue with three pending → consumed one at a time          ✓
Test 4: stop_hook_active loop protection                           ✓
Test 5: malformed queue file → safe fallback                       ✓
Test 6: installHook / isHookInstalled / uninstallHook round trip   ✓
                                                                 22/22
✅ ALL HOOK TESTS PASSED
```

## [0.1.4] - 2026-05-23

### Changed — Manual Run model (matches the real user request)

v0.1.3 was still wrong: it auto-fired prompts the moment Claude was idle, which the user kept seeing as "directly going to working" — not what they wanted.

The actual ask: "I want to submit many prompts at once, they all stay pending in the queue, and when the running/current prompt's work is done, the first pending prompt auto-submits."

Implemented:

- Every prompt added to the queue is **PENDING**. Nothing fires automatically when you add it — even if Claude is idle.
- A new **▶ Run queue** button in the queue panel header is the only way to start the very first item.
- Once the queue is running, each completion **auto-fires the next pending item** until the queue is empty (or you click Pause / Stop / Clear all).
- The Run button hides itself while Claude is processing and reappears when Claude is idle.
- A status line in the panel header now reads `N pending — click Run queue to start` (idle), `Running · N pending` (active), or `Paused · N pending`.
- Pressing Enter on an empty textarea no longer triggers anything.

### Self-tested before release

A Node.js test harness (`src/queue-logic-test.js`) loads the compiled webview JS, mocks the DOM + the `vscode` API, simulates user actions, and verifies all 19 invariants:

```
Test: empty queue, manual Run does nothing harmful
Test: typing prompts does NOT auto-fire (manual-run model)
Test: clicking Run queue fires head item only
Test: completion auto-fires next pending
Test: completion of prompt 2 auto-fires prompt 3
Test: completion with empty queue does NOT fire anything
Test: pause blocks auto-fire
Test: stop request from empty-input + busy click
Test: queue persistence wrote each change
```

All assertions green before this VSIX was packaged.

## [0.1.3] - 2026-05-23

### Changed — Always-Queue model (matches user's mental model)

Versions 0.1.0 → 0.1.2 had a split flow that turned out to be the wrong mental model:
- "If Claude is idle → submit directly. If Claude is busy → queue."

The user's actual ask was simpler:
- "I want to submit many prompts at once, they all stay pending in the queue, and when the current task finishes the first pending one auto-fires."

This is now the actual behaviour:

1. **Every send goes into the queue.** There is no direct-submit path anymore. The queue is the single source of truth.
2. **If Claude is idle when you queue something, the head item fires immediately** (no 10s wait, no countdown).
3. **If Claude is busy, the prompt simply waits** in the queue. When the current task finishes, the next pending prompt fires instantly.
4. **Empty-Enter no longer stops Claude.** Pressing Enter on an empty textarea now does nothing. Stop only happens when the visible stop icon (orange square) on the button is clicked while the textarea is empty.

The old 10-second auto-submit countdown is gone — it had no purpose under the new model.

## [0.1.2] - 2026-05-23

### Added — Auto-open on VS Code startup

Every time VS Code is opened the Claude Mod sidebar now opens itself automatically. No need to hunt for the activity-bar icon — the chat panel is just there.

- Activation event changed to `onStartupFinished` so the extension wakes up after every workbench reload.
- New setting `claudeCodeModified.autoOpenOnStartup` (default `true`) controls this behavior. Turn off for users who find it intrusive.
- Implementation: a deferred `workbench.view.extension.claude-code-modified` command runs 600 ms after activation, giving the workbench time to restore its layout before the sidebar steals focus.

## [0.1.1] - 2026-05-23

### Fixed — Activity bar icon was invisible

v0.1.0 specified the activity-bar icon as a codicon string (`$(comment-discussion)`), but VS Code's `viewsContainers.activitybar` does not resolve codicons — only SVG/PNG file paths. Result: the activity-bar entry rendered with no visible icon, making the sidebar very hard to find.

- Added `assets/icon.svg` (a distinctive three-row stacked queue icon — looks like rows in a list, not a speech bubble).
- Updated `viewsContainers.activitybar[0].icon` to point to the SVG.
- Renamed the activity-bar title from `Claude Mod` to `Claude Mod (by NexaLance)` for clarity when hovering over the icon.

## [0.1.0] - 2026-05-23

Initial release. A fresh, minimal extension — separate from `claude-codeui-by-nexalance`. Contains only:

- Codex-style chat panel with rounded input box and circular send button.
- Codex-style prompt queue (Steer / Delete / More menu with Edit / Move-to-top / Cancel).
- 10s auto-submit countdown with Pause/Resume.
- Workspace-scoped queue persistence.
- Visible green identification pill in the header.
- `--dangerously-skip-permissions` opt-in (default on, matches Codex's "Full access").

Sits side-by-side with Anthropic's official Claude Code extension. Auto-updates of either extension do not touch the other.
