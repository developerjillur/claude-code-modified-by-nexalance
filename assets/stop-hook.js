#!/usr/bin/env node
/*
 * Claude Mod by NexaLance — Stop hook for Claude Code.
 *
 * v0.2.8 — per-workspace queues. The stop event JSON includes the working
 * directory of the active Claude session (`cwd`). We derive the workspace
 * data directory from that path and read/write the per-workspace
 * queue / history / native-status files there. That way each project keeps
 * its own queue, so a queued prompt for project A never fires when the user
 * is working on project B.
 *
 * Two delivery strategies, in order:
 *
 *   1. NATIVE (preferred): spawn osascript synchronously to activate VS
 *      Code, focus Anthropic's chat input via ⌘ Esc, paste the prompt, and
 *      press Return. The prompt appears in Claude's chat as a real user
 *      message.
 *
 *   2. FEEDBACK (fallback): if osascript fails (no Accessibility permission,
 *      osascript not on PATH, VS Code not running, etc.), return the prompt
 *      via the standard Claude Code Stop-hook decision
 *      `{decision:"block", reason:<prompt>}`. Claude continues with the
 *      reason as its next instruction.
 *
 * Loop protection: respects `stop_hook_active` from the incoming event.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const WORKSPACES_ROOT = path.join(CLAUDE_DIR, 'claude-mod-queues');
const MAX_HISTORY = 50;

// IMPORTANT: this canonicalization must stay in sync with the same function
// in src/hook-setup.ts. The extension and the hook BOTH compute the per-
// workspace dir name from the same input; if their canonicalizations differ
// (trailing slash, symlink resolution, relative components), they end up
// reading and writing different files and never see each other's queue.
function canonicalizeWorkspacePath(workspacePath) {
	if (!workspacePath || workspacePath === '__no-workspace__') {
		return '__no-workspace__';
	}
	const resolved = path.resolve(workspacePath);
	try {
		return fs.realpathSync(resolved);
	} catch (_) {
		return resolved;
	}
}

function workspaceSafeName(workspacePath) {
	const canon = canonicalizeWorkspacePath(workspacePath);
	const baseRaw = path.basename(canon) || 'workspace';
	const safe = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'workspace';
	const hash = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8);
	return safe + '-' + hash;
}

function pathsForWorkspace(workspacePath) {
	const dir = path.join(WORKSPACES_ROOT, workspaceSafeName(workspacePath));
	return {
		dir: dir,
		queueFile: path.join(dir, 'queue.json'),
		historyFile: path.join(dir, 'history.json'),
		nativeStatusFile: path.join(dir, 'native-status.json')
	};
}

function atomicWrite(target, contents) {
	const dir = path.dirname(target);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	const tmp = path.join(dir, '.' + path.basename(target) + '.' + process.pid + '.' + Date.now() + '.tmp');
	fs.writeFileSync(tmp, contents);
	fs.renameSync(tmp, target);
}

function appendHistory(historyFile, text) {
	let entries = [];
	if (fs.existsSync(historyFile)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
			if (Array.isArray(parsed)) { entries = parsed; }
		} catch (_) { /* corrupt → start fresh */ }
	}
	// source:'hook' marks this as a real Claude-Code Stop event (Claude
	// finished a turn). The extension uses this to distinguish hook fires
	// from its own watchdog kicks when deciding whether to fire another
	// watchdog kick. Without this tag, the watchdog couldn't tell that an
	// extension-side kick was still being processed by Claude and would
	// fire again 30s later, mid-turn.
	entries.push({ text: text, firedAt: Date.now(), source: 'hook' });
	if (entries.length > MAX_HISTORY) { entries = entries.slice(-MAX_HISTORY); }
	try { atomicWrite(historyFile, JSON.stringify(entries, null, 2)); }
	catch (err) { process.stderr.write('[claude-mod stop-hook] history write failed: ' + err.message + '\n'); }
}

function tryNativeSubmit(text, nativeStatusFile) {
	if (process.platform !== 'darwin') { return false; }
	if (process.env.CLAUDE_MOD_DISABLE_NATIVE === '1') { return false; }

	const tmp = path.join(os.tmpdir(), 'claude-mod-hook-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.txt');
	try { fs.writeFileSync(tmp, text); }
	catch (_) { return false; }

	const escapedPath = tmp.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const script = `
		try
			set kickFile to POSIX file "${escapedPath}"
			set kickContents to (read kickFile as «class utf8»)
			set the clipboard to kickContents
			tell application "Visual Studio Code" to activate
			delay 0.25
			tell application "System Events"
				keystroke (ASCII character 27) using {command down}
				delay 0.18
				keystroke "v" using {command down}
				delay 0.18
				key code 36
			end tell
			return "ok"
		on error errMsg number errNum
			return "ERR " & errNum & ": " & errMsg
		end try
	`;

	try {
		const stdout = cp.execFileSync('osascript', ['-e', script], {
			encoding: 'utf8',
			timeout: 2000
		});
		return typeof stdout === 'string' && stdout.trim() === 'ok';
	} catch (err) {
		const msg = (err && err.message || String(err)).toString();
		process.stderr.write('[claude-mod stop-hook] osascript failed: ' + msg + '\n');
		try {
			atomicWrite(nativeStatusFile, JSON.stringify({
				ok: false, lastError: msg, timedOut: msg.indexOf('ETIMEDOUT') >= 0, at: Date.now()
			}, null, 2));
		} catch (_) { /* noop */ }
		return false;
	} finally {
		try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
	}
}

