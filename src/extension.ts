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
	refreshStableHookScript,
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

function currentPaths(): WorkspacePaths {
	const ws = currentWorkspacePath();
	return ws === '__no-workspace__' ? getPathsForFallback() : getPathsForWorkspace(ws);
}

export function activate(context: vscode.ExtensionContext) {
	try {
		refreshStableHookScript(context.extensionPath);
	} catch (err: any) {
		console.warn('[claude-mod] could not refresh hook script:', err.message);
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
	private _periodicTimer: NodeJS.Timeout | undefined;
	private _paths: WorkspacePaths = currentPaths();

	// Debounce / safety thresholds for auto-kick.
	// v0.2.13 — removed AUTO_KICK_COOLDOWN_MS; we now rely entirely on the
	// hook-recency check, which is the more accurate signal of "Claude is
	// active". A cooldown on TOP of recency just delayed kicking after
	// Claude had clearly idle'd.
	private static HOOK_RECENT_THRESHOLD_MS = 30_000;
	private static PERIODIC_CHECK_INTERVAL_MS = 30_000;

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
				nativeStatus: loadNativeStatus(this._paths.nativeStatusFile)
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
	public _maybeAutoKick(): void {
		if (this._kickInFlight) { return; }
		const now = Date.now();
		const lastHookFireAt = this._lastHookFireAt();
		if (now - lastHookFireAt < QueueProvider.HOOK_RECENT_THRESHOLD_MS) {
			// Hook fired recently — Claude is mid-flow, hook is draining the
			// queue, leave it alone.
			return;
		}
		// All clear — fire it.
		this._lastAutoKickAt = now;
		this._maybeKickHead('auto');
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

	private _lastHookFireAt(): number {
		const hist = loadHistoryFromFile(this._paths.historyFile);
		if (hist.length === 0) { return 0; }
		const last = hist[hist.length - 1];
		return last && typeof last.firedAt === 'number' ? last.firedAt : 0;
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

			const result = await kickClaudeCodeChat(head.text || '');
			if (result.success) {
				try { this._appendHistory(head.text || ''); } catch (_) { /* noop */ }
				this.pushHistoryFromDisk();
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
		let entries: Array<{ text: string; firedAt: number }> = [];
		if (fs.existsSync(this._paths.historyFile)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(this._paths.historyFile, 'utf8'));
				if (Array.isArray(parsed)) { entries = parsed; }
			} catch (_) { /* corrupt → start fresh */ }
		}
		entries.push({ text, firedAt: Date.now() });
		if (entries.length > 50) { entries = entries.slice(-50); }
		fs.writeFileSync(this._paths.historyFile, JSON.stringify(entries, null, 2));
	}

	public startWatchers(): void {
		const targets: Array<[string, () => void]> = [
			[this._paths.queueFile, () => this.pushQueueFromDisk()],
			[this._paths.historyFile, () => this.pushHistoryFromDisk()],
			[this._paths.settingsFile, () => this.refreshStatus()],
			[this._paths.nativeStatusFile, () => this.refreshStatus()],
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
