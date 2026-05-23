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
	provider.startWatchers();
}

export function deactivate() { /* no-op */ }

class QueueProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _watchers: Array<{ close: () => void }> = [];
	private _kickInFlight = false;
	private _paths: WorkspacePaths = currentPaths();

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
						saveQueueToFile(this._paths.queueFile, msg.data);
					} catch (err: any) {
						this._post({ type: 'note', data: 'Could not save queue: ' + err.message });
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
					this._post({ type: 'note', data: 'Could not save pasted image: ' + err.message });
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

	private async _maybeKickHead(reason: 'auto' | 'manual'): Promise<void> {
		if (this._kickInFlight) { return; }
		this._kickInFlight = true;
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
				const restored = [head, ...rest];
				saveQueueToFile(this._paths.queueFile, restored);
				this._post({ type: 'restoreQueue', data: restored });
				this._post({
					type: 'note',
					data: 'Kick failed: ' + (result.error || 'unknown') +
						'\nFirst run requires macOS Accessibility permission for VS Code (System Settings → Privacy & Security → Accessibility / Automation).'
				});
			}
		} finally {
			this._kickInFlight = false;
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
