import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOOK_MARKER = 'claude-mod-stop-hook';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const WORKSPACES_ROOT = path.join(CLAUDE_DIR, 'claude-mod-queues');
const STABLE_HOOK_PATH = path.join(CLAUDE_DIR, 'claude-mod-hook.js');
const ATTACHMENTS_DIR = path.join(CLAUDE_DIR, 'claude-mod-attachments');

// Legacy v0.2.7 paths — the old global queue/history files. v0.2.8 migrates
// these into the current workspace's queue and renames the old files to .migrated.
const LEGACY_QUEUE_FILE = path.join(CLAUDE_DIR, 'claude-mod-queue.json');
const LEGACY_HISTORY_FILE = path.join(CLAUDE_DIR, 'claude-mod-history.json');
const LEGACY_NATIVE_STATUS_FILE = path.join(CLAUDE_DIR, 'claude-mod-native-status.json');

export interface QueueItem { id: string; text: string; createdAt: number; attachments?: string[]; }
export interface HistoryEntry { text: string; firedAt: number; }
export interface NativeStatus { ok: boolean; lastError?: string; timedOut?: boolean; at: number; }

export interface WorkspacePaths {
	workspacePath: string;
	workspaceDir: string;
	queueFile: string;
	historyFile: string;
	nativeStatusFile: string;
	hookScript: string;
	settingsFile: string;
	attachmentsDir: string;
}

/**
 * Canonicalize a workspace path so the same project always hashes to the
 * same dir regardless of trailing slash, relative components, or symlinks.
 *
 *   /Users/x/foo/        →   /Users/x/foo
 *   /Users/x/./foo       →   /Users/x/foo
 *   /tmp/foo (symlink)   →   /Users/x/foo  (resolved via realpath)
 *
 * Without this, the extension (which sees vscode.workspace.workspaceFolders[0].uri.fsPath)
 * and the hook (which sees the Stop event's `cwd`) can disagree on the
 * canonical form and write to two different workspace dirs.
 */
export function canonicalizeWorkspacePath(workspacePath: string): string {
	if (!workspacePath || workspacePath === '__no-workspace__') {
		return '__no-workspace__';
	}
	const resolved = path.resolve(workspacePath);
	try {
		return fs.realpathSync(resolved);
	} catch (_) {
		// Path doesn't exist on disk (or no permission to resolve) — fall back
		// to the resolved-but-not-realpathed form. Still better than the raw input.
		return resolved;
	}
}

/**
 * Per-workspace dir naming: `<safe-basename>-<sha1[0..8]>`.
 *
 *   /Users/x/Desktop/NexaLance/Kvanti-3   →   Kvanti-3-a3f5b2c1
 *   /Users/x/Sites/psychgate              →   psychgate-c41fd9a3
 *
 * Stable across runs (sha1 is deterministic) and human-recognisable (you can
 * tell which folder belongs to which project just by reading the dir name).
 */
function workspaceSafeName(workspacePath: string): string {
	const canon = canonicalizeWorkspacePath(workspacePath);
	const baseRaw = path.basename(canon) || 'workspace';
	const safe = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'workspace';
	const hash = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8);
	return safe + '-' + hash;
}

function workspaceDataDir(workspacePath: string): string {
	return path.join(WORKSPACES_ROOT, workspaceSafeName(workspacePath));
}

export function getPathsForWorkspace(workspacePath: string): WorkspacePaths {
	const dir = workspaceDataDir(workspacePath);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	return {
		workspacePath,
		workspaceDir: dir,
		queueFile: path.join(dir, 'queue.json'),
		historyFile: path.join(dir, 'history.json'),
		nativeStatusFile: path.join(dir, 'native-status.json'),
		hookScript: STABLE_HOOK_PATH,
		settingsFile: SETTINGS_FILE,
		attachmentsDir: ATTACHMENTS_DIR
	};
}

// Backwards-compat alias kept so the rest of the codebase compiles. Old global
// `getPaths()` callers now have to pick a workspace. Where no workspace is
// available we fall back to a sentinel name so the rest of the code keeps
// working in degenerate setups (e.g. VS Code opened with no folder).
export function getPathsForFallback(): WorkspacePaths {
	return getPathsForWorkspace('__no-workspace__');
}

export function getAttachmentsDir(): string {
	if (!fs.existsSync(ATTACHMENTS_DIR)) { fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true }); }
	return ATTACHMENTS_DIR;
}

const MIME_TO_EXT: Record<string, string> = {
	'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
	'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp'
};

