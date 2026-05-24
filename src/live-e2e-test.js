// Live end-to-end test of the INSTALLED hooks at ~/.claude/
// (not the bundled-in-repo copies). Exercises full sequences of queue
// adds, hook fires, and verifies drainage, source-tagging, workspace
// isolation, and the v0.2.16 race fix.
//
// SAFETY: we set CLAUDE_MOD_DISABLE_NATIVE=1 so the hook never spawns
// osascript and never types into the developer's session. Native osascript
// is integration-tested only via the extension's webview Probe button in VS Code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const STABLE_STOP_HOOK   = path.join(os.homedir(), '.claude', 'claude-mod-hook.js');
const STABLE_SUBMIT_HOOK = path.join(os.homedir(), '.claude', 'claude-mod-user-submit-hook.js');
const SETTINGS_FILE      = path.join(os.homedir(), '.claude', 'settings.json');
const WORKSPACES_ROOT    = path.join(os.homedir(), '.claude', 'claude-mod-queues');

function workspaceSafeName(p) {
	if (!p || p === '__no-workspace__') {
		const h = crypto.createHash('sha1').update('__no-workspace__').digest('hex').slice(0, 8);
		return 'workspace-' + h;
	}
	let canon = path.resolve(p);
	try { canon = fs.realpathSync(canon); } catch (_) {}
	const base = path.basename(canon) || 'workspace';
	const safe = base.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'workspace';
	const hash = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8);
	return safe + '-' + hash;
}
const wsDir       = (p) => path.join(WORKSPACES_ROOT, workspaceSafeName(p));
const queuePath   = (p) => path.join(wsDir(p), 'queue.json');
const historyPath = (p) => path.join(wsDir(p), 'history.json');
const submitPath  = (p) => path.join(wsDir(p), 'user-submit.json');
const chainPath   = (p) => path.join(wsDir(p), 'block-chain.json');

function runStopHook(eventJson) {
	const r = cp.spawnSync('node', [STABLE_STOP_HOOK], {
		input: JSON.stringify(eventJson),
		encoding: 'utf8',
		timeout: 8000,
		env: Object.assign({}, process.env, { CLAUDE_MOD_DISABLE_NATIVE: '1' })
	});
	return {
		stdout: r.stdout || '',
		stderr: r.stderr || '',
		status: r.status,
		parsed: (() => { try { return JSON.parse((r.stdout || '').trim()); } catch { return null; } })()
	};
}
function runSubmitHook(eventJson) {
	const r = cp.spawnSync('node', [STABLE_SUBMIT_HOOK], {
		input: JSON.stringify(eventJson),
		encoding: 'utf8',
		timeout: 5000
	});
	return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}
