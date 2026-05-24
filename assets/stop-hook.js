#!/usr/bin/env node
/*
 * Claude Mod by NexaLance — Stop hook for Claude Code.
 *
 * v0.3.0 — Feedback-only flow. The one design that always worked.
 *
 * Runs every time Claude Code finishes a turn ("Stop"). Reads the next
 * pending prompt from the per-workspace queue file. If there's an item:
 *   - remove it from the queue file (atomically)
 *   - append a record to the history file (source: 'hook')
 *   - return {"decision":"block","reason":<prompt>} so Claude Code does
 *     NOT stop and instead continues with the queued prompt as its next
 *     instruction
 *
 * If the queue is empty, return {} (Claude stops normally).
 *
 * No osascript, no native typing into Claude's chat input, no
 * UserPromptSubmit-hook bookkeeping, no env-var toggles. Just the
 * reliable decision-block-reason flow that delivers each prompt INSIDE
 * Claude Code's own process. The "Stop hook feedback:" label Claude
 * Code displays is cosmetic — the prompt itself is fully processed.
 *
 * Workspace resolution: derived from the Stop event's `cwd` field,
 * canonicalized via path.resolve + fs.realpathSync so trailing slashes
 * and symlinks all hash to the same per-workspace dir.
 *
 * Loop protection: respects `stop_hook_active` from the incoming event
 * AND tracks a per-workspace block-chain counter (capped at 200 fires
 * in a 5-minute window) as a safety against truly pathological cases.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const WORKSPACES_ROOT = path.join(CLAUDE_DIR, 'claude-mod-queues');
const MAX_HISTORY = 50;
const MAX_CONSECUTIVE_BLOCK_FIRES = 200;
const CHAIN_RESET_AFTER_MS = 5 * 60 * 1000;

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
		chainFile: path.join(dir, 'block-chain.json')
	};
}

/**
 * v0.3.1 — Monorepo / subfolder support.
 *
 * The Claude Code Stop event's `cwd` is often a SUBFOLDER (e.g. a
 * `frontend/` package inside a monorepo) — not the VS Code workspace
 * root the sidebar uses. So this hook walks UP the directory tree from
 * `cwd`, checking each parent's workspace dir for an existing queue.json
 * with at least one item. The first match wins.
 *
 * Falls back to the exact cwd's workspace dir (even if queue is empty or
 * missing) if no parent has a populated queue — so first-write behavior
 * is unchanged when the user IS at the workspace root.
 */
function findActiveWorkspaceFor(cwd) {
	const canonStart = canonicalizeWorkspacePath(cwd);
	if (canonStart === '__no-workspace__') { return pathsForWorkspace(canonStart); }
	let current = canonStart;
	const MAX_WALK = 12; // generous; avoids walking to '/' on absurd nesting
	for (let i = 0; i < MAX_WALK; i++) {
		const candidate = pathsForWorkspace(current);
		if (fs.existsSync(candidate.queueFile)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(candidate.queueFile, 'utf8'));
				if (Array.isArray(parsed) && parsed.length > 0) {
					return candidate;
				}
			} catch (_) { /* corrupt — keep walking */ }
		}
		const parent = path.dirname(current);
		if (!parent || parent === current || parent === '/') { break; }
		current = parent;
	}
	// No ancestor with a populated queue. Use the exact cwd's dir so that
	// future drains / history writes still go to the canonical place.
	return pathsForWorkspace(canonStart);
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
	entries.push({ text: text, firedAt: Date.now(), source: 'hook' });
	if (entries.length > MAX_HISTORY) { entries = entries.slice(-MAX_HISTORY); }
	try { atomicWrite(historyFile, JSON.stringify(entries, null, 2)); }
	catch (err) { process.stderr.write('[claude-mod stop-hook] history write failed: ' + err.message + '\n'); }
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinBuf += chunk; });
process.stdin.on('end', () => {
	let event = {};
	try { event = JSON.parse(stdinBuf || '{}'); } catch (_) { /* tolerate non-JSON */ }

	// `cwd` is set by Claude Code to the session's working directory.
	// Fall back to our own process cwd if missing.
	const workspacePath = (event && typeof event.cwd === 'string' && event.cwd)
		|| process.cwd()
		|| '__no-workspace__';
	// v0.3.1 — walk parent directories from cwd to find the active queue.
	// Handles the monorepo case where Claude Code's cwd is a subfolder
	// (e.g. `<repo>/frontend`) but the sidebar saved the queue under the
	// workspace root (`<repo>`).
	const p = findActiveWorkspaceFor(workspacePath);

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

	// Track consecutive block-fires in this chain. A real Claude Code
	// continuation chain typically drains a few items in sequence; this
	// counter guards against truly pathological multi-hundred-item cases.
	// Reset if the last fire was > CHAIN_RESET_AFTER_MS ago (means the
	// chain naturally ended and this is a fresh user-initiated turn).
	let chain = { count: 0, at: 0 };
	if (fs.existsSync(p.chainFile)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(p.chainFile, 'utf8'));
			if (parsed && typeof parsed.count === 'number') { chain = parsed; }
		} catch (_) { /* fall through */ }
	}
	if (Date.now() - (chain.at || 0) > CHAIN_RESET_AFTER_MS) { chain.count = 0; }
	chain.count = (chain.count || 0) + 1;
	chain.at = Date.now();
	try { atomicWrite(p.chainFile, JSON.stringify(chain, null, 2)); } catch (_) { /* noop */ }

	if (chain.count > MAX_CONSECUTIVE_BLOCK_FIRES) {
		process.stderr.write('[claude-mod stop-hook] hit MAX_CONSECUTIVE_BLOCK_FIRES, letting Claude stop\n');
		process.stdout.write(JSON.stringify({}));
		return;
	}

	// Feedback path — the reliable one. Claude continues with the reason.
	process.stdout.write(JSON.stringify({
		decision: 'block',
		reason: text
	}));
});