// SAFETY: hard cap on how many consecutive block+reason fires we'll do
// before we let Claude actually stop and wait for fresh user input. This
// matters only if osascript native submit is not working — when native
// submit succeeds, each fire is a separate user turn with no
// stop_hook_active flag carrying over. When we have to fall back to
// decision:block, every subsequent Stop event in the same chain has
// stop_hook_active=true; that's fine for us (queue is bounded), but if
// the user has queued thousands of items we don't want one chain to
// monopolise Claude for hours. 200 is plenty for normal use.
const MAX_CONSECUTIVE_BLOCK_FIRES = 200;

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinBuf += chunk; });
process.stdin.on('end', () => {
	let event = {};
	try { event = JSON.parse(stdinBuf || '{}'); } catch (_) { /* tolerate non-JSON */ }

	// NOTE: v0.2.12 — we deliberately do NOT bail when stop_hook_active is
	// true. Earlier versions did, but that meant the queue only drained one
	// item per Claude continuation chain — every subsequent Stop event in
	// the same chain returned {} immediately and the remaining queue sat.
	// Our hook is safe to fire repeatedly because it drains (shifts) the
	// queue every time; the queue is naturally bounded, so no infinite-loop
	// risk. The MAX_CONSECUTIVE_BLOCK_FIRES cap above is the only safety.

	// Pick the workspace from the event. `cwd` is set by Claude Code to the
	// session's working directory. Fall back to our own process cwd if for
	// some reason the event lacks it.
	const workspacePath = (event && typeof event.cwd === 'string' && event.cwd)
		|| process.cwd()
		|| '__no-workspace__';
	const p = pathsForWorkspace(workspacePath);

	let queue = [];
	if (fs.existsSync(p.queueFile)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(p.queueFile, 'utf8'));
			if (Array.isArray(parsed)) { queue = parsed; }
		} catch (_) { queue = []; }
	}

	if (queue.length === 0) {
		process.stdout.write(JSON.stringify({}));
		return;
	}

	const first = queue.shift();
	const text = first && typeof first === 'object' && typeof first.text === 'string'
		? first.text
		: typeof first === 'string' ? first : '';

	try {
		atomicWrite(p.queueFile, JSON.stringify(queue, null, 2));
	} catch (err) {
		process.stderr.write('[claude-mod stop-hook] could not write queue file: ' + err.message + '\n');
		process.stdout.write(JSON.stringify({}));
		return;
	}

	if (!text || !text.trim()) {
		process.stdout.write(JSON.stringify({}));
		return;
	}

	appendHistory(p.historyFile, text);

	if (tryNativeSubmit(text, p.nativeStatusFile)) {
		try {
			atomicWrite(p.nativeStatusFile, JSON.stringify({ ok: true, at: Date.now() }, null, 2));
		} catch (_) { /* noop */ }
		process.stdout.write(JSON.stringify({}));
		return;
	}

	// Feedback fallback. Before emitting the decision:block, check how many
	// consecutive block-fires we've done in this chain — if we're past the
	// safety cap, let Claude stop instead.
	const chainFile = path.join(p.dir, 'block-chain.json');
	let chain = { count: 0, at: 0 };
	if (fs.existsSync(chainFile)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
			if (parsed && typeof parsed.count === 'number') { chain = parsed; }
		} catch (_) { /* fall through */ }
	}
	// Reset the counter if the previous block was more than 5 minutes ago
	// — that almost certainly means a fresh user-initiated turn, not a
	// continuation of the same chain.
	if (Date.now() - (chain.at || 0) > 5 * 60 * 1000) { chain.count = 0; }
	chain.count = (chain.count || 0) + 1;
	chain.at = Date.now();
	try { atomicWrite(chainFile, JSON.stringify(chain, null, 2)); } catch (_) { /* noop */ }

	if (chain.count > MAX_CONSECUTIVE_BLOCK_FIRES) {
		process.stderr.write('[claude-mod stop-hook] hit MAX_CONSECUTIVE_BLOCK_FIRES, letting Claude stop\n');
		process.stdout.write(JSON.stringify({}));
		return;
	}

	process.stdout.write(JSON.stringify({
		decision: 'block',
		reason: text
	}));
});
