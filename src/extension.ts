import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import { getWebviewHtml } from './webview';
import {
	getPathsForWorkspace,
	getPathsForFallback,
	installHook,
	uninstallHook,
	isHookInstalled,
	loadQueueFromFile,
	saveQueueToFile,
	loadHistoryFromFile,
	loadNativeStatus,
	loadUserSubmitMarker,
	refreshStableHookScript,
	refreshStableUserSubmitHookScript,
	saveBase64Image,
	getAttachmentsDir,
	migrateLegacyGlobalQueue,
	WorkspacePaths
} from './hook-setup';
import { kickClaudeCodeChat } from './auto-kick';

function currentWorkspacePath(): string {
	const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	return ws || '__no-workspace__';
}

/**
 * Rewrite the Stop hook command in ~/.claude/settings.json so it includes
 * CLAUDE_MOD_ENABLE_NATIVE=1 (or removes it) based on the current setting.
 * This is the cleanest way to pass the toggle through to the hook subprocess
 * which Claude Code spawns and which has no other way to read VS Code config.
 */
function rewriteHookCommandForNativeSetting(extensionPath: string): void {
	const cfg = vscode.workspace.getConfiguration('claudeCodeModified');
	// v0.2.20 — native default = true. Only inject CLAUDE_MOD_DISABLE_NATIVE=1
	// when the user explicitly turned the setting OFF. Default and "on" both
	// produce a plain command line (the hook tries native by default).
	const enableNative = cfg.get<boolean>('enableNativeSubmit', true);
	const settingsFile = require('os').homedir() + '/.claude/settings.json';
	if (!fs.existsSync(settingsFile)) { return; }
	let settings: any;
	try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
	catch { return; }
	if (!settings.hooks || !Array.isArray(settings.hooks.Stop)) { return; }
	const stableHook = require('os').homedir() + '/.claude/claude-mod-hook.js';
	const wantedCommand = enableNative
		? `/usr/bin/env node "${stableHook}" # claude-mod-stop-hook`
		: `CLAUDE_MOD_DISABLE_NATIVE=1 /usr/bin/env node "${stableHook}" # claude-mod-stop-hook`;
	let changed = false;
	for (const entry of settings.hooks.Stop) {
		if (!entry?.hooks || !Array.isArray(entry.hooks)) { continue; }
		for (const h of entry.hooks) {
			if (typeof h.command === 'string' && h.command.includes('claude-mod-stop-hook')) {
				if (h.command !== wantedCommand) {
					h.command = wantedCommand;
					changed = true;
				}
			}
		}
	}
	if (changed) {
		fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
	}
}

function currentPaths(): WorkspacePaths {
	const ws = currentWorkspacePath();
	return ws === '__no-workspace__' ? getPathsForFallback() : getPathsForWorkspace(ws);
}

