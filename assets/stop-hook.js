#!/usr/bin/env node
/*
 * Claude Mod by NexaLance — Stop hook for Claude Code.
 *
 * Runs every time Claude Code finishes a turn ("Stop"). Reads the next
 * pending prompt from the queue file written by the Claude Mod extension
 * and feeds it into Claude.
 *
 * Two delivery strategies, in order:
 *
 *   1. NATIVE (preferred):  spawn osascript synchronously to activate VS
 *      Code, focus Anthropic's chat input via ⌘ Esc, paste the prompt, and
 *      press Return. The prompt appears in Claude's chat as a real user
 *      message — same look as if the user had typed it.
 *
 *   2. FEEDBACK (fallback): if osascript fails (no Accessibility permission,
 *      osascript not on PATH, VS Code not running, etc.), return the prompt
 *      via the standard Claude Code Stop-hook decision `{decision:"block",
 *      reason:<prompt>}`. Claude continues with the reason as its next
 *      instruction, but the chat displays it under the "Stop hook feedback:"
 *      label instead of as a fresh user message.
 *
 * Either way the queue advances and the prompt reaches Claude. The native
 * path is the prettier outcome but isn't always reachable, so a guaranteed
 * fallback is always in play.
 *
 * Loop protection: respects `stop_hook_active` from the incoming event so
 * we never trigger ourselves recursively.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const QUEUE_FILE = path.join(CLAUDE_DIR, 'claude-mod-queue.json');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'claude-mod-history.json');
const MAX_HISTORY = 50;

function atomicWrite(target, contents) {
	const dir = path.dirname(target);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	const tmp = path.join(dir, '.' + path.basename(target) + '.' + process.pid + '.' + Date.now() + '.tmp');
	fs.writeFileSync(tmp, contents);
	fs.renameSync(tmp, target);
}

function appendHistory(text) {
	let entries = [];
	if (fs.existsSync(HISTORY_FILE)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
			if (Array.isArray(parsed)) { entries = parsed; }
		} catch (_) { /* corrupt → start fresh */ }
	}
	entries.push({ text: text, firedAt: Date.now() });
	if (entries.length > MAX_HISTORY) { entries = entries.slice(-MAX_HISTORY); }
	try {
		atomicWrite(HISTORY_FILE, JSON.stringify(entries, null, 2));
	} catch (err) {
		process.stderr.write('[claude-mod stop-hook] history write failed: ' + err.message + '\n');
	}
}

/**
 * Try to type the prompt into Claude's chat as a real user message via
 * macOS scripting. Returns true on success, false on any failure.
 *
 * Bypassable: set CLAUDE_MOD_DISABLE_NATIVE=1 in the environment to force
 * the feedback fallback (useful for headless / CI / debugging).
 */
function tryNativeSubmit(text) {
	if (process.platform !== 'darwin') { return false; }
	if (process.env.CLAUDE_MOD_DISABLE_NATIVE === '1') { return false; }

	const tmp = path.join(os.tmpdir(), 'claude-mod-hook-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.txt');
	try {
		fs.writeFileSync(tmp, text);
	} catch (_) {
		return false;
	}

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
			timeout: 6000
		});
		return typeof stdout === 'string' && stdout.trim() === 'ok';
	} catch (err) {
		process.stderr.write('[claude-mod stop-hook] osascript failed: ' + (err && err.message || err) + '\n');
		return false;
	} finally {
		try { fs.unlinkSync(tmp); } catch (_) { /* noop */ }
	}
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinBuf += chunk; });
process.stdin.on('end', () => {
	let event = {};
	try { event = JSON.parse(stdinBuf || '{}'); } catch (_) { /* tolerate non-JSON */ }

	if (event && event.stop_hook_active) {
		process.stdout.write(JSON.stringify({}));
		return;
	}

	let queue = [];
	if (fs.existsSync(QUEUE_FILE)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
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
		atomicWrite(QUEUE_FILE, JSON.stringify(queue, null, 2));
	} catch (err) {
		process.stderr.write('[claude-mod stop-hook] could not write queue file: ' + err.message + '\n');
		process.stdout.write(JSON.stringify({}));
		return;
	}

	if (!text || !text.trim()) {
		process.stdout.write(JSON.stringify({}));
		return;
	}

	appendHistory(text);

	// Preferred: native user-message look via osascript.
	if (tryNativeSubmit(text)) {
		process.stdout.write(JSON.stringify({}));
		return;
	}

	// Fallback: Stop-hook feedback (shows the "Stop hook feedback:" prefix
	// in Claude's chat but still gets the prompt into Claude's context).
	process.stdout.write(JSON.stringify({
		decision: 'block',
		reason: text
	}));
});
