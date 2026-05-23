// Self-tests for v0.2.1 — Stop hook + queue/history files + hook setup.
//
// Verifies the integration end-to-end against the REAL compiled hook script
// and the REAL hook-setup module, with controlled queue/history/settings files
// (originals are backed up and restored at exit).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const EXT_ROOT = path.join(__dirname, '..');
const BUNDLED_HOOK = path.join(EXT_ROOT, 'assets', 'stop-hook.js');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const QUEUE_FILE = path.join(CLAUDE_DIR, 'claude-mod-queue.json');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'claude-mod-history.json');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const STABLE_HOOK = path.join(CLAUDE_DIR, 'claude-mod-hook.js');

// Snapshot files for restoration.
function snapshot(file) {
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
function restore(file, prev) {
	if (prev === null) {
		if (fs.existsSync(file)) { fs.unlinkSync(file); }
	} else {
		fs.writeFileSync(file, prev);
	}
}
const backups = {
	queue: snapshot(QUEUE_FILE),
	history: snapshot(HISTORY_FILE),
	settings: snapshot(SETTINGS_FILE),
	stableHook: snapshot(STABLE_HOOK)
};
function restoreAll() {
	restore(QUEUE_FILE, backups.queue);
	restore(HISTORY_FILE, backups.history);
	restore(SETTINGS_FILE, backups.settings);
	restore(STABLE_HOOK, backups.stableHook);
}

let failed = 0;
function assert(cond, label) {
	if (cond) { console.log('  ✓ ' + label); }
	else { console.log('  ✗ FAIL: ' + label); failed++; }
}

function runHook(stdinPayload, env) {
	// Run with CLAUDE_MOD_DISABLE_NATIVE=1 by default so the test doesn't
	// spawn osascript and start typing into the developer's session. That
	// forces the hook into its FEEDBACK fallback path, which is what we
	// assert against. The native-submit path is exercised by the v0.2.6
	// integration test inside VS Code.
	const result = cp.spawnSync('node', [BUNDLED_HOOK], {
		input: stdinPayload,
		encoding: 'utf8',
		timeout: 8000,
		env: Object.assign({}, process.env, { CLAUDE_MOD_DISABLE_NATIVE: '1' }, env || {})
	});
	return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function writeQueue(items) {
	fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2));
}
function readQueue() {
	if (!fs.existsSync(QUEUE_FILE)) { return null; }
	try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return null; }
}
function readHistory() {
	if (!fs.existsSync(HISTORY_FILE)) { return null; }
	try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return null; }
}