// 10 MB after base64 decoding. A standard 4K screenshot is ~5 MB at PNG,
// so this is roomy enough for typical clipboard pastes but rejects the
// 50 MB+ "I screenshotted my whole 6K monitor twice" cases that would
// silently fill ~/.claude/claude-mod-attachments/.
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

export class ImageTooLargeError extends Error {
	constructor(public readonly actualBytes: number, public readonly maxBytes: number) {
		super('Pasted image is ' + actualBytes + ' bytes which exceeds the ' + maxBytes + '-byte limit.');
		this.name = 'ImageTooLargeError';
	}
}

export function saveBase64Image(base64Data: string, mimeType: string): string {
	const ext = MIME_TO_EXT[mimeType.toLowerCase()] || 'png';
	const buf = Buffer.from(base64Data, 'base64');
	if (buf.length > MAX_PASTED_IMAGE_BYTES) {
		throw new ImageTooLargeError(buf.length, MAX_PASTED_IMAGE_BYTES);
	}
	const filename = 'paste-' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.' + ext;
	const target = path.join(getAttachmentsDir(), filename);
	atomicWriteBuffer(target, buf);
	return target;
}

function atomicWriteBuffer(target: string, buf: Buffer): void {
	const dir = path.dirname(target);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	const tmp = path.join(dir, '.' + path.basename(target) + '.' + process.pid + '.' + Date.now() + '.tmp');
	fs.writeFileSync(tmp, buf);
	fs.renameSync(tmp, target);
}

export function atomicWriteFile(target: string, contents: string): void {
	const dir = path.dirname(target);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	const tmp = path.join(dir, '.' + path.basename(target) + '.' + process.pid + '.' + Date.now() + '.tmp');
	fs.writeFileSync(tmp, contents);
	fs.renameSync(tmp, target);
}

function readSettings(): any {
	if (!fs.existsSync(SETTINGS_FILE)) { return {}; }
	try {
		return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	} catch (_) {
		return {};
	}
}