export function activate(context: vscode.ExtensionContext) {
	try {
		refreshStableHookScript(context.extensionPath);
		refreshStableUserSubmitHookScript(context.extensionPath);
	} catch (err: any) {
		console.warn('[claude-mod] could not refresh hook scripts:', err.message);
	}

	// Per-workspace migration: v0.2.7 stored a single global queue at
	// ~/.claude/claude-mod-queue.json. Move its contents (if any) into the
	// current workspace's queue on first activation of v0.2.8.
	try {
		const migration = migrateLegacyGlobalQueue(currentWorkspacePath());
		if (migration.itemsMigrated > 0 || migration.historyMigrated > 0) {
			vscode.window.showInformationMessage(
				`Claude Mod: migrated ${migration.itemsMigrated} pending item(s) and ${migration.historyMigrated} history entr(ies) from the old global queue into this workspace.`
			);
		}
	} catch (err: any) {
		console.warn('[claude-mod] legacy queue migration failed:', err.message);
	}

	// Auto-migrate the Stop-hook command in settings.json: if it points at a
	// versioned extension folder (from older releases) instead of the stable
	// path, re-install so the reference survives future updates.
	try {
		const paths = currentPaths();
		if (isHookInstalled()) {
			const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
			const ourEntry = (settings.hooks?.Stop || []).find((h: any) =>
				JSON.stringify(h).includes('claude-mod-stop-hook')
			);
			const cmd: string = ourEntry?.hooks?.[0]?.command || '';
			if (!cmd.includes(paths.hookScript)) {
				installHook(context.extensionPath);
			}
		}
	} catch (err: any) {
		console.warn('[claude-mod] hook migration check failed:', err.message);
	}

	const provider = new QueueProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('claude-code-modified.queue', provider, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claude-code-modified.open', () =>
			vscode.commands.executeCommand('workbench.view.extension.claude-code-modified')
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claude-code-modified.installHook', async () => {
			try {
				const r = installHook(context.extensionPath);
				vscode.window.showInformationMessage('Claude Mod stop hook installed → ' + r.settingsFile);
				provider.refreshStatus();
			} catch (err: any) {
				vscode.window.showErrorMessage('Hook install failed: ' + err.message);
			}
		})
	);

	// Whenever the user toggles enableNativeSubmit, re-install the hook
	// command so the new env var takes effect for future Claude Code Stop
	// events. The hook reads CLAUDE_MOD_ENABLE_NATIVE at startup.
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('claudeCodeModified.enableNativeSubmit')) {
			try {
				rewriteHookCommandForNativeSetting(context.extensionPath);
			} catch (err: any) {
				console.warn('[claude-mod] could not rewrite hook command:', err.message);
			}
		}
	}));
	// Make sure the hook command already reflects the current setting on
	// activation (in case the setting changed while the extension was off).
	try { rewriteHookCommandForNativeSetting(context.extensionPath); } catch (_) { /* noop */ }

	context.subscriptions.push(
		vscode.commands.registerCommand('claude-code-modified.uninstallHook', async () => {
			const r = uninstallHook();
			vscode.window.showInformationMessage(
				r.uninstalled ? 'Claude Mod stop hook removed.' : 'No Claude Mod hook was installed.'
			);
			provider.refreshStatus();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claude-code-modified.fireNow', async () => {
			await provider.firePendingNow();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claude-code-modified.probeAccessibility', async () => {
			await provider.probeAccessibility();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claude-code-modified.openAccessibilityPrefs', async () => {
			await vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
		})
	);

	// When the user switches workspace folders inside VS Code, our paths
	// change — reload from the new workspace's files.
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
		provider.handleWorkspaceChange();
	}));

	const cfg = vscode.workspace.getConfiguration('claudeCodeModified');
	if (cfg.get<boolean>('autoOpenOnStartup', true)) {
		setTimeout(() => {
			vscode.commands.executeCommand('workbench.view.extension.claude-code-modified')
				.then(undefined, () => { /* noop */ });
		}, 600);
	}

	context.subscriptions.push({ dispose: () => provider.stopWatchers() });
	context.subscriptions.push({ dispose: () => provider.stopPeriodicAutoKick() });
	provider.startWatchers();
	provider.startPeriodicAutoKick();
}

export function deactivate() { /* no-op */ }

class QueueProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _watchers: Array<{ close: () => void }> = [];
	private _kickInFlight = false;
	private _lastAutoKickAt = 0;
	// v0.2.16 — set the moment kickClaudeCodeChat returns success, BEFORE
	// Claude Code's UserPromptSubmit hook has had time to write the
	// user-submit.json marker file. Closes the file-write race that caused
	// 5 kicks to fire in 4 seconds.
	private _lastSuccessfulKickAt = 0;
	private _periodicTimer: NodeJS.Timeout | undefined;
	private _paths: WorkspacePaths = currentPaths();

	// Debounce / safety thresholds for auto-kick.
	// v0.2.13 — removed AUTO_KICK_COOLDOWN_MS; we now rely entirely on the
	// hook-recency check, which is the more accurate signal of "Claude is
	// active". A cooldown on TOP of recency just delayed kicking after
	// Claude had clearly idle'd.
	private static HOOK_RECENT_THRESHOLD_MS = 30_000;
	private static PERIODIC_CHECK_INTERVAL_MS = 30_000;
	// If we kicked but no hook fire has happened in 5 minutes, assume
	// Claude is stuck or the hook is broken; re-kick as a recovery. Long
	// enough that real long-running Claude turns won't trigger it.
	private static KICK_MAX_WAIT_MS = 5 * 60_000;
	// v0.2.17 — If LASTSUB > LASTSTOP but LASTSUB is older than this
	// threshold, treat Claude as idle rather than busy. Covers the case
	// where Claude Code stops firing Stop hooks (rate limit, session
	// ended, or other state), which would otherwise leave the gate stuck
	// on "busy" forever. Most Claude turns finish in well under 2 minutes,
	// so kicking after 2 min of unresolved submission is reasonable.
	private static STALE_SUBMIT_THRESHOLD_MS = 2 * 60_000;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = getWebviewHtml();
		view.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
		this.pushQueueFromDisk();
		this.pushHistoryFromDisk();
		this.refreshStatus();
		// If we open with pending items already in the queue (e.g. the user
		// added prompts in a previous session while Claude was idle, then
		// reloaded VS Code), give them a kick now so the work continues.
		// Same idle/cooldown safeguards as a runtime add.
		setTimeout(() => {
			// v0.2.20 — re-enabled default.
			const cfg = vscode.workspace.getConfiguration('claudeCodeModified');
			if (cfg.get<boolean>('autoKickWhenIdle', true)
				&& loadQueueFromFile(this._paths.queueFile).length > 0) {
				this._maybeAutoKick();
			}
		}, 1500);
	}

	private _handleMessage(msg: any) {
		switch (msg.type) {
			case 'saveQueue':
				if (Array.isArray(msg.data)) {
					const previousQueue = loadQueueFromFile(this._paths.queueFile);
					try {
						saveQueueToFile(this._paths.queueFile, msg.data);
					} catch (err: any) {
						this._post({ type: 'note', data: 'Could not save queue: ' + err.message });
					}
					// Auto-kick reborn (safer than v0.2.4): only fire when the
					// queue transitions from empty → non-empty AND the user's
					// session looks idle (no recent hook fire, no recent kick).
					// v0.2.20 — auto-kick re-enabled by default. v0.2.19's
					// "disable everything for safety" took away the feature
					// users actually want (queue drains when Claude is
					// idle). v0.2.18's verification + restore-on-miss
					// safety net catches silent failures.
					const cfg = vscode.workspace.getConfiguration('claudeCodeModified');
					if (cfg.get<boolean>('autoKickWhenIdle', true)
						&& previousQueue.length === 0
						&& msg.data.length > 0) {
						this._maybeAutoKick();
					}
				}
				return;
			case 'fireNow':
				if (this._kickInFlight) {
					this._post({ type: 'note', data: 'A kick is already in flight — give it a moment.' });
					return;
				}
				this._maybeKickHead('manual');
				return;
			case 'installHook':
				try {
					const r = installHook(this.context.extensionPath);
					this._post({ type: 'note', data: 'Stop hook installed.\nSettings: ' + r.settingsFile });
				} catch (err: any) {
					this._post({ type: 'note', data: 'Hook install failed: ' + err.message });
				}
				this.refreshStatus();
				return;
			case 'uninstallHook':
				uninstallHook();
				this._post({ type: 'note', data: 'Stop hook removed.' });
				this.refreshStatus();
				return;
			case 'requestStatus':
				this.refreshStatus();
				this.pushHistoryFromDisk();
				return;
			case 'clearHistory':
				try {
					if (fs.existsSync(this._paths.historyFile)) {
						fs.writeFileSync(this._paths.historyFile, '[]');
					}
				} catch (_) { /* noop */ }
				this.pushHistoryFromDisk();
				return;
			case 'pickFiles':
				vscode.window.showOpenDialog({
					canSelectFiles: true,
					canSelectFolders: false,
					canSelectMany: true,
					openLabel: 'Attach to queued prompt'
				}).then((picked) => {
					if (!picked || picked.length === 0) { return; }
					for (const uri of picked) {
						this._post({ type: 'fileAttached', data: { path: uri.fsPath } });
					}
				}, () => { /* user cancelled */ });
				return;
			case 'saveImage':
				try {
					const saved = saveBase64Image(msg.data || '', msg.mimeType || 'image/png');
					this._post({ type: 'fileAttached', data: { path: saved } });
				} catch (err: any) {
					if (err && err.name === 'ImageTooLargeError') {
						const mb = (err.actualBytes / 1024 / 1024).toFixed(1);
						const limitMb = (err.maxBytes / 1024 / 1024).toFixed(0);
						this._post({ type: 'note', data: `Image too large (${mb} MB). Limit is ${limitMb} MB per paste. Resize or screenshot a smaller region.` });
					} else {
						this._post({ type: 'note', data: 'Could not save pasted image: ' + err.message });
					}
				}
				return;
			case 'probeAccessibility':
				this.probeAccessibility();
				return;
			case 'openAccessibilityPrefs':
				vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
				return;
		}
	}

	private _post(message: any) {
		this._view?.webview.postMessage(message);
	}

	public pushQueueFromDisk(): void {
		this._post({ type: 'restoreQueue', data: loadQueueFromFile(this._paths.queueFile) });
	}

	public pushHistoryFromDisk(): void {
		this._post({ type: 'history', data: loadHistoryFromFile(this._paths.historyFile) });
	}

	public refreshStatus(): void {
		const lastSubAt = this._lastUserSubmitAt();
		const lastStopAt = this._lastHookFireAt();
		this._post({
			type: 'status',
			data: {
				queueFile: this._paths.queueFile,
				historyFile: this._paths.historyFile,
				nativeStatusFile: this._paths.nativeStatusFile,
				hookScript: this._paths.hookScript,
				settingsFile: this._paths.settingsFile,
				workspacePath: this._paths.workspacePath,
				hookInstalled: isHookInstalled(),
				nativeStatus: loadNativeStatus(this._paths.nativeStatusFile),
				lastUserSubmitAt: lastSubAt,
				lastStopAt: lastStopAt,
				claudeBusy: lastSubAt > lastStopAt
			}
		});
	}

	public handleWorkspaceChange(): void {
		this.stopWatchers();
		this._paths = currentPaths();
		this.startWatchers();
		this.pushQueueFromDisk();
		this.pushHistoryFromDisk();
		this.refreshStatus();
	}

	public async probeAccessibility(): Promise<void> {
		if (process.platform !== 'darwin') {
			this._post({ type: 'note', data: 'Native submit is macOS-only.' });
			return;
		}
		this._post({ type: 'note', data: 'Probing macOS Accessibility…' });
		try {
			cp.execFileSync(
				'osascript',
				['-e', 'tell application "System Events" to get name of first application process'],
				{ encoding: 'utf8', timeout: 2500 }
			);
			fs.writeFileSync(this._paths.nativeStatusFile, JSON.stringify({ ok: true, at: Date.now() }, null, 2));
			this._post({ type: 'note', data: '✓ Accessibility permission OK — native submit will work for the next Stop hook fire.' });
		} catch (err: any) {
			const msg = (err && err.message || String(err)).toString();
			fs.writeFileSync(this._paths.nativeStatusFile, JSON.stringify({
				ok: false, lastError: msg, timedOut: msg.indexOf('ETIMEDOUT') >= 0, at: Date.now()
			}, null, 2));
			this._post({
				type: 'note',
				data: '✗ Accessibility probe failed: ' + msg + '\nOpen System Settings → Privacy & Security → Automation, find Visual Studio Code in the list, expand it, and allow "System Events". Then click Probe again.'
			});
		}
		this.refreshStatus();
	}

	public async firePendingNow(): Promise<void> {
		await this._maybeKickHead('manual');
	}

	/**
	 * Auto-kick gate. Returns immediately unless all of the following hold:
	 *
	 *   - claudeCodeModified.autoKickWhenIdle is true (default)
	 *   - no other kick is currently in flight
	 *   - we haven't auto-kicked in the last AUTO_KICK_COOLDOWN_MS
	 *   - the Stop hook hasn't fired in the last HOOK_RECENT_THRESHOLD_MS
	 *     (recent hook activity ⇒ Claude is mid-flow, the hook is already
	 *     draining the queue, no need for us to inject)
	 *
	 * The cooldown is the key safety: v0.2.4 didn't have one, so rapid
	 * sequential prompt-adds (each transitioning 0→1 after the previous
	 * kick drained the head) produced a barrage of kicks at a Claude that
	 * was still processing the previous one.
	 */
	/**
	 * The watchdog gate. v0.2.15: uses the **UserPromptSubmit hook** as the
	 * precise "Claude is busy" signal, instead of inferring from history.
	 *
	 *   LASTSUB  = timestamp of the most recent UserPromptSubmit event
	 *              (recorded by our user-prompt-submit-hook.js)
	 *   LASTSTOP = timestamp of the most recent Stop event with source 'hook'
	 *              (recorded by our stop-hook.js)
	 *
	 * Decision tree:
	 *
	 *   • LASTSUB > LASTSTOP                  → Claude is currently
	 *                                            processing the latest user
	 *                                            prompt — DO NOT kick.
	 *   • LASTSTOP > LASTSUB                  → Claude finished its last
	 *                                            turn. If it's been
	 *                                            ≥HOOK_RECENT_THRESHOLD_MS,
	 *                                            kick the next item.
	 *   • Both zero, queue has items          → first ever kick, fire.
	 *
	 * Recovery: if we kicked but neither LASTSUB nor LASTSTOP has changed
	 * in KICK_MAX_WAIT_MS (5 min), assume something is stuck and re-kick.
	 */
	public _maybeAutoKick(): void {
		if (this._kickInFlight) { return; }
		const now = Date.now();
		const fileLastSubAt = this._lastUserSubmitAt();
		// Effective LASTSUB: take the max of the file-based timestamp (from
		// the UserPromptSubmit hook) and our in-memory _lastSuccessfulKickAt
		// (which we set the moment osascript returns success). This closes
		// the race where Claude Code hasn't written user-submit.json yet
		// after our typed-in prompt but our next saveQueue handler has
		// already evaluated the busy check.
		const lastSubAt = Math.max(fileLastSubAt, this._lastSuccessfulKickAt);
		const lastStopAt = this._lastHookFireAt();
		const lastKickAt = this._lastAutoKickAt;

		// CASE 1: Claude is currently busy (a prompt was submitted, no Stop
		// yet) — usually means we should not kick mid-turn.
		if (lastSubAt > lastStopAt) {
			const submitAge = now - lastSubAt;

			// 1a. STALE SUBMIT recovery (v0.2.17). If the user-submit
			//     marker is older than STALE_SUBMIT_THRESHOLD_MS and there's
			//     still no Stop event, Claude is almost certainly not
			//     actually processing anymore — likely scenarios:
			//       - Claude hit a rate limit and never completed
			//       - The Claude Code session ended (user closed chat)
			//       - Claude Code stopped firing Stop hooks for this session
			//     Kick the queue rather than wait forever.
			if (submitAge >= QueueProvider.STALE_SUBMIT_THRESHOLD_MS) {
				this._lastAutoKickAt = now;
				this._maybeKickHead('auto');
				return;
			}

			// 1b. Normal recovery: we kicked but nothing has progressed for
			//     KICK_MAX_WAIT_MS. Re-kick.
			if (lastKickAt > 0 && now - lastKickAt >= QueueProvider.KICK_MAX_WAIT_MS) {
				this._lastAutoKickAt = now;
				this._maybeKickHead('auto');
			}
			return;
		}

		// CASE 2: Claude finished its last turn (Stop came after the latest
		// user submit). Only kick once it's been idle for the threshold.
		if (lastStopAt > 0) {
			if (now - lastStopAt >= QueueProvider.HOOK_RECENT_THRESHOLD_MS) {
				this._lastAutoKickAt = now;
				this._maybeKickHead('auto');
			}
			return;
		}

		// CASE 3: never observed either signal (fresh install, no Claude
		// activity yet, hooks just installed). Fire to get things started.
		this._lastAutoKickAt = now;
		this._maybeKickHead('auto');
	}

	private _lastUserSubmitAt(): number {
		const marker = loadUserSubmitMarker(this._paths.userSubmitFile);
		return marker && typeof marker.submittedAt === 'number' ? marker.submittedAt : 0;
	}

	/**
	 * After a successful osascript kick, poll the user-submit marker file
	 * for up to 5 seconds. If Claude Code received the typed prompt, its
	 * UserPromptSubmit hook will have fired and updated the marker. If the
	 * marker doesn't advance, osascript "succeeded" but the paste went
	 * somewhere other than Claude's chat input — we put the item back.
	 */
	private async _verifyKickReachedClaudeCode(subBeforeKick: number, kickStartedAt: number): Promise<boolean> {
		const POLL_INTERVAL_MS = 100;
		const TIMEOUT_MS = 5_000;
		const start = Date.now();
		while (Date.now() - start < TIMEOUT_MS) {
			await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
			const subNow = this._lastUserSubmitAt();
			// New submit recorded AFTER our kick started → Claude Code
			// received the prompt.
			if (subNow > subBeforeKick && subNow >= kickStartedAt - 1000) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Start a 30-second periodic check that unstucks the queue if Claude
	 * Code stops firing Stop hooks for any reason (session ended, hook
	 * timeout, etc.). The actual decision to kick is made by _maybeAutoKick
	 * which has all the safeguards.
	 */
	public startPeriodicAutoKick(): void {
		if (this._periodicTimer) { return; }
		this._periodicTimer = setInterval(() => {
			// v0.2.20 — watchdog re-enabled by default.
			const cfg = vscode.workspace.getConfiguration('claudeCodeModified');
			if (!cfg.get<boolean>('autoKickWhenIdle', true)) { return; }
			if (loadQueueFromFile(this._paths.queueFile).length === 0) { return; }
			this._maybeAutoKick();
		}, QueueProvider.PERIODIC_CHECK_INTERVAL_MS);
	}

	public stopPeriodicAutoKick(): void {
		if (this._periodicTimer) {
			clearInterval(this._periodicTimer);
			this._periodicTimer = undefined;
		}
	}

	/**
	 * Returns the timestamp of the most recent REAL hook fire (where Claude
	 * Code actually invoked our hook because a Claude turn ended).
	 * Extension-kick entries are filtered out — they're when WE initiated a
	 * turn, not when Claude finished one. Letting them count would make the
	 * watchdog fire a second kick 30s after the first while Claude was
	 * still processing.
	 *
	 * Backwards-compat: entries without a source field (from versions
	 * before v0.2.14) are treated as 'hook' fires.
	 */
	private _lastHookFireAt(): number {
		const hist = loadHistoryFromFile(this._paths.historyFile);
		for (let i = hist.length - 1; i >= 0; i--) {
			const e: any = hist[i];
			if (!e || typeof e.firedAt !== 'number') { continue; }
			if (e.source === 'hook' || e.source === undefined) {
				return e.firedAt;
			}
		}
		return 0;
	}

	private async _maybeKickHead(reason: 'auto' | 'manual'): Promise<void> {
		if (this._kickInFlight) { return; }
		this._kickInFlight = true;
		// Tell the webview the kick started so it can show a spinner on the
		// Fire-now button; cleared on completion below.
		this._post({ type: 'kickInFlight', data: { active: true } });
		try {
			const queue = loadQueueFromFile(this._paths.queueFile);
			if (queue.length === 0) {
				if (reason === 'manual') {
					this._post({ type: 'note', data: 'Queue is empty — nothing to fire.' });
				}
				return;
			}
			const head = queue[0];
			const rest = queue.slice(1);
			saveQueueToFile(this._paths.queueFile, rest);
			this._post({ type: 'restoreQueue', data: rest });

			// v0.2.20 — native submit defaults to ON. The verification
			// step below catches silent failures and restores the item.
			const cfgNative = vscode.workspace.getConfiguration('claudeCodeModified');
			const nativeEnabled = cfgNative.get<boolean>('enableNativeSubmit', true);
			if (!nativeEnabled && reason === 'auto') {
				return;
			}

			// v0.2.18 — focus Anthropic's chat input via their VS Code
			// command BEFORE osascript runs. Their Cmd+Esc keybinding has
			// a `when: editorTextFocus` clause, so when our Fire-now
			// button is clicked the keystroke fires from a webview (no
			// editor focus) and does nothing — the paste would then land
			// in the wrong control. executeCommand bypasses the when
			// clause and focuses Claude's chat unconditionally.
			let focusedViaCommand = false;
			try {
				await vscode.commands.executeCommand('claude-vscode.focus');
				focusedViaCommand = true;
				// Small settle for focus to take effect before paste
				await new Promise<void>((r) => setTimeout(r, 200));
			} catch (_) {
				// Anthropic extension missing or older version without the
				// focus command — fall back to the osascript Cmd+Esc dance.
				focusedViaCommand = false;
			}

			const kickStartedAt = Date.now();
			const subBeforeKick = this._lastUserSubmitAt();
			const result = await kickClaudeCodeChat(head.text || '', { skipFocusKeystroke: focusedViaCommand });
			if (result.success) {
				// Set _lastSuccessfulKickAt IMMEDIATELY — before the
				// UserPromptSubmit hook can race-write user-submit.json
				// behind us. Any auto-kick attempt between here and that
				// file write will see this in-memory value and correctly
				// treat Claude as busy.
				this._lastSuccessfulKickAt = Date.now();
				try { this._appendHistory(head.text || ''); } catch (_) { /* noop */ }
				this.pushHistoryFromDisk();

				// v0.2.18 — verify osascript actually reached Claude Code
				// by polling user-submit.json for an update. osascript can
				// return "ok" even when the paste landed in the wrong
				// control (e.g., when chat input wasn't focused).
				const verified = await this._verifyKickReachedClaudeCode(subBeforeKick, kickStartedAt);
				if (!verified) {
					// Put the item back at the head so it isn't lost.
					const restored = [head, ...rest];
					saveQueueToFile(this._paths.queueFile, restored);
					this._post({ type: 'restoreQueue', data: restored });
					this._post({
						type: 'note',
						data: '⚠ Kick fired but Claude Code did not register the prompt — the paste may have landed in the wrong control. Click into Claude Code\'s chat input manually, then Fire now again. If this keeps happening, restart Claude Code\'s session.'
					});
					vscode.window.showWarningMessage(
						'Claude Mod: kick fired but Claude Code did not receive the prompt. Click into the chat input manually and try again.',
						'Focus Claude'
					).then((choice) => {
						if (choice === 'Focus Claude') {
							vscode.commands.executeCommand('claude-vscode.focus').then(undefined, () => {});
						}
					});
				}
			} else {
				// Put the item back so it isn't lost.
				const restored = [head, ...rest];
				saveQueueToFile(this._paths.queueFile, restored);
				this._post({ type: 'restoreQueue', data: restored });

				// Categorise the failure so the user knows what to do next.
				const err = (result.error || 'unknown').toString();
				const isTimeout = err.indexOf('ETIMEDOUT') >= 0 || err.indexOf('timed out') >= 0;
				const isPermissionLike = isTimeout || err.indexOf('-1743') >= 0 || err.indexOf('not authorized') >= 0;
				if (isPermissionLike) {
					this._post({ type: 'note', data: '✗ Kick failed: macOS hasn\'t granted Accessibility / Automation permission to VS Code. Click Open prefs and enable VS Code → System Events.' });
					// Also surface a VS Code notification with an action button
					// so the user can't miss it.
					vscode.window.showWarningMessage(
						'Claude Mod: macOS Accessibility / Automation permission missing — pending prompts can\'t be typed into Claude\'s chat.',
						'Open System Settings',
						'Run Probe'
					).then((choice) => {
						if (choice === 'Open System Settings') {
							vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
						} else if (choice === 'Run Probe') {
							this.probeAccessibility();
						}
					});
					// Also reflect the failure in the status pill via the
					// native-status file so the inline help card appears.
					try {
						fs.writeFileSync(this._paths.nativeStatusFile, JSON.stringify({
							ok: false, lastError: err, timedOut: isTimeout, at: Date.now()
						}, null, 2));
						this.refreshStatus();
					} catch (_) { /* noop */ }
				} else {
					this._post({ type: 'note', data: 'Kick failed: ' + err });
				}
			}
		} finally {
			this._kickInFlight = false;
			this._post({ type: 'kickInFlight', data: { active: false } });
		}
	}

	private _appendHistory(text: string): void {
		let entries: Array<{ text: string; firedAt: number; source?: string }> = [];
		if (fs.existsSync(this._paths.historyFile)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(this._paths.historyFile, 'utf8'));
				if (Array.isArray(parsed)) { entries = parsed; }
			} catch (_) { /* corrupt → start fresh */ }
		}
		// source:'extension-kick' marks this as our own osascript-driven
		// kick (we initiated a turn). The watchdog filters these out when
		// deciding whether to fire again — otherwise an in-flight Claude
		// turn would look like "hook fired N seconds ago" and the watchdog
		// would kick again mid-processing.
		entries.push({ text, firedAt: Date.now(), source: 'extension-kick' });
		if (entries.length > 50) { entries = entries.slice(-50); }
		fs.writeFileSync(this._paths.historyFile, JSON.stringify(entries, null, 2));
	}

	public startWatchers(): void {
		const targets: Array<[string, () => void]> = [
			[this._paths.queueFile, () => this.pushQueueFromDisk()],
			[this._paths.historyFile, () => this.pushHistoryFromDisk()],
			[this._paths.settingsFile, () => this.refreshStatus()],
			[this._paths.nativeStatusFile, () => this.refreshStatus()],
			[this._paths.userSubmitFile, () => this.refreshStatus()],
		];
		for (const [file, onChange] of targets) {
			fs.watchFile(file, { interval: 800 }, () => onChange());
			this._watchers.push({ close: () => fs.unwatchFile(file) });
			try {
				if (fs.existsSync(file)) {
					const w = fs.watch(file, { persistent: false }, () => onChange());
					this._watchers.push({ close: () => w.close() });
				}
			} catch (_) { /* polling fallback covers us */ }
		}
	}

	public stopWatchers(): void {
		for (const w of this._watchers) {
			try { w.close(); } catch (_) { /* noop */ }
		}
		this._watchers = [];
	}
}