function writeQueue(p, items) {
	const f = queuePath(p);
	const dir = path.dirname(f);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	fs.writeFileSync(f, JSON.stringify(items, null, 2));
}
function readQueue(p) {
	const f = queuePath(p);
	if (!fs.existsSync(f)) return null;
	try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function readHistory(p) {
	const f = historyPath(p);
	if (!fs.existsSync(f)) return null;
	try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function readSubmit(p) {
	const f = submitPath(p);
	if (!fs.existsSync(f)) return null;
	try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function nukeWorkspaceDir(p) {
	const d = wsDir(p);
	if (!fs.existsSync(d)) return;
	for (const name of fs.readdirSync(d)) {
		try { fs.unlinkSync(path.join(d, name)); } catch {}
	}
	try { fs.rmdirSync(d); } catch {}
}

const RESULTS = [];
function group(label) { console.log('\n=== ' + label + ' ==='); RESULTS.push({ group: label }); }
function assert(cond, label) {
	const mark = cond ? '✓' : '✗ FAIL:';
	console.log('  ' + mark + ' ' + label);
	RESULTS.push({ ok: !!cond, label });
}

// =====================================================
// Build a clean test workspace path
// =====================================================
const ws = path.join(os.tmpdir(), 'claude-mod-live-e2e-' + Date.now() + '-' + Math.floor(Math.random() * 100000));
fs.mkdirSync(ws, { recursive: true });
const wsB = path.join(os.tmpdir(), 'claude-mod-live-e2e-B-' + Date.now() + '-' + Math.floor(Math.random() * 100000));
fs.mkdirSync(wsB, { recursive: true });

try {
	// =====================================================
	group('Hooks exist at stable paths');
	// =====================================================
	assert(fs.existsSync(STABLE_STOP_HOOK),   'stop hook script exists at ~/.claude/claude-mod-hook.js');
	assert(fs.existsSync(STABLE_SUBMIT_HOOK), 'user-submit hook script exists at ~/.claude/claude-mod-user-submit-hook.js');
	const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	assert(JSON.stringify(settings.hooks?.Stop || []).includes('claude-mod-stop-hook'), 'settings.json registers Stop hook');
	assert(JSON.stringify(settings.hooks?.UserPromptSubmit || []).includes('claude-mod-user-submit-hook'), 'settings.json registers UserPromptSubmit hook');

	// =====================================================
	group('Empty queue → hook allows stop');
	// =====================================================
	writeQueue(ws, []);
	const r1 = runStopHook({ cwd: ws });
	assert(r1.status === 0, 'hook exited 0');
	assert(r1.parsed && !r1.parsed.decision, 'no decision field returned');

	// =====================================================
	group('Single-item drainage (single fire)');
	// =====================================================
	nukeWorkspaceDir(ws);
	writeQueue(ws, [{ id: 'single', text: 'fire one prompt', createdAt: 1 }]);
	const r2 = runStopHook({ cwd: ws });
	assert(r2.parsed?.decision === 'block', 'decision is block');
	assert(r2.parsed?.reason === 'fire one prompt', 'reason matches');
	const q2 = readQueue(ws);
	assert(Array.isArray(q2) && q2.length === 0, 'queue is now empty');
	const h2 = readHistory(ws);
	assert(h2 && h2.length === 1, 'one history entry written');
	assert(h2[0].source === 'hook', 'history entry tagged source:hook');

	// =====================================================
	group('Multi-item drainage across separate Stop events (the user-visible scenario)');
	// =====================================================
	nukeWorkspaceDir(ws);
	const items = [
		{ id: 'm1', text: 'first auto prompt',  createdAt: 1 },
		{ id: 'm2', text: 'second auto prompt', createdAt: 2 },
		{ id: 'm3', text: 'third auto prompt',  createdAt: 3 },
		{ id: 'm4', text: 'fourth auto prompt', createdAt: 4 },
		{ id: 'm5', text: 'fifth auto prompt',  createdAt: 5 }
	];
	writeQueue(ws, items);
	let drained = [];
	for (let i = 0; i < 6; i++) {
		// First fire is a fresh Stop event (no stop_hook_active).
		// Subsequent fires DO carry stop_hook_active=true (real chain behavior).
		const event = i === 0 ? { cwd: ws } : { cwd: ws, stop_hook_active: true };
		const r = runStopHook(event);
		if (r.parsed?.decision === 'block') {
			drained.push(r.parsed.reason);
		} else {
			break; // Queue empty → hook returns {} → loop ends
		}
	}
	assert(drained.length === 5, 'drained all 5 items across consecutive fires (got ' + drained.length + ')');
	assert(drained.join('|') === items.map(i => i.text).join('|'), 'items drained in queue order');
	const histAfter = readHistory(ws) || [];
	assert(histAfter.length === 5, 'history has 5 entries after full drain');
	assert(histAfter.every(e => e.source === 'hook'), 'all history entries tagged source:hook');

	// =====================================================
	group('Workspace isolation — hook for ws B does not touch ws A queue');
	// =====================================================
	nukeWorkspaceDir(ws);
	nukeWorkspaceDir(wsB);
	writeQueue(ws,  [{ id: 'a1', text: 'A item', createdAt: 1 }]);
	writeQueue(wsB, [{ id: 'b1', text: 'B item', createdAt: 1 }]);
	const rA = runStopHook({ cwd: ws });
	assert(rA.parsed?.reason === 'A item', 'hook with cwd=A returned A item');
	assert(readQueue(ws).length === 0, 'A queue is empty');
	assert(readQueue(wsB).length === 1, 'B queue is UNTOUCHED');
	const rB = runStopHook({ cwd: wsB });
	assert(rB.parsed?.reason === 'B item', 'hook with cwd=B returned B item');
	assert(readQueue(wsB).length === 0, 'B queue is empty');

	// =====================================================
	group('Path canonicalization — trailing slash + symlink map to same dir');
	// =====================================================
	nukeWorkspaceDir(ws);
	writeQueue(ws, [{ id: 'canon', text: 'canonical test', createdAt: 1 }]);
	const linkPath = path.join(os.tmpdir(), 'claude-mod-live-link-' + Date.now());
	try { fs.symlinkSync(ws, linkPath); } catch (_) { /* skip on platforms without symlink support */ }
	if (fs.existsSync(linkPath)) {
		// Fire via the SYMLINK path; should still drain the same queue
		const rL = runStopHook({ cwd: linkPath });
		assert(rL.parsed?.reason === 'canonical test', 'hook via symlink drained same queue as target');
		try { fs.unlinkSync(linkPath); } catch (_) {}
	}
	const rT = runStopHook({ cwd: ws + '/' });
	assert(rT.parsed && !rT.parsed.decision, 'trailing-slash + already-drained → no decision (same dir)');

	// =====================================================
	group('user-prompt-submit hook records timestamp + length, no content');
	// =====================================================
	nukeWorkspaceDir(ws);
	const rS = runSubmitHook({ cwd: ws, prompt: 'hello world test' });
	assert(rS.status === 0, 'submit hook exits 0');
	assert(rS.stdout.trim() === '{}', 'submit hook outputs only {} (does not modify the prompt)');
	const sub = readSubmit(ws);
	assert(sub !== null, 'user-submit.json was created');
	assert(typeof sub.submittedAt === 'number' && sub.submittedAt > 0, 'submittedAt is a numeric timestamp');
	assert(sub.promptLength === 16, 'promptLength = 16 ("hello world test")');
	const subStr = JSON.stringify(sub);
	assert(!subStr.includes('hello'), 'no prompt text recorded (privacy ✓)');

	// =====================================================
	group('Submit-marker file is overwritten on each new prompt');
	// =====================================================
	const t1 = readSubmit(ws).submittedAt;
	// small sleep so timestamps differ
	const sleepMs = 50;
	const start = Date.now();
	while (Date.now() - start < sleepMs) { /* spin */ }
	runSubmitHook({ cwd: ws, prompt: 'second prompt' });
	const t2 = readSubmit(ws).submittedAt;
	assert(t2 > t1, 'second submit overwrote with later timestamp (' + t2 + ' > ' + t1 + ')');

	// =====================================================
	group('Malformed JSON in queue file → safe fallback, queue treated empty');
	// =====================================================
	nukeWorkspaceDir(ws);
	if (!fs.existsSync(wsDir(ws))) fs.mkdirSync(wsDir(ws), { recursive: true });
	fs.writeFileSync(queuePath(ws), '{not valid json');
	const rM = runStopHook({ cwd: ws });
	assert(rM.parsed && !rM.parsed.decision, 'malformed queue → no decision (no crash)');

	// =====================================================
	group('Consecutive-block safety cap kicks in after MAX threshold');
	// =====================================================
	nukeWorkspaceDir(ws);
	if (!fs.existsSync(wsDir(ws))) fs.mkdirSync(wsDir(ws), { recursive: true });
	writeQueue(ws, [{ id: 'cap', text: 'safety cap test', createdAt: 1 }]);
	// Force the chain counter past the 200 cap
	fs.writeFileSync(chainPath(ws), JSON.stringify({ count: 250, at: Date.now() }));
	const rCap = runStopHook({ cwd: ws, stop_hook_active: true });
	assert(rCap.parsed && !rCap.parsed.decision, 'chain counter > 200 → no decision (cap honoured)');

	// =====================================================
	group('Chain counter resets after >5 minutes of idle');
	// =====================================================
	nukeWorkspaceDir(ws);
	if (!fs.existsSync(wsDir(ws))) fs.mkdirSync(wsDir(ws), { recursive: true });
	writeQueue(ws, [{ id: 'reset', text: 'reset chain test', createdAt: 1 }]);
	// Old chain counter (just below cap) but stale by 6 minutes — should reset
	fs.writeFileSync(chainPath(ws), JSON.stringify({ count: 199, at: Date.now() - 6 * 60 * 1000 }));
	const rRst = runStopHook({ cwd: ws, stop_hook_active: true });
	assert(rRst.parsed?.decision === 'block', 'stale chain counter (>5 min old) reset, hook drained again');
	const chainAfter = JSON.parse(fs.readFileSync(chainPath(ws), 'utf8'));
	assert(chainAfter.count === 1, 'chain counter restarted at 1 (got ' + chainAfter.count + ')');

	// =====================================================
	group('Full simulated session — submit → process → drain → idle');
	// =====================================================
	nukeWorkspaceDir(ws);
	writeQueue(ws, [
		{ id: 's1', text: 'session item 1', createdAt: 1 },
		{ id: 's2', text: 'session item 2', createdAt: 2 },
		{ id: 's3', text: 'session item 3', createdAt: 3 }
	]);
	// User submits an initial prompt manually → UserPromptSubmit hook fires
	runSubmitHook({ cwd: ws, prompt: 'initial user-typed prompt' });
	// Claude finishes → Stop event → hook drains item 1
	const rs1 = runStopHook({ cwd: ws });
	assert(rs1.parsed?.reason === 'session item 1', 'first Stop drained session item 1');
	// Claude continues with item 1 (block+reason) → finishes → Stop event with active=true
	const rs2 = runStopHook({ cwd: ws, stop_hook_active: true });
	assert(rs2.parsed?.reason === 'session item 2', 'chain Stop drained session item 2');
	const rs3 = runStopHook({ cwd: ws, stop_hook_active: true });
	assert(rs3.parsed?.reason === 'session item 3', 'chain Stop drained session item 3');
	const rs4 = runStopHook({ cwd: ws, stop_hook_active: true });
	assert(rs4.parsed && !rs4.parsed.decision, 'queue empty → no decision');
	const finalHist = readHistory(ws) || [];
	assert(finalHist.length === 3, '3 hook fires recorded in history');
	assert(finalHist.every(e => e.source === 'hook'), 'all hook entries tagged source:hook');

} finally {
	nukeWorkspaceDir(ws);
	nukeWorkspaceDir(wsB);
}

const fails = RESULTS.filter(r => r.ok === false).length;
const passes = RESULTS.filter(r => r.ok === true).length;
console.log('\n' + (fails === 0 ? '✅ ALL LIVE E2E TESTS PASSED' : '❌ ' + fails + ' FAILED') + ' (' + passes + ' passed, ' + fails + ' failed)');
process.exit(fails === 0 ? 0 : 1);
