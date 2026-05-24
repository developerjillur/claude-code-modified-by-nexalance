import * as vscode from 'vscode';
import * as fs from 'fs';
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
	refreshStableHookScript,
	saveBase64Image,
	migrateLegacyGlobalQueue,
	cleanupLegacyArtifacts,
	WorkspacePaths
} from './hook-setup';

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

	// v0.3.0 housekeeping — remove leftover osascript/user-submit artifacts
	// from older versions so ~/.claude/ stays tidy.
	try { cleanupLegacyArtifacts(currentWorkspacePath()); } catch (_) { /* noop */ }

	// Per-workspace migration: v0.2.7 stored a single global queue at
	// ~/.claude/claude-mod-queue.json. Move its contents (if any) into the
	// current workspace's queue on first activation of v0.2.8+.
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
	// path, re-install so the reference survives future updates. v0.3.0 also
	// re-installs to strip the v0.2.x env-var prefix and the user-submit
	// hook entry.
	try {
		const paths = currentPaths();
		if (isHookInstalled()) {
			const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf8'));
			const ourEntry = (settings.hooks?.Stop || []).find((h: any) =>
				JSON.stringify(h).includes('claude-mod-stop-hook')
			);
			const cmd: string = ourEntry?.hooks?.[0]?.command || '';
			const needsMigration = !cmd.includes(paths.hookScript)
				|| cmd.includes('CLAUDE_MOD_ENABLE_NATIVE')
				|| cmd.includes('CLAUDE_MOD_DISABLE_NATIVE')
				|| Array.isArray(settings.hooks?.UserPromptSubmit);
			if (needsMigration) {
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
				hookScript: this._paths.hookScript,
				settingsFile: this._paths.settingsFile,
				workspacePath: this._paths.workspacePath,
				hookInstalled: isHookInstalled()
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

	public startWatchers(): void {
		const targets: Array<[string, () => void]> = [
			[this._paths.queueFile, () => this.pushQueueFromDisk()],
			[this._paths.historyFile, () => this.pushHistoryFromDisk()],
			[this._paths.settingsFile, () => this.refreshStatus()],
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