function writeSettings(settings: any): void {
	if (!fs.existsSync(CLAUDE_DIR)) { fs.mkdirSync(CLAUDE_DIR, { recursive: true }); }
	atomicWriteFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function refreshStableHookScript(extensionPath: string): boolean {
	const src = path.join(extensionPath, 'assets', 'stop-hook.js');
	if (!fs.existsSync(src)) { throw new Error('Bundled hook script missing at ' + src); }
	if (!fs.existsSync(CLAUDE_DIR)) { fs.mkdirSync(CLAUDE_DIR, { recursive: true }); }
	const newContents = fs.readFileSync(src, 'utf8');
	let existing = '';
	try {
		if (fs.existsSync(STABLE_HOOK_PATH)) {
			existing = fs.readFileSync(STABLE_HOOK_PATH, 'utf8');
		}
	} catch (_) { /* fall through */ }
	if (existing === newContents) { return false; }
	atomicWriteFile(STABLE_HOOK_PATH, newContents);
	try { fs.chmodSync(STABLE_HOOK_PATH, 0o755); } catch (_) { /* non-fatal */ }
	return true;
}

export function isHookInstalled(): boolean {
	const settings = readSettings();
	const stopHooks = settings?.hooks?.Stop;
	if (!Array.isArray(stopHooks)) { return false; }
	return stopHooks.some((h: any) => JSON.stringify(h).includes(HOOK_MARKER));
}

export function installHook(extensionPath: string): { installed: boolean; settingsFile: string; hookScript: string } {
	refreshStableHookScript(extensionPath);
	const settings = readSettings();
	if (!settings.hooks) { settings.hooks = {}; }
	if (!Array.isArray(settings.hooks.Stop)) { settings.hooks.Stop = []; }
	settings.hooks.Stop = settings.hooks.Stop.filter(
		(h: any) => !JSON.stringify(h).includes(HOOK_MARKER)
	);
	const command = `/usr/bin/env node "${STABLE_HOOK_PATH}" # ${HOOK_MARKER}`;
	settings.hooks.Stop.push({
		matcher: '',
		hooks: [{ type: 'command', command }]
	});
	writeSettings(settings);
	return { installed: true, settingsFile: SETTINGS_FILE, hookScript: STABLE_HOOK_PATH };
}

export function uninstallHook(): { uninstalled: boolean } {
	const settings = readSettings();
	if (!Array.isArray(settings?.hooks?.Stop)) { return { uninstalled: false }; }
	const before = settings.hooks.Stop.length;
	settings.hooks.Stop = settings.hooks.Stop.filter(
		(h: any) => !JSON.stringify(h).includes(HOOK_MARKER)
	);
	const removed = settings.hooks.Stop.length !== before;
	writeSettings(settings);
	return { uninstalled: removed };
}

/**
 * Loads the queue and drops any malformed entries instead of returning a
 * crashy mix. A queue item is valid only if it has a non-empty string `id`
 * and a string `text`. `createdAt` is repaired to Date.now() if missing or
 * non-numeric.
 *
 * Why: hand-edits or partial file corruption can leave entries with
 * undefined fields, and the webview crashes when it tries to render a row
 * for an item without an id (the `onclick="steerItem('undefined')"` call
 * looks valid but produces a no-op + console error).
 */
export function loadQueueFromFile(queueFile: string): QueueItem[] {
	if (!fs.existsSync(queueFile)) { return []; }
	let parsed: any;
	try {
		parsed = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
	} catch (_) {
		return [];
	}
	if (!Array.isArray(parsed)) { return []; }
	const validated: QueueItem[] = [];
	for (const raw of parsed) {
		if (!raw || typeof raw !== 'object') { continue; }
		const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
		const text = typeof raw.text === 'string' ? raw.text : null;
		if (!id || text === null) { continue; }
		const createdAt = typeof raw.createdAt === 'number' && isFinite(raw.createdAt) ? raw.createdAt : Date.now();
		const attachments = Array.isArray(raw.attachments) ? raw.attachments.filter((a: any) => typeof a === 'string') : undefined;
		const item: QueueItem = { id, text, createdAt };
		if (attachments && attachments.length) { item.attachments = attachments; }
		validated.push(item);
	}
	return validated;
}

export function saveQueueToFile(queueFile: string, queue: QueueItem[]): void {
	atomicWriteFile(queueFile, JSON.stringify(queue, null, 2));
}

export function loadHistoryFromFile(historyFile: string): HistoryEntry[] {
	if (!fs.existsSync(historyFile)) { return []; }
	try {
		const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
		if (Array.isArray(parsed)) { return parsed; }
	} catch (_) { /* fall through */ }
	return [];
}

export function loadNativeStatus(statusFile: string): NativeStatus | null {
	if (!fs.existsSync(statusFile)) { return null; }
	try {
		const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
		if (parsed && typeof parsed.at === 'number') { return parsed as NativeStatus; }
	} catch (_) { /* fall through */ }
	return null;
}

/**
 * One-time migration: if the legacy global queue/history files from v0.2.7
 * exist, merge their contents into the current workspace's per-workspace
 * files and rename the legacy files so we never migrate twice.
 *
 * Returns the number of items migrated (0 if no migration happened).
 */
export function migrateLegacyGlobalQueue(currentWorkspace: string): { itemsMigrated: number; historyMigrated: number } {
	let itemsMigrated = 0;
	let historyMigrated = 0;
	const paths = getPathsForWorkspace(currentWorkspace);

	if (fs.existsSync(LEGACY_QUEUE_FILE)) {
		try {
			const legacy = JSON.parse(fs.readFileSync(LEGACY_QUEUE_FILE, 'utf8'));
			if (Array.isArray(legacy) && legacy.length > 0) {
				const existing = loadQueueFromFile(paths.queueFile);
				saveQueueToFile(paths.queueFile, [...existing, ...legacy]);
				itemsMigrated = legacy.length;
			}
		} catch (_) { /* corrupt → ignore */ }
		try { fs.renameSync(LEGACY_QUEUE_FILE, LEGACY_QUEUE_FILE + '.migrated'); } catch (_) { /* noop */ }
	}

	if (fs.existsSync(LEGACY_HISTORY_FILE)) {
		try {
			const legacy = JSON.parse(fs.readFileSync(LEGACY_HISTORY_FILE, 'utf8'));
			if (Array.isArray(legacy) && legacy.length > 0) {
				const existing = loadHistoryFromFile(paths.historyFile);
				atomicWriteFile(paths.historyFile, JSON.stringify([...existing, ...legacy].slice(-50), null, 2));
				historyMigrated = legacy.length;
			}
		} catch (_) { /* corrupt → ignore */ }
		try { fs.renameSync(LEGACY_HISTORY_FILE, LEGACY_HISTORY_FILE + '.migrated'); } catch (_) { /* noop */ }
	}

	if (fs.existsSync(LEGACY_NATIVE_STATUS_FILE)) {
		try { fs.renameSync(LEGACY_NATIVE_STATUS_FILE, LEGACY_NATIVE_STATUS_FILE + '.migrated'); } catch (_) { /* noop */ }
	}

	return { itemsMigrated, historyMigrated };
}
