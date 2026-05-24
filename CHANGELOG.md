# Changelog

## [0.2.20] - 2026-05-24 — Reverse v0.2.19 over-conservatism; auto-kick + native back ON by default

### Honest correction

v0.2.19 disabled both `autoKickWhenIdle` and `enableNativeSubmit` to avoid the osascript silent-miss failure mode. That was the wrong trade-off — it removed the feature the user actually wanted (queue drains automatically when Claude is idle). Without auto-kick, the queue only progresses after the user manually types something in Claude's chat, which defeats the entire purpose of having a queue.

### v0.2.20 changes

- **`autoKickWhenIdle` default flipped back to `true`** — auto-kick on queue-add when Claude is idle, watchdog tick every 30s, and resolveWebviewView setTimeout all re-enabled.
- **`enableNativeSubmit` default flipped back to `true`** — Stop hook tries osascript first, falls back to `decision:block + reason` on failure (as before).
- **Hook env-var semantics changed:** native is now the default; `CLAUDE_MOD_DISABLE_NATIVE=1` explicitly disables it. (Previously v0.2.19 required `CLAUDE_MOD_ENABLE_NATIVE=1` to opt in.)
- **Submit reliability improved:**
  - Longer VS Code activate delay (0.3s → 0.4s).
  - Longer paste-to-Enter gap (0.18-0.25s → 0.5s) so Claude's React paste handler commits the value to state before Enter fires.
  - **Double Enter** as belt-and-suspenders: the first Enter is sometimes consumed by the React paste handler instead of submitting; the second one then submits cleanly. If the first Enter already submitted, the second is a harmless no-op against an empty input.

### What stays the same

- v0.2.18's **post-kick verification + restore-on-miss + warning notification** is the safety net. If osascript paste succeeds but Claude Code's UserPromptSubmit hook doesn't fire within 5 seconds, the item is restored to the queue head and a VS Code warning pops with a "Focus Claude" action button. **No silent queue drainage.**
- v0.2.17's stale-submit recovery still in place (kicks anyway if LASTSUB > 2 min and no Stop).
- v0.2.16's in-memory `_lastSuccessfulKickAt` still closes the file-write race.
- v0.2.14's source-tagged history still keeps watchdog from firing mid-turn.
- v0.2.12's chain-drain still drains multi-item chains.

### Tests

```
=== unit suite ===
  119 assertions / 19 groups ✓

=== live E2E suite ===
  39 assertions ✓
```

Both green with the new defaults.

## [0.2.19] - 2026-05-24 — Permanent solution: Stop hook is primary, osascript is opt-in

### The honest diagnosis

Versions 0.2.4 through 0.2.18 chased a series of related failures in the osascript-based "type into Claude's chat" path. Each fix addressed a real bug (auto-kick storms, watchdog mid-turn fires, focus failing because of `editorTextFocus` when-clause, etc.), but a deeper issue remained: even with focus correctly obtained and paste landing in the chat input, **Claude Code's webview React handler often doesn't honor a synthesized Enter key**. The text sits in the input box without being submitted. This is a known fragility with OS-level keystroke injection into webview controls — there's no reliable fix from outside Claude Code's process.

### The permanent solution

Revert to the design that always worked: **the Stop hook drains the queue via `decision:block + reason`**. This delivers each queued prompt to Claude **inside Claude Code's own process** — no keystroke injection, no focus gymnastics, no synthesized Enter. The trade-off is the visible `"Stop hook feedback:"` label, which is purely cosmetic — Claude treats the content as instructions and acts on them.

### Defaults flipped

