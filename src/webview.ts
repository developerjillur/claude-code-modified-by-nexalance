/* eslint-disable @typescript-eslint/no-unused-vars */
// Webview HTML for Claude Mod by NexaLance.
//
// v0.2.0 — Queue manager only. NO chat UI. The actual conversation happens in
// Anthropic's official Claude Code extension. This panel:
//   - lets you type prompts that get appended to a queue file
//   - shows the queue with per-row Steer / Delete / More actions
//   - installs a Stop hook into ~/.claude/settings.json that drains the queue
//     each time Claude finishes a turn — so pending prompts are auto-fed into
//     the next turn of the current Claude Code session.

export function getWebviewHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Mod Queue</title>
<style>
	* { box-sizing: border-box; }
	html, body { height: 100%; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
	body {
		display: flex;
		flex-direction: column;
		background: var(--vscode-sideBar-background, #1c1c1e);
		color: var(--vscode-foreground, #ddd);
		font-size: 13px;
		overflow: hidden;
	}

	.app-header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
		background: rgba(255, 255, 255, 0.02);
		flex-shrink: 0;
	}
	.app-title { font-weight: 600; font-size: 13px; }
	.app-title small { opacity: 0.5; font-weight: 400; font-size: 11px; margin-left: 4px; }
	.id-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 3px 9px;
		border-radius: 10px;
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
		color: #fff;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.3px;
		box-shadow: 0 0 0 1px rgba(16,185,129,0.4);
	}
	.id-pill .dot {
		width: 5px; height: 5px; border-radius: 50%;
		background: #fff; box-shadow: 0 0 5px #fff;
	}
	.header-spacer { flex: 1; }

	.chat-area > .status-card:first-child { margin-top: 14px; }

	/* Permission-help inline panel — only visible when nativeStatus is bad */
	.perm-help {
		margin: 0 14px 10px 14px;
		padding: 10px 12px;
		border-radius: 10px;
		background: rgba(232,169,81,0.06);
		border: 1px solid rgba(232,169,81,0.25);
		color: var(--vscode-foreground, #ddd);
		font-size: 12px;
	}
	.perm-help-title {
		font-weight: 600;
		color: #fbbf24;
		margin-bottom: 6px;
	}
	.perm-help-body { line-height: 1.5; }
	.perm-help-body ol { margin: 6px 0 6px 18px; padding: 0; }
	.perm-help-body ol li { margin: 3px 0; }
	.perm-help-body code {
		background: rgba(255,255,255,0.06);
		padding: 1px 5px;
		border-radius: 4px;
		font-size: 11px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.perm-help-body .perm-cmd {
		display: block;
		margin-top: 6px;
		padding: 5px 8px;
		background: rgba(0,0,0,0.25);
		border-radius: 5px;
		font-size: 11px;
		user-select: all;
	}

	.status-card {
		margin: 0 14px 10px 14px;
		padding: 10px 12px;
		border-radius: 10px;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.06);
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: 12px;
	}
	.status-row { display: flex; align-items: center; gap: 8px; }
	.status-row .label { opacity: 0.6; min-width: 90px; }
	.status-row .value { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: 0.85; }
	.status-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 2px 8px;
		border-radius: 9px;
		font-size: 10.5px;
		font-weight: 600;
	}
	.status-pill.ok { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
	.status-pill.bad { background: rgba(239,68,68,0.10); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
	.setup-btn {
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
		color: #fff;
		border: none;
		padding: 7px 14px;
		border-radius: 7px;
		cursor: pointer;
		font-weight: 600;
		font-size: 12px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
	}
	.setup-btn:hover { background: linear-gradient(135deg, #34d399 0%, #10b981 100%); }
	.setup-btn.removing { background: rgba(255,255,255,0.08); color: #f87171; }
	.probe-btn {
		background: transparent;
		color: var(--vscode-descriptionForeground, #999);
		border: 1px solid rgba(255,255,255,0.1);
		padding: 6px 11px;
		border-radius: 7px;
		cursor: pointer;
		font-size: 11.5px;
	}
	.probe-btn:hover { background: rgba(255,255,255,0.06); color: var(--vscode-foreground, #ddd); }
	.status-pill.warn { background: rgba(232,169,81,0.10); color: #fbbf24; border: 1px solid rgba(232,169,81,0.30); }

	.chat-area {
		flex: 1;
		overflow-y: auto;
		padding: 0 0 4px 0;
		display: flex;
		flex-direction: column;
	}
	.chat-area::-webkit-scrollbar { width: 8px; }
	.chat-area::-webkit-scrollbar-thumb {
		background: rgba(255, 255, 255, 0.1); border-radius: 4px;
	}

	.note {
		margin: 8px 16px;
		padding: 8px 12px;
		font-size: 12px;
		color: var(--vscode-descriptionForeground, #888);
		background: rgba(255,255,255,0.02);
		border-radius: 6px;
		border-left: 2px solid rgba(255,255,255,0.1);
		white-space: pre-wrap;
	}

	/* ===== Codex-style Prompt Queue Panel ===== */
	.queue-panel {
		margin: 0 12px 6px 12px;
		padding: 4px;
		border-radius: 12px;
		background: rgba(28, 28, 30, 0.92);
		border: 1px solid rgba(255, 255, 255, 0.08);
		max-height: 320px;
		display: flex;
		flex-direction: column;
		gap: 0;
		box-shadow: 0 2px 14px rgba(0, 0, 0, 0.22);
		font-size: 13px;
		flex-shrink: 0;
	}
	.queue-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		min-height: 22px;
	}
	.queue-status {
		font-size: 11px;
		color: var(--vscode-descriptionForeground, #888);
		font-weight: 500;
		padding: 0 6px;
	}
	.queue-empty {
		padding: 18px 12px;
		text-align: center;
		font-size: 12px;
		color: var(--vscode-descriptionForeground, #777);
		font-style: italic;
	}
	.queue-clear {
		background: transparent;
		border: none;
		color: var(--vscode-descriptionForeground, #888);
		border-radius: 5px;
		padding: 3px 8px;
		font-size: 10.5px;
		cursor: pointer;
		opacity: 0.6;
	}
	.queue-clear:hover { opacity: 1; background: rgba(255,255,255,0.06); }
	.queue-fire {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background: linear-gradient(135deg, #10b981 0%, #059669 100%);
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 3px 9px;
		font-size: 10.5px;
		font-weight: 600;
		cursor: pointer;
	}
	.queue-fire:hover { background: linear-gradient(135deg, #34d399 0%, #10b981 100%); }
	.queue-fire:disabled {
		background: rgba(255,255,255,0.08);
		color: rgba(255,255,255,0.4);
		cursor: not-allowed;
	}
	.queue-fire.in-flight {
		background: rgba(16,185,129,0.30);
		color: rgba(255,255,255,0.85);
		cursor: progress;
	}
	.queue-fire .spinner {
		display: inline-block;
		width: 10px;
		height: 10px;
		border: 1.5px solid rgba(255,255,255,0.4);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spinClaudeMod 0.8s linear infinite;
	}
	@keyframes spinClaudeMod { to { transform: rotate(360deg); } }
	.queue-list {
		display: flex; flex-direction: column;
		overflow-y: auto; max-height: 260px;
	}
	.queue-list::-webkit-scrollbar { width: 6px; }
	.queue-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }

	.queue-row {
		display: grid;
		grid-template-columns: 18px 1fr auto auto auto;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: 8px;
		transition: background 0.12s;
	}
	.queue-row + .queue-row {
		border-top: 1px solid rgba(255, 255, 255, 0.05);
		border-radius: 0;
	}
	.queue-row:hover { background: rgba(255, 255, 255, 0.04); }
	.queue-row.next-up { background: rgba(255, 255, 255, 0.025); }
	.queue-icon {
		opacity: 0.45;
		display: flex; align-items: center; justify-content: center;
		color: var(--vscode-descriptionForeground, #888);
	}
	.queue-text {
		font-size: 13px;
		color: var(--vscode-foreground, #ddd);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0.92;
	}
	.row-btn {
		background: transparent;
		border: none;
		color: var(--vscode-foreground, #ccc);
		padding: 5px;
		border-radius: 6px;
		cursor: pointer;
		opacity: 0.55;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px;
	}
	.row-btn.steer { padding: 4px 9px 4px 7px; gap: 4px; opacity: 0.7; }
	.row-btn.steer span { font-size: 12px; }
	.row-btn:hover { opacity: 1; background: rgba(255,255,255,0.07); }
	.row-btn.delete:hover { color: #f87171; }

	/* History panel (consumed prompts) */
	.history-panel {
		margin: 4px 12px 6px 12px;
		padding: 6px 8px;
		border-radius: 10px;
		background: rgba(16, 185, 129, 0.04);
		border: 1px solid rgba(16, 185, 129, 0.15);
		font-size: 12px;
		flex-shrink: 0;
	}
	.history-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 2px 4px 2px;
	}
	.history-title {
		flex: 1;
		font-size: 11px;
		color: #34d399;
		font-weight: 600;
		letter-spacing: 0.2px;
	}
	.history-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 120px;
		overflow-y: auto;
	}
	.history-list::-webkit-scrollbar { width: 6px; }
	.history-list::-webkit-scrollbar-thumb { background: rgba(16,185,129,0.20); border-radius: 3px; }
	.history-row {
		display: flex;
		gap: 8px;
		padding: 4px 6px;
		border-radius: 5px;
		font-size: 12px;
		color: var(--vscode-descriptionForeground, #999);
	}
	.history-row:hover { background: rgba(255,255,255,0.04); }
	.history-row .ts {
		font-variant-numeric: tabular-nums;
		opacity: 0.55;
		flex-shrink: 0;
		min-width: 56px;
	}
	.history-row .text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--vscode-foreground, #ddd);
		opacity: 0.85;
	}

	.queue-more-menu {
		position: absolute;
		z-index: 5000;
		min-width: 150px;
		padding: 4px;
		background: rgba(35, 35, 38, 0.98);
		border: 1px solid rgba(255, 255, 255, 0.10);
		border-radius: 8px;
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 12px;
	}
	.queue-more-menu button {
		background: transparent; border: none;
		color: var(--vscode-foreground, #ddd);
		padding: 7px 10px;
		border-radius: 5px;
		cursor: pointer;
		text-align: left;
		display: flex; align-items: center; gap: 8px;
	}
	.queue-more-menu button:hover { background: rgba(255,255,255,0.07); }
	.queue-more-menu button.danger { color: #f87171; }

	/* ===== Input area (just to ADD to queue — no chat) ===== */
	.input-area {
		display: flex; flex-direction: column;
		gap: 6px;
		padding: 8px 12px 12px 12px;
		flex-shrink: 0;
		border-top: 1px solid rgba(255, 255, 255, 0.04);
		background: var(--vscode-sideBar-background, #1c1c1e);
	}
	.input-box {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 10px 12px;
		background: rgba(255, 255, 255, 0.04);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 12px;
	}
	.input-box:focus-within { border-color: rgba(120, 160, 220, 0.4); }
	#promptInput {
		flex: 1;
		background: transparent;
		border: none;
		outline: none;
		color: var(--vscode-foreground, #ddd);
		font-family: inherit;
		font-size: 13px;
		resize: none;
		max-height: 160px;
		min-height: 22px;
		line-height: 1.5;
		padding: 0;
	}
	#promptInput::placeholder { color: rgba(255, 255, 255, 0.35); }
	.add-btn {
		width: 30px; height: 30px;
		border-radius: 50%;
		background: var(--vscode-foreground, #eee);
		color: var(--vscode-sideBar-background, #1c1c1e);
		border: none;
		cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.add-btn:hover { opacity: 0.85; }
	.attach-btn {
		width: 30px; height: 30px;
		border-radius: 8px;
		background: transparent;
		color: var(--vscode-descriptionForeground, #999);
		border: 1px solid rgba(255,255,255,0.08);
		cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
		transition: opacity 0.15s, background 0.15s, border-color 0.15s, color 0.15s;
	}
	.attach-btn:hover {
		color: var(--vscode-foreground, #ddd);
		background: rgba(255,255,255,0.06);
		border-color: rgba(255,255,255,0.15);
	}
	.attachments-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		padding: 6px 12px 0 12px;
	}
	.attachments-bar:empty { display: none; }
	.attach-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 4px 6px 4px 8px;
		background: rgba(16,185,129,0.10);
		border: 1px solid rgba(16,185,129,0.30);
		border-radius: 14px;
		font-size: 11.5px;
		color: var(--vscode-foreground, #ddd);
		max-width: 220px;
	}
	.attach-chip .chip-icon {
		opacity: 0.75;
		flex-shrink: 0;
		display: flex; align-items: center;
	}
	.attach-chip .chip-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 160px;
	}
	.attach-chip .chip-remove {
		background: transparent;
		border: none;
		color: var(--vscode-descriptionForeground, #999);
		cursor: pointer;
		padding: 0 2px;
		border-radius: 4px;
		display: inline-flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.attach-chip .chip-remove:hover {
		color: #f87171;
		background: rgba(255,255,255,0.08);
	}
	.bottom-bar {
		display: flex; align-items: center; gap: 8px;
		padding: 0 4px;
		font-size: 11px;
		color: var(--vscode-descriptionForeground, #999);
	}
</style>
</head>
<body>
	<div class="app-header">
		<span class="app-title">Claude Mod <small>by NexaLance</small></span>
		<span class="id-pill" title="This is the Claude Mod queue manager. The actual Claude Code chat happens in Anthropic's official extension. This panel only manages the pending queue and feeds prompts via the Stop hook.">
			<span class="dot"></span>v0.2.13 · Watchdog
		</span>
	</div>

	<div class="chat-area" id="chatArea">
		<div class="status-card" id="statusCard">
			<div class="status-row">
				<span class="label">Stop hook</span>
				<span class="status-pill bad" id="hookPill">checking…</span>
			</div>
			<div class="status-row">
				<span class="label">Native submit</span>
				<span class="status-pill bad" id="nativePill" title="Whether osascript can drive Anthropic's chat — requires macOS Accessibility / Automation permission for VS Code">unknown</span>
			</div>
			<div class="status-row">
				<span class="label">Queue file</span>
				<span class="value" id="queueFileLabel">—</span>
			</div>
			<div class="status-row" style="gap: 6px;">
				<button class="setup-btn" id="setupBtn" onclick="onSetupClick()">
					<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
					<span id="setupBtnLabel">Install hook</span>
				</button>
				<button class="probe-btn" onclick="probeAccessibility()" title="Run a tiny osascript probe to check (or trigger) the Accessibility permission for VS Code">
					Probe native
				</button>
				<button class="probe-btn" onclick="openAccessibilityPrefs()" title="Open System Settings → Privacy & Security → Automation so you can grant VS Code permission to control System Events">
					Open prefs
				</button>
			</div>
		</div>

		<!-- Permission help — shown only when native submit is failing. -->
		<div class="perm-help" id="permHelp" style="display:none">
			<div class="perm-help-title">⚠ Native submit blocked by macOS</div>
			<div class="perm-help-body">
				Each fed prompt currently shows under <code>Stop hook feedback:</code> because VS Code can't drive Claude's chat input. To get native user-message look:
				<ol>
					<li>Click <b>Open prefs</b> above — System Settings opens to <b>Privacy & Security → Automation</b>.</li>
					<li>Find <b>Visual Studio Code</b> in the list. If it's not there yet, click <b>Probe native</b> first — that triggers macOS to add it.</li>
					<li>Expand the Visual Studio Code row and turn on <b>System Events</b>.</li>
					<li>Come back and click <b>Probe native</b> — the pill above should flip to <code>✓ working</code>.</li>
				</ol>
				If the pill still says <code>permission missing</code> after enabling, reset and retry:
				<code class="perm-cmd">tccutil reset AppleEvents com.microsoft.VSCode</code>
			</div>
		</div>

		<div class="queue-panel" id="queuePanel">
			<div class="queue-header">
				<span class="queue-status" id="queueStatus">0 pending</span>
				<span class="header-spacer" style="flex:1"></span>
				<button class="queue-fire" id="queueFireBtn" onclick="fireNow()" title="Push the head pending prompt into Claude's chat now (requires macOS Accessibility permission for VS Code on first run)">
					<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
					<span>Fire now</span>
				</button>
				<button class="queue-clear" onclick="clearQueue()" title="Remove all pending prompts">Clear all</button>
			</div>
			<div class="queue-empty" id="queueEmpty">No pending prompts yet. Type below and press Enter to add one.</div>
			<div class="queue-list" id="queueList"></div>
		</div>

		<!-- History feed: shows prompts that have been consumed by the Stop hook.
		     This is the only visible feedback that the hook is actually firing. -->
		<div class="history-panel" id="historyPanel" style="display:none">
			<div class="history-header">
				<span class="history-title">Last fired by hook</span>
				<button class="queue-clear" onclick="clearHistory()" title="Clear the fired-prompt history">Clear</button>
			</div>
			<div class="history-list" id="historyList"></div>
		</div>
	</div>

	<div class="input-area">
		<div class="attachments-bar" id="attachmentsBar"></div>
		<div class="input-box">
			<button class="attach-btn" onclick="pickFiles()" title="Attach file (also: paste an image directly into the prompt)">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
				</svg>
			</button>
			<textarea id="promptInput" rows="1" placeholder="Add prompt · Enter to queue · Shift+Enter for newline · paste images directly"></textarea>
			<button class="add-btn" onclick="addPrompt()" title="Add to queue (Enter)">
				<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
					<line x1="12" y1="5" x2="12" y2="19"></line>
					<line x1="5" y1="12" x2="19" y2="12"></line>
				</svg>
			</button>
		</div>
		<div class="bottom-bar">
			<span>Queue is synced to <code id="queuePathInline" style="opacity:0.8">~/.claude/claude-mod-queue.json</code></span>
		</div>
	</div>

<script>
	const vscode = acquireVsCodeApi();
	const promptInput = document.getElementById('promptInput');
	const queuePanel = document.getElementById('queuePanel');
	const queueList = document.getElementById('queueList');
	const queueStatus = document.getElementById('queueStatus');
	const queueEmpty = document.getElementById('queueEmpty');
	const hookPill = document.getElementById('hookPill');
	const queueFileLabel = document.getElementById('queueFileLabel');
	const queuePathInline = document.getElementById('queuePathInline');
	const setupBtn = document.getElementById('setupBtn');
	const setupBtnLabel = document.getElementById('setupBtnLabel');
	const chatArea = document.getElementById('chatArea');

	let queue = [];
	let history = [];
	let hookInstalled = false;
	let pendingAttachments = [];
	const MAX_QUEUE = 50;
	const MAX_ATTACHMENTS = 10;

	function escapeHtml(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}
	function genId() { return 'q_' + Date.now() + '_' + Math.floor(Math.random() * 100000); }

	function addPrompt() {
		const text = promptInput.value.trim();
		if (!text && pendingAttachments.length === 0) { return; }
		if (queue.length >= MAX_QUEUE) {
			showNote('Queue is full (' + MAX_QUEUE + ' max). Delete some pending prompts first.');
			return;
		}
		// Compose the queued text. Attachments are appended as an explicit
		// "Attached files:" block so Claude can see them when the hook fires
		// and decide to Read them. The hook itself just emits this text.
		// NB: this code lives inside a TS template literal, so any \\n we
		// write here becomes a literal newline in the compiled JS string
		// (which would be a syntax error in the inline <script>). We use the
		// double-escaped form so the runtime string contains "\\n" → which
		// the browser-side JS then evaluates to actual newlines.
		let fullText = text;
		if (pendingAttachments.length > 0) {
			fullText = (text ? text + '\\n\\n' : '') +
				'Attached files (please Read each one before answering):\\n' +
				pendingAttachments.map(p => '- ' + p).join('\\n');
		}
		queue.push({
			id: genId(),
			text: fullText,
			attachments: pendingAttachments.slice(),
			createdAt: Date.now()
		});
		promptInput.value = '';
		pendingAttachments = [];
		renderAttachments();
		adjustHeight();
		renderQueue();
		persist();
	}

	function pickFiles() {
		vscode.postMessage({ type: 'pickFiles' });
	}

	function attachPath(p) {
		if (!p) { return; }
		if (pendingAttachments.length >= MAX_ATTACHMENTS) {
			showNote('Attachment limit reached (' + MAX_ATTACHMENTS + ' per prompt).');
			return;
		}
		if (pendingAttachments.indexOf(p) === -1) {
			pendingAttachments.push(p);
			renderAttachments();
		}
	}

	function removeAttachment(p) {
		pendingAttachments = pendingAttachments.filter(x => x !== p);
		renderAttachments();
	}

	function basename(p) {
		const i = p.lastIndexOf('/');
		return i >= 0 ? p.slice(i + 1) : p;
	}

	function renderAttachments() {
		const bar = document.getElementById('attachmentsBar');
		if (!bar) { return; }
		if (pendingAttachments.length === 0) {
			bar.innerHTML = '';
			return;
		}
		bar.innerHTML = pendingAttachments.map((p) => {
			const name = escapeHtml(basename(p));
			const full = escapeHtml(p);
			const isImage = /\\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p);
			const iconSvg = isImage
				? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>'
				: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
			return (
				'<span class="attach-chip" title="' + full + '">' +
					'<span class="chip-icon">' + iconSvg + '</span>' +
					'<span class="chip-name">' + name + '</span>' +
					'<button class="chip-remove" onclick="removeAttachment(\\'' + escapeJsStr(p) + '\\')" title="Remove attachment">' +
						'<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
					'</button>' +
				'</span>'
			);
		}).join('');
	}

	function escapeJsStr(s) {
		return String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
	}

	function deleteItem(id) {
		const idx = queue.findIndex(q => q.id === id);
		if (idx < 0) { return; }
		queue.splice(idx, 1);
		renderQueue();
		persist();
	}

	function steerItem(id) {
		const idx = queue.findIndex(q => q.id === id);
		if (idx <= 0) { return; }
		const item = queue.splice(idx, 1)[0];
		queue.unshift(item);
		renderQueue();
		persist();
	}

	function moveUp(id) {
		const idx = queue.findIndex(q => q.id === id);
		if (idx <= 0) { return; }
		const tmp = queue[idx - 1];
		queue[idx - 1] = queue[idx];
		queue[idx] = tmp;
		renderQueue();
		persist();
	}

	function moveDown(id) {
		const idx = queue.findIndex(q => q.id === id);
		if (idx < 0 || idx >= queue.length - 1) { return; }
		const tmp = queue[idx + 1];
		queue[idx + 1] = queue[idx];
		queue[idx] = tmp;
		renderQueue();
		persist();
	}

	function editItem(id) {
		const idx = queue.findIndex(q => q.id === id);
		if (idx < 0) { return; }
		const item = queue[idx];
		const current = promptInput.value.trim();
		if (current) { queue.push({ id: genId(), text: current, createdAt: Date.now() }); }
		promptInput.value = item.text;
		promptInput.focus();
		adjustHeight();
		queue.splice(idx, 1);
		renderQueue();
		persist();
	}

	function clearQueue() {
		if (queue.length === 0) { return; }
		queue = [];
		renderQueue();
		persist();
	}

	function fireNow() {
		vscode.postMessage({ type: 'fireNow' });
	}

	function clearHistory() {
		history = [];
		renderHistory();
		vscode.postMessage({ type: 'clearHistory' });
	}

	function formatTime(ms) {
		const d = new Date(ms);
		const hh = String(d.getHours()).padStart(2, '0');
		const mm = String(d.getMinutes()).padStart(2, '0');
		const ss = String(d.getSeconds()).padStart(2, '0');
		return hh + ':' + mm + ':' + ss;
	}

	function renderHistory() {
		const panel = document.getElementById('historyPanel');
		const list = document.getElementById('historyList');
		if (!panel || !list) { return; }
		if (!Array.isArray(history) || history.length === 0) {
			panel.style.display = 'none';
			list.innerHTML = '';
			return;
		}
		panel.style.display = 'block';
		// Latest first, cap at 8 visible rows.
		const recent = history.slice(-8).reverse();
		list.innerHTML = recent.map((e) => {
			const text = String(e.text || '');
			const preview = text.length > 120 ? text.slice(0, 120) + '…' : text;
			return (
				'<div class="history-row" title="' + escapeHtml(text) + '">' +
					'<span class="ts">' + formatTime(e.firedAt || Date.now()) + '</span>' +
					'<span class="text">' + escapeHtml(preview) + '</span>' +
				'</div>'
			);
		}).join('');
	}

	function persist() {
		vscode.postMessage({ type: 'saveQueue', data: queue });
	}

	function renderQueue() {
		queueStatus.textContent = queue.length + ' pending';
		const fireBtn = document.getElementById('queueFireBtn');
		if (queue.length === 0) {
			queueEmpty.style.display = 'block';
			queueList.innerHTML = '';
			if (fireBtn) { fireBtn.disabled = true; fireBtn.style.display = 'none'; }
			return;
		}
		queueEmpty.style.display = 'none';
		if (fireBtn) { fireBtn.disabled = false; fireBtn.style.display = 'inline-flex'; }
		const rows = queue.map((item, index) => {
			const preview = item.text.length > 160 ? item.text.slice(0, 160) + '…' : item.text;
			const isHead = index === 0;
			const cls = 'queue-row' + (isHead ? ' next-up' : '');
			// Head item already fires next; the Steer button on it would be a
			// no-op, so we omit it. The grid still has 5 columns — fill the
			// gap with a transparent placeholder so column alignment is kept.
			const steerCell = isHead
				? '<span></span>'
				: (
					'<button class="row-btn steer" onclick="steerItem(\\'' + item.id + '\\')" title="Move to head — fires next">' +
						'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
							'<polyline points="15 10 20 15 15 20"></polyline>' +
							'<path d="M4 4v7a4 4 0 0 0 4 4h12"></path>' +
						'</svg>' +
						'<span>Steer</span>' +
					'</button>'
				);
			return (
				'<div class="' + cls + '" data-id="' + item.id + '" title="' + escapeHtml(item.text) + '">' +
					'<span class="queue-icon">' +
						'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
							'<polyline points="9 14 4 9 9 4"></polyline>' +
							'<path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>' +
						'</svg>' +
					'</span>' +
					'<span class="queue-text">' + escapeHtml(preview) + '</span>' +
					steerCell +
					'<button class="row-btn delete" onclick="deleteItem(\\'' + item.id + '\\')" title="Remove from queue">' +
						'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
							'<polyline points="3 6 5 6 21 6"></polyline>' +
							'<path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path>' +
						'</svg>' +
					'</button>' +
					'<button class="row-btn more" onclick="openMoreMenu(event, \\'' + item.id + '\\')" title="More actions">' +
						'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
							'<circle cx="5" cy="12" r="1.6"></circle>' +
							'<circle cx="12" cy="12" r="1.6"></circle>' +
							'<circle cx="19" cy="12" r="1.6"></circle>' +
						'</svg>' +
					'</button>' +
				'</div>'
			);
		}).join('');
		queueList.innerHTML = rows;
	}

	function openMoreMenu(evt, id) {
		try { evt.stopPropagation(); } catch (e) {}
		closeMoreMenu();
		const idx = queue.findIndex(q => q.id === id);
		if (idx < 0) { return; }

		const menu = document.createElement('div');
		menu.className = 'queue-more-menu';

		const editBtn = document.createElement('button');
		editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg><span>Edit prompt</span>';
		editBtn.onclick = (e) => { e.stopPropagation(); closeMoreMenu(); editItem(id); };
		menu.appendChild(editBtn);

		// Move-up is meaningful only when the item is NOT already at the head.
		if (idx > 0) {
			const upBtn = document.createElement('button');
			upBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg><span>Move up</span>';
			upBtn.onclick = (e) => { e.stopPropagation(); closeMoreMenu(); moveUp(id); };
			menu.appendChild(upBtn);
		}

		// Move-down is meaningful only when the item is NOT at the tail.
		if (idx >= 0 && idx < queue.length - 1) {
			const downBtn = document.createElement('button');
			downBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg><span>Move down</span>';
			downBtn.onclick = (e) => { e.stopPropagation(); closeMoreMenu(); moveDown(id); };
			menu.appendChild(downBtn);
		}

		const delBtn = document.createElement('button');
		delBtn.className = 'danger';
		delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path></svg><span>Cancel prompt</span>';
		delBtn.onclick = (e) => { e.stopPropagation(); closeMoreMenu(); deleteItem(id); };
		menu.appendChild(delBtn);

		const trigger = evt && evt.currentTarget;
		document.body.appendChild(menu);
		const rect = trigger && trigger.getBoundingClientRect ? trigger.getBoundingClientRect() : null;
		if (rect) {
			const mr = menu.getBoundingClientRect();
			let top = rect.bottom + 4;
			let left = rect.right - mr.width;
			if (top + mr.height > window.innerHeight - 8) { top = rect.top - mr.height - 4; }
			if (left < 8) { left = 8; }
			menu.style.top = top + 'px';
			menu.style.left = left + 'px';
		}
		setTimeout(() => {
			document.addEventListener('mousedown', closeMenuOnOutside, true);
			document.addEventListener('keydown', closeMenuOnEscape, true);
		}, 0);
	}
	function closeMoreMenu() {
		const m = document.querySelector('.queue-more-menu');
		if (m && m.parentNode) { m.parentNode.removeChild(m); }
		document.removeEventListener('mousedown', closeMenuOnOutside, true);
		document.removeEventListener('keydown', closeMenuOnEscape, true);
	}
	function closeMenuOnOutside(e) {
		const m = document.querySelector('.queue-more-menu');
		if (m && !m.contains(e.target)) { closeMoreMenu(); }
	}
	function closeMenuOnEscape(e) { if (e.key === 'Escape') { closeMoreMenu(); } }

	function showNote(text) {
		const el = document.createElement('div');
		el.className = 'note';
		el.textContent = text;
		chatArea.appendChild(el);
		chatArea.scrollTop = chatArea.scrollHeight;
	}

	function onSetupClick() {
		if (hookInstalled) {
			vscode.postMessage({ type: 'uninstallHook' });
		} else {
			vscode.postMessage({ type: 'installHook' });
		}
	}

	function probeAccessibility() {
		vscode.postMessage({ type: 'probeAccessibility' });
	}

	function openAccessibilityPrefs() {
		vscode.postMessage({ type: 'openAccessibilityPrefs' });
	}

	function updateStatus(s) {
		hookInstalled = !!s.hookInstalled;
		if (hookInstalled) {
			hookPill.className = 'status-pill ok';
			hookPill.textContent = '✓ installed';
			setupBtn.classList.add('removing');
			setupBtnLabel.textContent = 'Uninstall hook';
		} else {
			hookPill.className = 'status-pill bad';
			hookPill.textContent = '✗ not installed';
			setupBtn.classList.remove('removing');
			setupBtnLabel.textContent = 'Install hook';
		}
		if (s.queueFile) {
			queueFileLabel.textContent = shortPath(s.queueFile);
			queuePathInline.textContent = shortPath(s.queueFile);
		}
		// Native submit pill — tri-state: ok / failing / unknown
		const nativePill = document.getElementById('nativePill');
		const permHelp = document.getElementById('permHelp');
		if (nativePill) {
			const ns = s.nativeStatus;
			let needsHelp = false;
			if (!ns) {
				nativePill.className = 'status-pill warn';
				nativePill.textContent = 'unknown — click Probe';
			} else if (ns.ok) {
				nativePill.className = 'status-pill ok';
				nativePill.textContent = '✓ working';
			} else {
				nativePill.className = 'status-pill bad';
				nativePill.textContent = ns.timedOut ? '✗ permission missing' : '✗ failing';
				needsHelp = true;
			}
			if (permHelp) {
				permHelp.style.display = needsHelp ? 'block' : 'none';
			}
		}
	}

	function shortPath(p) {
		if (!p) { return ''; }
		const home = '/Users/' + (p.split('/Users/')[1] || '').split('/')[0];
		return p.replace(home, '~');
	}

	function adjustHeight() {
		promptInput.style.height = 'auto';
		promptInput.style.height = Math.min(promptInput.scrollHeight, 160) + 'px';
	}

	promptInput.addEventListener('input', adjustHeight);
	promptInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			addPrompt();
		}
	});

	// Image paste: intercept clipboard items, save the image via the extension
	// host (which writes it to ~/.claude/claude-mod-attachments/), then attach
	// the resulting file path to the current prompt as a chip.
	promptInput.addEventListener('paste', (e) => {
		const items = (e.clipboardData && e.clipboardData.items) ? e.clipboardData.items : [];
		let handledImage = false;
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === 'file' && item.type && item.type.indexOf('image/') === 0) {
				handledImage = true;
				const blob = item.getAsFile();
				if (!blob) { continue; }
				const reader = new FileReader();
				reader.onload = function () {
					const dataUrl = String(reader.result || '');
					const commaIdx = dataUrl.indexOf(',');
					if (commaIdx < 0) { return; }
					const base64 = dataUrl.slice(commaIdx + 1);
					vscode.postMessage({
						type: 'saveImage',
						data: base64,
						mimeType: item.type
					});
				};
				reader.readAsDataURL(blob);
			}
		}
		if (handledImage) { e.preventDefault(); }
	});

	// expose for inline onclick
	window.addPrompt = addPrompt;
	window.deleteItem = deleteItem;
	window.steerItem = steerItem;
	window.moveUp = moveUp;
	window.moveDown = moveDown;
	window.editItem = editItem;
	window.clearQueue = clearQueue;
	window.clearHistory = clearHistory;
	window.openMoreMenu = openMoreMenu;
	window.onSetupClick = onSetupClick;
	window.pickFiles = pickFiles;
	window.removeAttachment = removeAttachment;
	window.fireNow = fireNow;
	window.probeAccessibility = probeAccessibility;
	window.openAccessibilityPrefs = openAccessibilityPrefs;

	window.addEventListener('message', (e) => {
		const msg = e.data;
		if (!msg) { return; }
		switch (msg.type) {
			case 'restoreQueue':
				if (Array.isArray(msg.data)) {
					queue = msg.data;
					renderQueue();
				}
				break;
			case 'history':
				if (Array.isArray(msg.data)) {
					history = msg.data;
					renderHistory();
				}
				break;
			case 'status':
				updateStatus(msg.data || {});
				break;
			case 'note':
				showNote(msg.data);
				break;
			case 'fileAttached':
				if (msg.data && msg.data.path) { attachPath(msg.data.path); }
				break;
			case 'kickInFlight': {
				const fireBtn = document.getElementById('queueFireBtn');
				if (fireBtn) {
					if (msg.data && msg.data.active) {
						fireBtn.classList.add('in-flight');
						fireBtn.innerHTML = '<span class="spinner"></span><span>Firing…</span>';
					} else {
						fireBtn.classList.remove('in-flight');
						fireBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Fire now</span>';
					}
				}
				break;
			}
		}
	});

	// ask for initial status
	vscode.postMessage({ type: 'requestStatus' });
	adjustHeight();
</script>
</body>
</html>`;
}
