#!/usr/bin/env node
/*
 * Claude Mod by NexaLance — UserPromptSubmit hook for Claude Code.
 *
 * Fires every time a user prompt is submitted (either by a human typing in
 * Claude's chat or by our extension's osascript kick typing it in). All it
 * does is record the timestamp to a per-workspace state file so the
 * extension's watchdog can tell the difference between:
 *
 *   - Claude is currently processing a turn (LASTSUB > LASTSTOP)
 *   - Claude finished and is waiting for the next prompt (LASTSTOP > LASTSUB)
 *
 * Without this hook, the watchdog only sees Stop events, and there's no
 * signal between the moment a prompt is submitted and the Stop event that
 * fires when Claude finishes processing it. That gap is what made earlier
 * versions fire a second kick mid-turn.
 *
 * No content is recorded — only timestamp + prompt length — to keep the
 * state file small and avoid leaking user prompts to disk in any non-
 * obvious place.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const WORKSPACES_ROOT = path.join(CLAUDE_DIR, 'claude-mod-queues');

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

function atomicWrite(target, contents) {
	const dir = path.dirname(target);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	const tmp = path.join(dir, '.' + path.basename(target) + '.' + process.pid + '.' + Date.now() + '.tmp');
	fs.writeFileSync(tmp, contents);
	fs.renameSync(tmp, target);
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinBuf += chunk; });
process.stdin.on('end', () => {
	let event = {};
	try { event = JSON.parse(stdinBuf || '{}'); } catch (_) { /* tolerate non-JSON */ }

	const cwd = (event && typeof event.cwd === 'string' && event.cwd)
		|| process.cwd()
		|| '__no-workspace__';
	const wsDir = path.join(WORKSPACES_ROOT, workspaceSafeName(cwd));

	const promptLength = typeof event.prompt === 'string' ? event.prompt.length : 0;
	const data = JSON.stringify({
		submittedAt: Date.now(),
		promptLength: promptLength
	}, null, 2);

	try {
		atomicWrite(path.join(wsDir, 'user-submit.json'), data);
	} catch (err) {
		process.stderr.write('[claude-mod user-submit-hook] write failed: ' + err.message + '\n');
	}

	// Always allow the user prompt to proceed normally — we never modify it.
	process.stdout.write('{}');
});