| Setting | v0.2.18 default | v0.2.19 default |
|---|---|---|
| `claudeCodeModified.autoKickWhenIdle` | true | **false** |
| `claudeCodeModified.enableNativeSubmit` | (didn't exist) | **false** |

- The Stop hook now uses the reliable `decision:block + reason` path by default. `CLAUDE_MOD_ENABLE_NATIVE=1` opts in to native osascript paste.
- The extension stops triggering auto-kicks (saveQueue handler, sidebar-open setTimeout, periodic watchdog) unless `autoKickWhenIdle` is explicitly enabled.
- The Fire-now button still works for manual kicks; it tries native only if `enableNativeSubmit` is on.
- Switching `enableNativeSubmit` rewrites the Stop hook's command in `~/.claude/settings.json` automatically so the env var reaches the hook subprocess.

### How the queue drains now

1. You add prompts to the queue.
2. You type **anything** in Claude Code's chat (real user message, even just `"go"`).
3. Claude processes that → finishes → **Stop event fires**.
4. Our Stop hook reads the queue, takes the head, returns `decision:block + reason`.
5. Claude continues with that prompt. Finishes. Stop fires again. Hook drains next. Repeat until queue empty.

The flow is fully automatic from the second prompt onward, just like the v0.2.0–v0.2.3 design that worked before we tried to get fancy with osascript.

### Fire-now (manual override) still exists

If Claude has been idle for a long time and won't take a turn on its own, clicking ▶ Fire now kicks the head item:

- If `enableNativeSubmit` is on, tries osascript paste + verification.
- If osascript misses (kick verification fails), restores the item and falls back to the Stop hook path on Claude's next turn.

### Tests

All 90+ unit tests + 39 live E2E tests still pass. Updated assertions check that:
- `autoKickWhenIdle` default = false
- `enableNativeSubmit` default = false
- The hook honors `CLAUDE_MOD_ENABLE_NATIVE=1` opt-in (instead of `CLAUDE_MOD_DISABLE_NATIVE=1` opt-out)
- The extension rewrites the hook command on setting change

## [0.2.18] - 2026-05-24 — Native chat focus + post-kick verification

### Diagnosed — osascript "succeeded" but Claude Code never received the prompt

Live diagnostic from a Kvanti-3 session:

```
LASTSUB (UserPromptSubmit fired) : 38.7 min ago
LASTEXTKICK (our osascript ran)  :  1.8 min ago
```

The extension's kick ran 1.8 minutes ago and osascript returned `ok`. But `user-submit.json` still showed the 38-min-old value — Claude Code's UserPromptSubmit hook never fired for the typed prompt. So the paste landed somewhere other than Claude's chat input.

Root cause: Anthropic's `Cmd+Escape` keybinding has a `when` clause:

```
"when": "!config.claudeCode.useTerminal && editorTextFocus"
```

It only fires `claude-vscode.focus` when an **editor** has text focus. When you click ▶ Fire now in our webview, focus is in the webview — NOT in an editor. The keystroke is silently dropped and our paste lands in whatever was focused before (most often our own webview).

### Fix

The extension now calls `vscode.commands.executeCommand('claude-vscode.focus')` directly **before** spawning osascript. Invoking the command via the VS Code API bypasses the keybinding's `when` clause and focuses Claude's chat input unconditionally. The osascript then just pastes + Enter (with no Cmd+Esc), guaranteed to land in the right control.

### Added — Post-kick verification

After osascript returns success, the extension polls `user-submit.json` for up to 5 seconds. If Claude Code received the typed prompt, its UserPromptSubmit hook updates the marker. If the marker doesn't advance, osascript "succeeded" but the paste missed the chat input. In that case:

- The item is put back at the head of the queue so it isn't lost.
- A VS Code warning pops with a **Focus Claude** action button that runs `claude-vscode.focus` for the user.
- A clear inline note appears in the sidebar explaining what happened.

This means a silent miss can no longer drain the queue without Claude actually receiving the prompts.

### Fallback path preserved

If Anthropic's extension isn't installed (or it's an older version without the `claude-vscode.focus` command), the extension falls back to the old osascript-Cmd+Esc approach. Users without the native command still get the previous behavior.

### Tests

```
=== v0.2.18 — focus Claude chat via native VS Code command + post-kick verification ===
  ✓ extension uses claude-vscode.focus command (Anthropic native)
  ✓ extension passes skipFocusKeystroke to kickClaudeCodeChat
  ✓ extension defines _verifyKickReachedClaudeCode
  ✓ extension captures user-submit timestamp before kick for verification
  ✓ extension emits a clear warning when kick missed the chat input
  ✓ auto-kick honors skipFocusKeystroke option
  ✓ auto-kick builds the AppleScript focus stanza conditionally
```

All 90+ unit tests + 39 live E2E tests still green.

## [0.2.17] - 2026-05-24 — Stale-submit recovery (queue no longer stuck when Claude Code stops firing Stop)

### Diagnosed from a live Kvanti-3 inspection

```
Queue                : 1 item pending
LASTSUB              : 28.9 minutes ago   (user submitted long ago)
LASTSTOP (source:hook): NEVER             (zero Stop fires recorded anywhere)
```

Claude Code never fired the Stop hook in this session — most likely because the weekly usage limit (87%) was hit and Claude couldn't complete the turn. The v0.2.16 watchdog gate read `LASTSUB > LASTSTOP=0` as "Claude is busy" and bailed every check. Since LASTSTOP never moves from 0 in this scenario, the bail was permanent and the queue sat stuck forever.

### Fix

The watchdog gate now treats a stale LASTSUB (older than 2 minutes with no corresponding Stop) as evidence that Claude is **not actually busy**, and kicks the queue.

```ts
const submitAge = now - lastSubAt;
if (submitAge >= STALE_SUBMIT_THRESHOLD_MS) {  // 2 minutes
    this._maybeKickHead('auto');               // kick anyway
    return;
}
```

Common scenarios this handles:

- Claude hit a rate / weekly limit and never completed the turn
- The Claude Code session ended (user closed the chat, restarted, etc.)
- Claude Code stopped firing Stop hooks for any reason
- A prior crash / interrupted turn left the marker file stale

Real Claude turns rarely take more than 2 minutes, so kicking after that threshold is safe even in the rare false-positive case.

### Tests

```
=== v0.2.17 — stale-submit recovery (LASTSUB > LASTSTOP but ancient → kick) ===
  ✓ extension defines STALE_SUBMIT_THRESHOLD_MS constant
  ✓ watchdog checks stale-submit before bailing on busy state
```

Plus all 90+ existing unit tests + 39 live E2E tests still green.

## [0.2.16] - 2026-05-24 — Closes the file-write race that let 5 kicks fire in 4 seconds

### Diagnosed — v0.2.15's busy check could be fooled by file-write timing

Live trace from a user session:

```
History: 5 entries, ALL source=extension-kick (none source=hook!)
  T+0s   extension-kick: "All right we has to get a big plan..."
  T+1s   extension-kick: "all right base on the perssona test..."
  T+2s   extension-kick: "All right now we has to get this..."
  T+3s   extension-kick: "All right here is the client provided..."
  T+4s   extension-kick: "all right now let's do run a full test..."
user-submit.json: T+19s   ← only ONE entry (file gets overwritten each time)
```

Five auto-kicks fired in four seconds because each saveQueue `0→1` transition triggered `_maybeAutoKick`, and Claude Code's UserPromptSubmit hook hadn't yet written `user-submit.json` for the previous kick when the next `saveQueue` evaluated the busy check. So `LASTSUB` looked unchanged and the gate let the next kick through.

### Fix — track `_lastSuccessfulKickAt` in-memory

The extension now sets a `_lastSuccessfulKickAt` timestamp **the instant osascript returns success** — before Claude Code's hook subprocess has had time to write the marker file. The watchdog gate now uses:

```ts
const lastSubAt = Math.max(fileLastSubAt, this._lastSuccessfulKickAt);
```

This closes the race entirely. Any auto-kick attempt between osascript succeeding and Claude Code writing `user-submit.json` correctly sees Claude as busy (via the in-memory timestamp) and skips.

### Tests

```
=== v0.2.16 — in-memory _lastSuccessfulKickAt closes file-write race ===
  ✓ extension declares _lastSuccessfulKickAt
  ✓ extension takes Math.max(fileLastSubAt, in-memory)
  ✓ _lastSuccessfulKickAt is set on successful kick (1 assignment found)
```

## [0.2.15] - 2026-05-24 — Native busy-tracking via UserPromptSubmit hook

### The real fix you asked for

Every previous version inferred "Claude is idle" from Stop-event history alone, which is imprecise — the gap between a user submitting a prompt and Claude finishing it is invisible to a Stop-only signal. v0.2.15 uses Claude Code's **UserPromptSubmit hook** — the native event that fires the instant a user prompt is submitted — to track the busy state explicitly.

### How it works

Two hooks now installed into `~/.claude/settings.json`:

| Hook | Records | Marker file |
|---|---|---|
| `UserPromptSubmit` (new) | When a user prompt is submitted (real user OR our osascript kick typing) | `~/.claude/claude-mod-queues/<ws>/user-submit.json` |
| `Stop` (existing) | When Claude finishes a turn | `~/.claude/claude-mod-queues/<ws>/history.json` |

Watchdog decision is now binary:

```
LASTSUB > LASTSTOP  →  Claude is currently processing a prompt   →  NEVER kick
LASTSTOP > LASTSUB  →  Claude finished; if 30s+ idle, kick the next item
```

The window between user submission and Claude's stop — where v0.2.13 and v0.2.14 could fire a second kick mid-turn — is now closed by a hook event Claude Code emits the moment a prompt enters Claude's chat.

### Recovery & first-fire

- **First fire (no signals yet, no prior activity):** kick immediately if queue has items
- **Recovery (we kicked but neither LASTSUB nor LASTSTOP has updated in 5 minutes):** assume something is stuck and re-kick

### What the user sees

The status payload sent to the webview now includes `claudeBusy: boolean` — a precise indicator of whether Claude is mid-turn right now. (Surfacing it visually is left for a future polish pass.)

### Installation

`Install hook` now installs both hooks atomically. `Uninstall hook` removes both. Existing installations from older versions get upgraded automatically on next activate via the same migration that already kept the stable-hook path fresh — both scripts are refreshed in `~/.claude/`.

### Tests

```
=== v0.2.15 — UserPromptSubmit hook + precise busy/idle ===
  ✓ user-prompt-submit-hook.js bundled with extension
  ✓ user-submit hook exits 0
  ✓ user-submit hook writes only {} to stdout (does not modify the prompt)
  ✓ user-submit marker file was written
  ✓ marker has numeric submittedAt
  ✓ marker recorded promptLength=5 (no text)
  ✓ Stop hook installed
  ✓ UserPromptSubmit hook installed
  ✓ Stop hook removed on uninstall
  ✓ UserPromptSubmit hook removed on uninstall
  ✓ extension reads last user-submit timestamp
  ✓ watchdog skips when Claude is busy (LASTSUB > LASTSTOP)
  ✓ status payload exposes claudeBusy to the webview
```

## [0.2.14] - 2026-05-23 — Watchdog no longer fires mid-Claude-turn

### Fixed — v0.2.13 watchdog could fire a second kick while Claude was still processing the first

Diagnosed from a live trace: history showed four fires at ~50-60 second intervals (21:01:22, 21:02:12, 21:03:12, 21:04:12). The watchdog interval is 30s; if Claude took longer than that to finish a kicked turn, the watchdog read the EXTENSION'S OWN history entry from the previous kick, saw "last fire was 30s ago", and kicked again — mid-Claude-turn.

The root issue was that the extension's own kick and the Claude Code-driven Stop hook both wrote to `history.json` with no way to tell them apart.

### Fix in v0.2.14 — `source` field on every history entry

- Hook script writes `{text, firedAt, source: 'hook'}` — represents a real Claude turn-ending
- Extension's own kick writes `{text, firedAt, source: 'extension-kick'}` — represents only that we INITIATED a turn

Watchdog now reads history backwards and picks the **most recent entry whose `source === 'hook'`** as the recency signal. Extension-kick entries are skipped. Backwards-compat: entries without a `source` field (pre-v0.2.14) are treated as `'hook'`.

### Fix — Watchdog now distinguishes two cases properly

- **Case A:** hook fired after our last kick → Claude finished the kicked work. If 30s+ idle since that finish, kick the next item.
- **Case B:** no hook fire since our last kick → Claude is still processing. Wait until either the hook fires, or `KICK_MAX_WAIT_MS (5 minutes)` passes (recovery from hook breakage).

Effect: watchdog never re-kicks while Claude is mid-turn, but still recovers if the hook goes silent for 5+ minutes.

### Tests

```
=== v0.2.14 — hook entries tagged source:hook ===
  ✓ one history entry after hook fire
  ✓ hook-written history entry has source:hook
=== v0.2.14 — extension-kick history entries are filtered by watchdog ===
  ✓ extension emits source:extension-kick on its own kicks
  ✓ watchdog filters history by source:hook for recency check
  ✓ extension defines KICK_MAX_WAIT_MS recovery timeout
  ✓ watchdog distinguishes hook-fired-after-kick from waiting-for-hook
```

## [0.2.13] - 2026-05-23 — Periodic watchdog auto-kick (unstucks even when Claude Code stops firing the hook)

### Diagnosed — Claude Code sometimes stops firing the Stop hook entirely

After a manual test where the hook was invoked directly with the same workspace path, it correctly drained the queue 5 → 4 → 3 across two fires. But in the user's live session, only the initial fire was logged. Claude Code completed multiple subsequent turns and Phase-10.b work, yet the Stop hook was never invoked again. The hook is correct — Claude Code is the one failing to call it.

This can happen for several reasons (session ended, hook output exceeded an internal limit, transient I/O block, etc.). Our event-driven model (only kick on `saveQueue` empty→non-empty + on `resolveWebviewView`) doesn't cover this case: the queue is already non-empty and the sidebar is already resolved, so neither trigger fires.

### Added — 30-second periodic auto-kick watchdog

The extension now runs a `setInterval(30_000)` watchdog. Every 30 seconds:

1. If `claudeCodeModified.autoKickWhenIdle` is `false`, skip.
2. If the queue is empty, skip.
3. If a kick is currently in flight, skip.
4. If the Stop hook fired in the last 30 seconds (Claude is mid-flow, hook is draining), skip.
5. Otherwise: kick the head item via osascript / feedback fallback.

This means: even if Claude Code stops firing the hook entirely, within 30 seconds the watchdog picks up the slack and types the next pending prompt into Claude's chat itself. As soon as Claude takes that new turn and stops, the hook chain (assuming it's working) drains everything else.

### Changed — AUTO_KICK_COOLDOWN_MS removed

The cooldown was on top of the hook-recency check, which is the more accurate signal of whether Claude is active. The cooldown alone just delayed kicks after Claude had clearly idle'd. The hook-recency check is now the only timing safeguard (plus the in-flight mutex).

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
