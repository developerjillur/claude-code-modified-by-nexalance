import * as vscode from 'vscode';
import * as fs from 'fs';
import { getWebviewHtml } from './webview';
import * as cp from 'child_process';
import {
	getPaths,
	installHook,
	uninstallHook,
	isHookInstalled,
	loadQueueFromFile,
	saveQueueToFile,
	loadHistoryFromFile,
	refreshStableHookScript,
	saveBase64Image,
	getAttachmentsDir,
	loadNativeStatus
} from './hook-setup';
import { kickClaudeCodeChat } from './auto-kick';

export function activate(context: vscode.ExtensionContext) {
	// Every activation copies the latest bundled hook script into the stable
	// location at ~/.claude/claude-mod-hook.js. This way, when the extension
	// updates to a new version, the hook reference in settings.json keeps
	// working without the user having to re-run the install button.
	try {
		const refreshed = refreshStableHookScript(context.extensionPath);
		if (refreshed) {
			console.log('[claude-mod] hook script at stable path refreshed');
		}
	} catch (err: any) {
		console.warn('[claude-mod] could not refresh hook script:', err.message);
	}

	// Migration: if a previous version (< 0.2.1) installed the hook with the
	// command pointing at the extension's versioned install folder, the path
	// breaks every time the extension updates. Detect that and re-install so
	// the command points at the stable ~/.claude/claude-mod-hook.js path.
	try {
		const paths = getPaths();
		if (isHookInstalled()) {
			const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
			const ourEntry = (settings.hooks?.Stop || []).find((h: any) =>
				JSON.stringify(h).includes('claude-mod-stop-hook')
			);
			const cmd: string = ourEntry?.hooks?.[0]?.command || '';
			const pointsAtStable = cmd.includes(paths.hookScript);
			if (!pointsAtStable) {
				console.log('[claude-mod] migrating hook from versioned path → stable path');
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
		vscode.commands.registerCommand('claude-code-modified.openAccessibilityPrefs', async () => {
			// Open the macOS Privacy → Automation pane so the user can grant
			// VS Code permission to control System Events. The url-scheme
			// `x-apple.systempreferences:` is the documented way to deep-link.
			await vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claude-code-modified.probeAccessibility', async () => {
			await provider.probeAccessibility();
		})
	);

	const cfg = vscode.workspace.getConfiguration('claudeCodeModified');
	if (cfg.get<boolean>('autoOpenOnStartup', true)) {
		setTimeout(() => {
			vscode.commands.executeCommand('workbench.view.extension.claude-code-modified')
				.then(undefined, () => { /* noop */ });
		}, 600);
	}

	// File watching — see QueueProvider.startWatchers for the implementation.
	context.subscriptions.push({ dispose: () => provider.stopWatchers() });
	provider.startWatchers();
}

export function deactivate() { /* no-op */ }

class QueueProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _watchers: Array<{ close: () => void }> = [];
	private _kickInFlight = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = getWebviewHtml();
		view.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));

		this.pushQueueFromDisk();
		this.pushHistoryFromDisk();
		this.refreshStatus();
	}

	private _handleMessage(msg: any) {
		switch (msg.type) {
			case 'saveQueue':
				if (Array.isArray(msg.data)) {
					try {
						saveQueueToFile(msg.data);
					} catch (err: any) {
						this._post({ type: 'note', data: 'Could not save queue: ' + err.message });
					}
					// NOTE: v0.2.4's "auto-kick on queue add" path has been
					// removed in v0.2.5. It was firing one kick per saveQueue
					// transition, and since every addPrompt persists, a quick
					// sequence of prompt-adds while Claude was already busy
					// produced a barrage of kicks all aimed at a Claude that
					// was still processing the previous one. Two safer
					// trigger paths remain: (1) the Stop hook drains the
					// queue when Claude finishes each turn, (2) the user
					// clicks the green "Fire now" button when they want to
					// push the head into Claude's chat from an idle state.
				}
				return;
			case 'fireNow':
				// Manual button click — always try to kick, regardless of state.
				// Guarded against rapid double-clicks by an in-flight flag.
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
			case 'probeAccessibility':
				this.probeAccessibility();
				return;
			case 'openAccessibilityPrefs':
				vscode.env.openExternal(vscode.Uri.parse('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'));
				return;
			case 'clearHistory':
				try {
					const paths = getPaths();
					if (fs.existsSync(paths.historyFile)) {
						fs.writeFileSync(paths.historyFile, '[]');
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
					this._post({ type: 'note', data: 'Could not save pasted image: ' + err.message });
				}
				return;
		}
	}

	private _post(message: any) {
		this._view?.webview.postMessage(message);
	}

	public pushQueueFromDisk(): void {
		this._post({ type: 'restoreQueue', data: loadQueueFromFile() });
	}

	public pushHistoryFromDisk(): void {
		this._post({ type: 'history', data: loadHistoryFromFile() });
	}

	public refreshStatus(): void {
		this._post({
			type: 'status',
			data: {
				...getPaths(),
				hookInstalled: isHookInstalled(),
				nativeStatus: loadNativeStatus()
			}
		});
	}

	/**
	 * Try a very lightweight osascript probe to surface Accessibility /
	 * Automation permission state in the UI. On success, writes ok=true to
	 * the native-status file. On failure (most commonly timeout because the
	 * permission isn't granted), writes the error and the UI prompts the
	 * user to open System Settings.
	 *
	 * The first time this runs on a system that hasn't granted the
	 * permission, macOS shows the standard "Visual Studio Code wants to
	 * control System Events" prompt — clicking Allow grants the permission.
	 */
	public async probeAccessibility(): Promise<void> {
		if (process.platform !== 'darwin') {
			this._post({ type: 'note', data: 'Native submit is macOS-only. On other platforms the queue uses Stop-hook feedback delivery, which always works.' });
			return;
		}
		const paths = getPaths();
		this._post({ type: 'note', data: 'Probing macOS Accessibility… if no permission yet, watch for a "Visual Studio Code wants to control System Events" prompt.' });
		try {
			cp.execFileSync(
				'osascript',
				['-e', 'tell application "System Events" to get name of first application process'],
				{ encoding: 'utf8', timeout: 2500 }
			);
			fs.writeFileSync(paths.nativeStatusFile, JSON.stringify({ ok: true, at: Date.now() }, null, 2));
			this._post({ type: 'note', data: '✓ Accessibility permission OK — native submit will work for the next Stop hook fire.' });
		} catch (err: any) {
			const msg = (err && err.message || String(err)).toString();
			fs.writeFileSync(paths.nativeStatusFile, JSON.stringify({
				ok: false, lastError: msg, timedOut: msg.indexOf('ETIMEDOUT') >= 0, at: Date.now()
			}, null, 2));
			this._post({
				type: 'note',
				data: '✗ Accessibility probe failed: ' + msg + '\nOpen System Settings → Privacy & Security → Automation, find Visual Studio Code in the list, expand it, and allow "System Events". Then click Probe again.'
			});
		}
		this.refreshStatus();
	}

	/**
	 * Returns true if the Stop hook fired in the last 45 seconds — used as a
	 * proxy signal for "Claude is busy / mid-flow". When true, auto-kick
	 * suppresses itself because the hook is already draining the queue.
	 */
	private _hookFiredRecently(): boolean {
		const history = loadHistoryFromFile();
		if (history.length === 0) { return false; }
		const last = history[history.length - 1];
		const age = Date.now() - (last.firedAt || 0);
		return age < 45_000;
	}

	/**
	 * Take the head item off the queue and push it into Claude's chat input
	 * via osascript. On failure (denied permissions, osascript error, etc.),
	 * the item is put back at the head so nothing is lost.
	 */
	public async firePendingNow(): Promise<void> {
		await this._maybeKickHead('manual');
	}

	private async _maybeKickHead(reason: 'auto' | 'manual'): Promise<void> {
		if (this._kickInFlight) { return; }
		this._kickInFlight = true;
		try {
			const queue = loadQueueFromFile();
			if (queue.length === 0) {
				if (reason === 'manual') {
					this._post({ type: 'note', data: 'Queue is empty — nothing to fire.' });
				}
				return;
			}
			const head = queue[0];
			const rest = queue.slice(1);
			// Remove from queue first so the Stop hook (if it fires concurrently)
			// can't also consume this same item.
			saveQueueToFile(rest);
			this._post({ type: 'restoreQueue', data: rest });

			const result = await kickClaudeCodeChat(head.text || '');
			if (result.success) {
				// Log the fire to the history file so it appears in the same
				// "Last fired by hook" panel the Stop-hook fires use — no
				// separate, accumulating "Auto-kicked Claude with:" notes
				// cluttering the UI. The panel already has a Clear button.
				try { this._appendHistory(head.text || ''); } catch (_) { /* noop */ }
				this.pushHistoryFromDisk();
			} else {
				// Put it back at the head — try again next time
				const restored = [head, ...rest];
				saveQueueToFile(restored);
				this._post({ type: 'restoreQueue', data: restored });
				this._post({
					type: 'note',
					data: 'Kick failed: ' + (result.error || 'unknown') +
						'\nFirst run requires macOS Accessibility permission for VS Code (System Settings → Privacy & Security → Accessibility).'
				});
			}
		} finally {
			this._kickInFlight = false;
		}
	}

	private _appendHistory(text: string): void {
		const paths = getPaths();
		let entries: Array<{ text: string; firedAt: number }> = [];
		if (fs.existsSync(paths.historyFile)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(paths.historyFile, 'utf8'));
				if (Array.isArray(parsed)) { entries = parsed; }
			} catch (_) { /* corrupt → start fresh */ }
		}
		entries.push({ text, firedAt: Date.now() });
		if (entries.length > 50) { entries = entries.slice(-50); }
		fs.writeFileSync(paths.historyFile, JSON.stringify(entries, null, 2));
	}

	/**
	 * Watch the queue + history + settings files so the UI reflects external
	 * changes (the hook script consuming items, the user editing settings).
	 *
	 * Implementation notes:
	 *  - `fs.watch` is the fast/responsive path on most OSes but is known to
	 *    miss events on macOS when changes come from a different process.
	 *  - `fs.watchFile` polls every N ms — slower but never misses, and works
	 *    even when the file is recreated by rename (which is what our atomic
	 *    write does).
	 *  - We use BOTH: watch for responsiveness, watchFile for reliability.
	 */
	public startWatchers(): void {
		const paths = getPaths();
		const targets: Array<[string, () => void]> = [
			[paths.queueFile, () => this.pushQueueFromDisk()],
			[paths.historyFile, () => this.pushHistoryFromDisk()],
			[paths.settingsFile, () => this.refreshStatus()],
		];

		for (const [file, onChange] of targets) {
			// fs.watchFile (polling) — reliable, works through atomic renames.
			fs.watchFile(file, { interval: 800 }, () => onChange());
			this._watchers.push({ close: () => fs.unwatchFile(file) });

			// fs.watch — responsive on platforms that support it. If the file
			// doesn't exist yet (the hook hasn't fired), watching the parent
			// directory catches the create event so we can attach later.
			try {
				if (fs.existsSync(file)) {
					const w = fs.watch(file, { persistent: false }, () => onChange());
					this._watchers.push({ close: () => w.close() });
				}
			} catch (_) { /* fs.watch can fail on some FS; polling fallback covers us */ }
		}
	}

	public stopWatchers(): void {
		for (const w of this._watchers) {
			try { w.close(); } catch (_) { /* noop */ }
		}
		this._watchers = [];
	}
}