try {
	console.log('=== Attachment helpers (v0.2.3) ===');
	(function () {
		const setup = require(path.join(EXT_ROOT, 'out/hook-setup.js'));
		const attachDir = setup.getAttachmentsDir();
		assert(typeof attachDir === 'string' && attachDir.length > 0, 'getAttachmentsDir returns a non-empty string');
		assert(fs.existsSync(attachDir), 'attachments directory exists after getAttachmentsDir()');

		// saveBase64Image writes a valid file with the right extension
		// 1×1 transparent PNG
		const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
		const written = setup.saveBase64Image(pngBase64, 'image/png');
		assert(typeof written === 'string' && written.endsWith('.png'), 'saveBase64Image returns a .png path');
		assert(fs.existsSync(written), 'saveBase64Image wrote the file to disk');
		const buf = fs.readFileSync(written);
		assert(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, 'wrote bytes are a valid PNG signature');
		// Cleanup
		fs.unlinkSync(written);

		// JPEG extension mapping
		const jpgPath = setup.saveBase64Image(pngBase64, 'image/jpeg');
		assert(jpgPath.endsWith('.jpg'), 'image/jpeg → .jpg extension');
		fs.unlinkSync(jpgPath);

		// Unknown mime falls back to .png
		const fallbackPath = setup.saveBase64Image(pngBase64, 'application/octet-stream');
		assert(fallbackPath.endsWith('.png'), 'unknown mime falls back to .png extension');
		fs.unlinkSync(fallbackPath);
	})();

	console.log('=== Webview script boots cleanly (regression test for v0.2.1 idx bug) ===');
	// Load the compiled webview, extract the inline <script>, and execute it
	// under a minimal DOM + vscode mock. Any syntax error or runtime error in
	// the top-level script body would have left v0.2.1's panel with the
	// "checking…" status pill stuck and Install/Uninstall buttons inert.
	(function () {
		const vm = require('vm');
		const { getWebviewHtml } = require(path.join(EXT_ROOT, 'out/webview.js'));
		const html = getWebviewHtml();
		const m = html.match(/<script>([\s\S]*?)<\/script>/);
		if (!m) { throw new Error('no <script> in webview html'); }
		const scriptBody = m[1];

		const elementById = {};
		function makeEl(id) {
			return {
				id, value: '', textContent: '', innerHTML: '', className: '',
				title: '', disabled: false, style: { display: '', height: '' },
				classList: { add(){}, remove(){}, contains(){return false;}, toggle(){} },
				scrollHeight: 0, scrollTop: 0,
				appendChild(){}, removeChild(){}, querySelector(){return null;},
				addEventListener(){}, removeEventListener(){}, dispatchEvent(){}, focus(){},
				getBoundingClientRect(){return {top:0,left:0,right:0,bottom:0,width:0,height:0};},
				parentNode: null, setAttribute(){},
			};
		}
		const sandbox = {
			console: { log(){}, warn(){}, error(){} },
			setTimeout, setInterval, clearTimeout, clearInterval,
			Date, Math, JSON, Array, String, Number, Object, Boolean, parseFloat, parseInt,
			document: {
				getElementById(id) { if (!elementById[id]) elementById[id]=makeEl(id); return elementById[id]; },
				querySelector(){return null;}, createElement(){return makeEl();},
				body: makeEl('body'), addEventListener(){}, removeEventListener(){},
			},
			window: {
				addEventListener(t, h){ if (t==='message') sandbox.__msgHandler=h; },
				removeEventListener(){}, innerHeight: 800, innerWidth: 1200,
			},
			acquireVsCodeApi: () => ({ postMessage(m){ (sandbox.__sent=sandbox.__sent||[]).push(m); } }),
		};
		sandbox.window = Object.assign(sandbox.window, sandbox);
		vm.createContext(sandbox);
		vm.runInContext(scriptBody, sandbox);

		assert(typeof sandbox.__msgHandler === 'function', 'window message handler registered');
		assert(typeof sandbox.onSetupClick === 'function', 'onSetupClick exposed on window (Install button is wired)');
		assert(typeof sandbox.addPrompt === 'function', 'addPrompt exposed on window');
		assert(typeof sandbox.steerItem === 'function', 'steerItem exposed on window');
		assert(typeof sandbox.deleteItem === 'function', 'deleteItem exposed on window');
		assert(typeof sandbox.moveUp === 'function', 'moveUp exposed on window');
		assert(typeof sandbox.moveDown === 'function', 'moveDown exposed on window');
		assert(typeof sandbox.openMoreMenu === 'function', 'openMoreMenu exposed on window');
		assert(typeof sandbox.pickFiles === 'function', 'pickFiles exposed on window (attach button is wired)');
		assert(typeof sandbox.removeAttachment === 'function', 'removeAttachment exposed on window');
		assert(typeof sandbox.fireNow === 'function', 'fireNow exposed on window (Fire-now button wired)');

		// First verify the initial requestStatus message was sent on script load,
		// BEFORE we reset __sent for the per-action checks below.
		const initialSent = (sandbox.__sent || []).slice();
		assert(initialSent.some(m => m.type === 'requestStatus'), 'webview requested initial status from host on load');

		// fireNow posts a fireNow message to the host
		sandbox.__sent = [];
		sandbox.fireNow();
		assert(sandbox.__sent.some(m => m.type === 'fireNow'), 'fireNow() posts fireNow message to host');

		// pickFiles posts a pickFiles message to the host
		sandbox.__sent = [];
		sandbox.pickFiles();
		assert(sandbox.__sent.some(m => m.type === 'pickFiles'), 'pickFiles() posts pickFiles message to host');

		// fileAttached message from host should be picked up by the script
		// (we can't observe pendingAttachments directly since it's a closure
		// local, but we can verify the script handles the message without
		// throwing and a subsequent addPrompt produces text with the path).
		sandbox.__msgHandler({ data: { type: 'fileAttached', data: { path: '/tmp/foo.png' } } });
		// Set textarea value, call addPrompt, observe the persisted queue.
		const promptEl = elementById['promptInput'];
		promptEl.value = 'look at this image';
		sandbox.__sent = [];
		sandbox.addPrompt();
		const savedMsg = sandbox.__sent.find(m => m.type === 'saveQueue');
		assert(savedMsg && Array.isArray(savedMsg.data) && savedMsg.data.length >= 1, 'addPrompt saved the queue with attachment');
		const lastItem = savedMsg.data[savedMsg.data.length - 1];
		assert(lastItem.text.indexOf('look at this image') >= 0, 'queued text contains the typed prompt');
		assert(lastItem.text.indexOf('/tmp/foo.png') >= 0, 'queued text includes the attached file path');
		assert(Array.isArray(lastItem.attachments) && lastItem.attachments.indexOf('/tmp/foo.png') >= 0, 'queued item carries attachments array');

		// Simulate host responding with a status payload — the pill must update.
		sandbox.__msgHandler({ data: { type: 'status', data: { hookInstalled: false, queueFile: '/Users/x/.claude/claude-mod-queue.json' } } });
		const pill = elementById['hookPill'];
		const qfl = elementById['queueFileLabel'];
		assert(pill && pill.textContent === '✗ not installed', 'status message → pill text updated (was: "' + (pill && pill.textContent) + '")');
		assert(qfl && qfl.textContent && qfl.textContent !== '—', 'status message → queue file label updated (was: "' + (qfl && qfl.textContent) + '")');

		// And again with hookInstalled: true
		sandbox.__msgHandler({ data: { type: 'status', data: { hookInstalled: true, queueFile: '/Users/x/.claude/claude-mod-queue.json' } } });
		assert(pill.textContent === '✓ installed', 'status with hookInstalled:true → pill flips to installed');
	})();

	console.log('=== Auto-kick module wiring (v0.2.4) ===');
	(function () {
		// Load the module — just verify the export exists and rejects non-mac
		// or empty inputs without actually invoking osascript (which would
		// pop a permissions dialog and actually type into the user's session).
		const kick = require(path.join(EXT_ROOT, 'out/auto-kick.js'));
		assert(typeof kick.kickClaudeCodeChat === 'function', 'kickClaudeCodeChat is exported');

		// Empty input must short-circuit without spawning osascript.
		return kick.kickClaudeCodeChat('').then((r) => {
			assert(r.success === false, 'empty text → success:false');
			assert((r.error || '').includes('Empty') || (r.error || '').includes('Auto-kick'), 'returns a sensible error for empty input');
		});
	})();

	console.log('=== Hook script behavior ===');

	console.log('\n[1] empty queue → hook allows stop');
	writeQueue([]);
	let r = runHook('{}');
	let out = JSON.parse(r.stdout);
	assert(!out.decision, 'no decision field returned');
	assert(r.status === 0, 'hook exited 0');

	console.log('\n[2] one pending → hook blocks stop and consumes it');
	writeQueue([{ id: 'a', text: 'first prompt', createdAt: 1 }]);
	if (fs.existsSync(HISTORY_FILE)) { fs.unlinkSync(HISTORY_FILE); }
	r = runHook('{}'); out = JSON.parse(r.stdout);
	assert(out.decision === 'block', 'decision is block');
	assert(out.reason === 'first prompt', 'reason matches first prompt');
	assert((readQueue() || []).length === 0, 'queue is empty after consumption');

	console.log('\n[3] history log appended on consumption');
	const hist = readHistory();
	assert(Array.isArray(hist) && hist.length === 1, 'history file now has one entry');
	assert(hist[0].text === 'first prompt', 'history entry text matches consumed prompt');
	assert(typeof hist[0].firedAt === 'number', 'history entry has numeric firedAt');
	assert(hist[0].firedAt > 0 && Math.abs(Date.now() - hist[0].firedAt) < 10000, 'firedAt is a recent timestamp');

	console.log('\n[4] multiple pending → consumed one at a time, history grows');
	writeQueue([
		{ id: 'b', text: 'second', createdAt: 2 },
		{ id: 'c', text: 'third', createdAt: 3 }
	]);
	runHook('{}'); runHook('{}');
	const hist2 = readHistory();
	assert(Array.isArray(hist2) && hist2.length === 3, 'history now has three entries');
	assert(hist2[1].text === 'second' && hist2[2].text === 'third', 'history is in firing order');

	console.log('\n[5] stop_hook_active → no consumption, no history append');
	writeQueue([{ id: 'd', text: 'should not fire', createdAt: 4 }]);
	const histBefore = (readHistory() || []).length;
	r = runHook(JSON.stringify({ stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(!out.decision, 'no decision when stop_hook_active');
	assert((readQueue() || []).length === 1, 'queue not consumed');
	assert((readHistory() || []).length === histBefore, 'history not appended');

	console.log('\n[6] malformed queue file → safe fallback');
	fs.writeFileSync(QUEUE_FILE, '{not json');
	r = runHook('{}'); out = JSON.parse(r.stdout);
	assert(!out.decision, 'malformed queue produces no decision');

	console.log('\n[7] history is bounded (capped at MAX_HISTORY=50)');
	writeQueue([{ id: 'x', text: 'extra', createdAt: 1 }]);
	// Pre-fill history with 60 entries
	const filler = Array.from({ length: 60 }, (_, i) => ({ text: 'filler-' + i, firedAt: i }));
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(filler));
	runHook('{}');
	const histCapped = readHistory();
	assert(histCapped.length <= 50, 'history capped at 50 entries (was ' + histCapped.length + ')');
	assert(histCapped[histCapped.length - 1].text === 'extra', 'most-recent entry is the newly fired one');

	console.log('\n=== v0.2.6 native-vs-feedback delivery paths ===');
	(function () {
		// Feedback path (native disabled via env var) — should return block+reason
		writeQueue([{ id: 'fb', text: 'fallback test', createdAt: 1 }]);
		const r = runHook('{}', { CLAUDE_MOD_DISABLE_NATIVE: '1' });
		const out = JSON.parse(r.stdout);
		assert(out.decision === 'block', 'feedback fallback returns decision:block');
		assert(out.reason === 'fallback test', 'feedback fallback returns prompt as reason');
		assert((readQueue() || []).length === 0, 'feedback fallback still consumes queue item');
		// Native path is exercised manually via VS Code — we don't spawn
		// osascript in unit tests because it would type into the dev session.
		// We do verify the hook source contains the native-submit code path
		// and the env-var bypass so future regressions are caught.
		const hookSrc = fs.readFileSync(BUNDLED_HOOK, 'utf8');
		assert(hookSrc.indexOf('tryNativeSubmit') >= 0, 'hook source defines tryNativeSubmit');
		assert(hookSrc.indexOf('CLAUDE_MOD_DISABLE_NATIVE') >= 0, 'hook source honours the disable env var');
		assert(hookSrc.indexOf('osascript') >= 0, 'hook source spawns osascript for native delivery');
	})();

	console.log('\n=== Hook-setup module ===');
	// Use the compiled hook-setup module (out/) — same file the running extension uses.
	const setup = require(path.join(EXT_ROOT, 'out/hook-setup.js'));

	console.log('\n[8] refreshStableHookScript copies the bundled hook to ~/.claude/');
	if (fs.existsSync(STABLE_HOOK)) { fs.unlinkSync(STABLE_HOOK); }
	const refreshed = setup.refreshStableHookScript(EXT_ROOT);
	assert(refreshed === true, 'refresh returned true (newly created)');
	assert(fs.existsSync(STABLE_HOOK), 'stable hook script now exists at ' + STABLE_HOOK);
	assert(
		fs.readFileSync(STABLE_HOOK, 'utf8') === fs.readFileSync(BUNDLED_HOOK, 'utf8'),
		'stable hook contents match the bundled hook'
	);

	console.log('\n[9] refresh is idempotent (no rewrite when content unchanged)');
	const refreshed2 = setup.refreshStableHookScript(EXT_ROOT);
	assert(refreshed2 === false, 'refresh returned false (no change)');

	console.log('\n[10] install/uninstall round trip — uses STABLE hook path in settings');
	setup.uninstallHook();
	assert(!setup.isHookInstalled(), 'starts uninstalled');
	const inst = setup.installHook(EXT_ROOT);
	assert(inst.hookInstalled === true, 'installHook reports hookInstalled:true');
	assert(setup.isHookInstalled(), 'isHookInstalled reports true after install');
	const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	const stopHooksStr = JSON.stringify(settings.hooks.Stop);
	assert(stopHooksStr.includes(STABLE_HOOK), 'settings.json points at STABLE hook path, not extension folder');
	assert(stopHooksStr.includes('claude-mod-stop-hook'), 'marker present for idempotent uninstall');
	assert(stopHooksStr.includes('/usr/bin/env node'), 'command uses /usr/bin/env node (works with nvm/asdf)');

	console.log('\n[11] re-install is idempotent (only one entry)');
	setup.installHook(EXT_ROOT);
	const settings2 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	const ourCount = settings2.hooks.Stop.filter(h => JSON.stringify(h).includes('claude-mod-stop-hook')).length;
	assert(ourCount === 1, 'exactly one of our hook entries after second install');

	console.log('\n[12] uninstall removes only our entry, leaves others alone');
	// Add a foreign hook entry to verify we don't nuke it
	settings2.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'echo foreign' }] });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings2, null, 2));
	const beforeCount = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).hooks.Stop.length;
	setup.uninstallHook();
	const settings3 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	assert(!setup.isHookInstalled(), 'our hook gone');
	assert(settings3.hooks.Stop.length === beforeCount - 1, 'foreign hook preserved (count down by exactly 1)');
	const foreignKept = settings3.hooks.Stop.some(h => JSON.stringify(h).includes('echo foreign'));
	assert(foreignKept, 'foreign hook entry still present in settings');

	console.log('\n=== Atomic write integrity ===');

	console.log('\n[13] atomicWriteFile leaves no .tmp residue on success');
	const targetFile = path.join(CLAUDE_DIR, 'claude-mod-atomic-test.json');
	setup.atomicWriteFile(targetFile, '{"hello":"world"}');
	const dirEntries = fs.readdirSync(CLAUDE_DIR);
	const leftoverTmp = dirEntries.filter(n => n.startsWith('.claude-mod-atomic-test.json.'));
	assert(leftoverTmp.length === 0, 'no .tmp leftover after atomic write');
	assert(fs.readFileSync(targetFile, 'utf8') === '{"hello":"world"}', 'target file contents are correct');
	fs.unlinkSync(targetFile);

	console.log('\n[14] saveQueueToFile uses atomic write (no observed half-write)');
	// We can't easily simulate a crash mid-write here, but we can verify the
	// rename pattern by intercepting writes via a probe file watcher would be
	// flaky in this harness. Instead, confirm queue file is overwritten cleanly
	// by repeated rapid writes.
	for (let i = 0; i < 20; i++) {
		setup.saveQueueToFile([{ id: 'r' + i, text: 'rapid ' + i, createdAt: i }]);
		const q = setup.loadQueueFromFile();
		assert(q.length === 1 && q[0].text === 'rapid ' + i, 'rapid-write ' + i + ' read back consistently');
		if (failed > 0) { break; }
	}

	console.log('\n' + (failed === 0 ? '✅ ALL TESTS PASSED' : '❌ ' + failed + ' TEST(S) FAILED'));
} catch (err) {
	console.error('FATAL:', err.message);
	console.error(err.stack);
	failed = Math.max(failed, 1);
} finally {
	restoreAll();
}

process.exit(failed === 0 ? 0 : 1);
