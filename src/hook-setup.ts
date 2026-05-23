import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HOOK_MARKER = 'claude-mod-stop-hook';
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const QUEUE_FILE = path.join(CLAUDE_DIR, 'claude-mod-queue.json');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'claude-mod-history.json');
// The hook script is COPIED here on install so the settings.json reference
// survives extension updates / version bumps / reinstalls. Without this, the
// reference would point at the versioned extension folder, which gets
// recreated under a different name every time we publish a new VSIX.
const STABLE_HOOK_PATH = path.join(CLAUDE_DIR, 'claude-mod-hook.js');
// Pasted images and picked files attached to queue prompts are written here.
// Claude can read these via its Read tool when the hook fires the prompt.
const ATTACHMENTS_DIR = path.join(CLAUDE_DIR, 'claude-mod-attachments');
// The hook writes a one-line status breadcrumb here every time native
// submit either succeeds or fails, so the extension can show a setup
// prompt when Accessibility / Automation permission is missing.
const NATIVE_STATUS_FILE = path.join(CLAUDE_DIR, 'claude-mod-native-status.json');

export interface NativeStatus {
	ok: boolean;
	lastError?: string;
	timedOut?: boolean;
	at: number;
}

export function getNativeStatusFile(): string { return NATIVE_STATUS_FILE; }

export function loadNativeStatus(): NativeStatus | null {
	if (!fs.existsSync(NATIVE_STATUS_FILE)) { return null; }
	try {
		const parsed = JSON.parse(fs.readFileSync(NATIVE_STATUS_FILE, 'utf8'));
		if (parsed && typeof parsed.at === 'number') { return parsed as NativeStatus; }
	} catch (_) { /* fall through */ }
	return null;
}

export function getAttachmentsDir(): string {
	if (!fs.existsSync(ATTACHMENTS_DIR)) {
		fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
	}
	return ATTACHMENTS_DIR;
}

const MIME_TO_EXT: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
	'image/bmp': 'bmp'
};

/**
 * Save a base64 image (from a clipboard paste) to the attachments directory.
 * Returns the absolute file path that was written.
 */
export function saveBase64Image(base64Data: string, mimeType: string): string {
	const ext = MIME_TO_EXT[mimeType.toLowerCase()] || 'png';
	const filename = 'paste-' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.' + ext;
	const target = path.join(getAttachmentsDir(), filename);
	const buf = Buffer.from(base64Data, 'base64');
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

export interface HookStatus {
	hookInstalled: boolean;
	queueFile: string;
	historyFile: string;
	hookScript: string;
	settingsFile: string;
	nativeStatusFile: string;
}

export function getPaths(): Omit<HookStatus, 'hookInstalled'> {
	return {
		queueFile: QUEUE_FILE,
		historyFile: HISTORY_FILE,
		hookScript: STABLE_HOOK_PATH,
		settingsFile: SETTINGS_FILE,
		nativeStatusFile: NATIVE_STATUS_FILE
	};
}

function ensureClaudeDir(): void {
	if (!fs.existsSync(CLAUDE_DIR)) {
		fs.mkdirSync(CLAUDE_DIR, { recursive: true });
	}
}

/**
 * Atomic file write: write to a temp file in the same directory, then rename
 * over the target. Rename is atomic on POSIX filesystems, so the target file
 * is never observed in a half-written state.
 */
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
	ensureClaudeDir();
	atomicWriteFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/**
 * Copy the hook script from the extension's bundled assets/ into the stable
 * location at ~/.claude/claude-mod-hook.js. Returns true if the script on disk
 * changed (so the caller can decide whether to log "hook updated").
 */
export function refreshStableHookScript(extensionPath: string): boolean {
	const src = path.join(extensionPath, 'assets', 'stop-hook.js');
	if (!fs.existsSync(src)) {
		throw new Error('Bundled hook script missing at ' + src);
	}
	ensureClaudeDir();
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

export function installHook(extensionPath: string): HookStatus {
	refreshStableHookScript(extensionPath);

	const settings = readSettings();
	if (!settings.hooks) { settings.hooks = {}; }
	if (!Array.isArray(settings.hooks.Stop)) { settings.hooks.Stop = []; }

	// Idempotency: strip any prior version of our hook (regardless of path).
	settings.hooks.Stop = settings.hooks.Stop.filter(
		(h: any) => !JSON.stringify(h).includes(HOOK_MARKER)
	);

	// The command uses `/usr/bin/env node` so it works whether the user's
	// node is the system one, nvm-managed, asdf-managed, etc. The marker
	// comment at the end keeps this entry identifiable for uninstall.
	const command = `/usr/bin/env node "${STABLE_HOOK_PATH}" # ${HOOK_MARKER}`;
	settings.hooks.Stop.push({
		matcher: '',
		hooks: [{ type: 'command', command }]
	});

	writeSettings(settings);

	// Make sure the queue file exists so the hook never sees a missing path.
	if (!fs.existsSync(QUEUE_FILE)) {
		atomicWriteFile(QUEUE_FILE, '[]');
	}

	return {
		hookInstalled: true,
		queueFile: QUEUE_FILE,
		historyFile: HISTORY_FILE,
		hookScript: STABLE_HOOK_PATH,
		settingsFile: SETTINGS_FILE,
		nativeStatusFile: NATIVE_STATUS_FILE
	};
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

export interface QueueItem { id: string; text: string; createdAt: number; }

export function loadQueueFromFile(): QueueItem[] {
	if (!fs.existsSync(QUEUE_FILE)) { return []; }
	try {
		const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
		if (Array.isArray(parsed)) { return parsed; }
	} catch (_) { /* fall through */ }
	return [];
}

export function saveQueueToFile(queue: QueueItem[]): void {
	atomicWriteFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

export interface HistoryEntry { text: string; firedAt: number; }

export function loadHistoryFromFile(): HistoryEntry[] {
	if (!fs.existsSync(HISTORY_FILE)) { return []; }
	try {
		const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
		if (Array.isArray(parsed)) { return parsed; }
	} catch (_) { /* fall through */ }
	return [];
}
