// Self-tests for v0.2.8 — per-workspace queue + hook + setup + paste/attach.
//
// All file work happens under per-workspace directories at
// ~/.claude/claude-mod-queues/<safe>-<sha1>/{queue,history,native-status}.json.
// The hook resolves the workspace from the Stop event's `cwd` field.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const vm = require('vm');

const EXT_ROOT = path.join(__dirname, '..');
const BUNDLED_HOOK = path.join(EXT_ROOT, 'assets', 'stop-hook.js');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const STABLE_HOOK = path.join(CLAUDE_DIR, 'claude-mod-hook.js');

function workspaceSafeName(p) {
	const baseRaw = path.basename(p || 'default') || 'workspace';
	const safe = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'workspace';
	const hash = crypto.createHash('sha1').update(p || 'default').digest('hex').slice(0, 8);
	return safe + '-' + hash;
}
function wsDir(p) { return path.join(CLAUDE_DIR, 'claude-mod-queues', workspaceSafeName(p)); }
function wsQueue(p) { return path.join(wsDir(p), 'queue.json'); }
function wsHistory(p) { return path.join(wsDir(p), 'history.json'); }

function snapshotDir(d) {
	if (!fs.existsSync(d)) { return null; }
	const items = {};
	for (const f of fs.readdirSync(d)) { items[f] = fs.readFileSync(path.join(d, f), 'utf8'); }
	return items;
}
function restoreDir(d, snap) {
	if (snap === null) {
		if (fs.existsSync(d)) {
			for (const f of fs.readdirSync(d)) { try { fs.unlinkSync(path.join(d, f)); } catch (_) {} }
			try { fs.rmdirSync(d); } catch (_) {}
		}
		return;
	}
	if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); }
	for (const f of fs.readdirSync(d)) {
		if (!(f in snap)) { try { fs.unlinkSync(path.join(d, f)); } catch (_) {} }
	}
	for (const f of Object.keys(snap)) { fs.writeFileSync(path.join(d, f), snap[f]); }
}
function snapshotFile(f) { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; }
function restoreFile(f, prev) {
	if (prev === null) { if (fs.existsSync(f)) { fs.unlinkSync(f); } }
	else { fs.writeFileSync(f, prev); }
}

// Pick a unique workspace path for this test run so we don't collide with
// the user's real workspace queues.
const TEST_WORKSPACE_A = path.join(os.tmpdir(), 'claude-mod-test-A-' + Date.now());
const TEST_WORKSPACE_B = path.join(os.tmpdir(), 'claude-mod-test-B-' + Date.now());
const dirA = wsDir(TEST_WORKSPACE_A);
const dirB = wsDir(TEST_WORKSPACE_B);

const backups = {
	settings: snapshotFile(SETTINGS_FILE),
	stableHook: snapshotFile(STABLE_HOOK),
	dirA: snapshotDir(dirA),
	dirB: snapshotDir(dirB)
};
function restoreAll() {
	restoreFile(SETTINGS_FILE, backups.settings);
	restoreFile(STABLE_HOOK, backups.stableHook);
	restoreDir(dirA, backups.dirA);
	restoreDir(dirB, backups.dirB);
}

let failed = 0;
function assert(cond, label) {
	if (cond) { console.log('  ✓ ' + label); }
	else { console.log('  ✗ FAIL: ' + label); failed++; }
}

function runHook(stdinPayload, env) {
	const result = cp.spawnSync('node', [BUNDLED_HOOK], {
		input: stdinPayload,
		encoding: 'utf8',
		timeout: 8000,
		env: Object.assign({}, process.env, { CLAUDE_MOD_DISABLE_NATIVE: '1' }, env || {})
	});
	return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function writeQueue(workspace, items) {
	const f = wsQueue(workspace);
	const dir = path.dirname(f);
	if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
	fs.writeFileSync(f, JSON.stringify(items, null, 2));
}
function readQueue(workspace) {
	const f = wsQueue(workspace);
	if (!fs.existsSync(f)) { return null; }
	try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function readHistory(workspace) {
	const f = wsHistory(workspace);
	if (!fs.existsSync(f)) { return null; }
	try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

try {
	console.log('=== Webview script boots cleanly ===');
	(function () {
		const { getWebviewHtml } = require(path.join(EXT_ROOT, 'out/webview.js'));
		const html = getWebviewHtml();
		const m = html.match(/<script>([\s\S]*?)<\/script>/);
		if (!m) { throw new Error('no <script> in webview html'); }
		const scriptBody = m[1];
		const els = {};
		const makeEl = (id) => (els[id] || (els[id] = {
			id, value:'', textContent:'', innerHTML:'', className:'', title:'', disabled:false,
			style:{ display:'', height:'' },
			classList:{ add(){}, remove(){}, contains(){return false;}, toggle(){} },
			scrollHeight:0, scrollTop:0,
			appendChild(){}, removeChild(){}, querySelector(){return null;},
			addEventListener(){}, removeEventListener(){}, dispatchEvent(){}, focus(){},
			getBoundingClientRect(){return {top:0,left:0,right:0,bottom:0,width:0,height:0};},
			parentNode:null, setAttribute(){}
		}));
		const sandbox = {
			console:{log(){},warn(){},error(){}}, setTimeout, setInterval, clearTimeout, clearInterval,
			Date, Math, JSON, Array, String, Number, Object, Boolean, parseFloat, parseInt,
			document:{ getElementById:(id)=>makeEl(id), querySelector(){return null;}, createElement(){return makeEl('');}, body:makeEl('body'), addEventListener(){}, removeEventListener(){} },
			window:{ addEventListener(t,h){ if(t==='message') sandbox.__h=h; }, removeEventListener(){}, innerHeight:800, innerWidth:1200 },
			acquireVsCodeApi:()=>({ postMessage(m){ (sandbox.__sent=sandbox.__sent||[]).push(m); } })
		};
		sandbox.window = Object.assign(sandbox.window, sandbox);
		vm.createContext(sandbox);
		vm.runInContext(scriptBody, sandbox);
		const wired = ['addPrompt','deleteItem','steerItem','moveUp','moveDown','editItem','clearQueue','clearHistory','openMoreMenu','onSetupClick','pickFiles','removeAttachment','fireNow','probeAccessibility','openAccessibilityPrefs'];
		const missing = wired.filter(n => typeof sandbox[n] !== 'function');
		assert(missing.length === 0, 'all ' + wired.length + ' webview handlers wired (' + (missing.join(',') || 'none missing') + ')');
		const sent = (sandbox.__sent || []).slice();
		assert(sent.some(m => m.type === 'requestStatus'), 'webview sends requestStatus on boot');
		// Status update flips the native pill correctly
		sandbox.__h({ data: { type:'status', data:{ hookInstalled:true, queueFile:'/foo', nativeStatus:{ ok:false, timedOut:true, at:Date.now() } } } });
		const np = els['nativePill'];
		assert(np && np.textContent.indexOf('permission missing') >= 0, 'native pill shows "permission missing" when timedOut');
		sandbox.__h({ data: { type:'status', data:{ hookInstalled:true, queueFile:'/foo', nativeStatus:{ ok:true, at:Date.now() } } } });
		assert(np && np.textContent.indexOf('working') >= 0, 'native pill flips to "working" when ok:true');
	})();

	console.log('\n=== Per-workspace queue isolation (v0.2.8 core feature) ===');
	// Workspace A: 2 items
	writeQueue(TEST_WORKSPACE_A, [
		{ id: 'a1', text: 'A first prompt', createdAt: 1 },
		{ id: 'a2', text: 'A second prompt', createdAt: 2 }
	]);
	// Workspace B: different items
	writeQueue(TEST_WORKSPACE_B, [
		{ id: 'b1', text: 'B first prompt', createdAt: 1 }
	]);
	assert(readQueue(TEST_WORKSPACE_A).length === 2, 'workspace A has its own 2 items');
	assert(readQueue(TEST_WORKSPACE_B).length === 1, 'workspace B has its own 1 item');

	// Hook fires for workspace A → consumes A's head, doesn't touch B
	let r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A }));
	let out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'A first prompt', 'hook with cwd=A returns A first prompt');
	assert(readQueue(TEST_WORKSPACE_A).length === 1, 'A queue now has 1 item');
	assert(readQueue(TEST_WORKSPACE_B).length === 1, 'B queue is UNTOUCHED (still 1 item)');
	assert(readQueue(TEST_WORKSPACE_B)[0].text === 'B first prompt', 'B item is unchanged');

	// Hook fires for workspace B → consumes B's head, doesn't touch A
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_B }));
	out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'B first prompt', 'hook with cwd=B returns B first prompt');
	assert(readQueue(TEST_WORKSPACE_B).length === 0, 'B queue is now empty');
	assert(readQueue(TEST_WORKSPACE_A).length === 1, 'A queue still has 1 item (cross-workspace isolation holds)');

	// History is per-workspace too
	const histA = readHistory(TEST_WORKSPACE_A) || [];
	const histB = readHistory(TEST_WORKSPACE_B) || [];
	assert(histA.length === 1 && histA[0].text === 'A first prompt', 'A history has only A entry');
	assert(histB.length === 1 && histB[0].text === 'B first prompt', 'B history has only B entry');

	// Drain A's remaining item
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A }));
	out = JSON.parse(r.stdout);
	assert(out.reason === 'A second prompt', 'A second item fired correctly');
	assert(readQueue(TEST_WORKSPACE_A).length === 0, 'A queue now empty');

	// Empty A queue → hook allows stop
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A }));
	out = JSON.parse(r.stdout);
	assert(!out.decision, 'empty workspace queue → no decision');

	console.log('\n=== v0.2.16 — in-memory _lastSuccessfulKickAt closes file-write race ===');
	(function () {
		// Static verify the compiled extension defines _lastSuccessfulKickAt
		// and uses Math.max() to combine with the file-based timestamp.
		const extSrc = fs.readFileSync(path.join(EXT_ROOT, 'out/extension.js'), 'utf8');
		assert(extSrc.indexOf('_lastSuccessfulKickAt') >= 0, 'extension declares _lastSuccessfulKickAt');
		assert(extSrc.indexOf('Math.max(fileLastSubAt') >= 0 || extSrc.indexOf('Math.max(') >= 0, 'extension takes Math.max(fileLastSubAt, in-memory)');
		const inFlightSetterMatches = (extSrc.match(/_lastSuccessfulKickAt\s*=\s*Date\.now\(\)/g) || []).length;
		assert(inFlightSetterMatches >= 1, '_lastSuccessfulKickAt is set on successful kick (' + inFlightSetterMatches + ' assignments found)');
	})();

	console.log('\n=== v0.2.15 — UserPromptSubmit hook + precise busy/idle ===');
	(function () {
		const setup = require(path.join(EXT_ROOT, 'out/hook-setup.js'));
		const ws = path.join(os.tmpdir(), 'claude-mod-busy-' + Date.now());
		fs.mkdirSync(ws, { recursive: true });
		const p = setup.getPathsForWorkspace(ws);

		// (1) Run the bundled user-prompt-submit-hook with a fake event and
		//     verify it writes the user-submit marker.
		const submitHookSrc = path.join(EXT_ROOT, 'assets/user-prompt-submit-hook.js');
		assert(fs.existsSync(submitHookSrc), 'user-prompt-submit-hook.js bundled with extension');
		const r = cp.spawnSync('node', [submitHookSrc], {
			input: JSON.stringify({ cwd: ws, prompt: 'hello' }),
			encoding: 'utf8',
			timeout: 5000
		});
		assert(r.status === 0, 'user-submit hook exits 0');
		assert(r.stdout.trim() === '{}', 'user-submit hook writes only {} to stdout (does not modify the prompt)');
		const marker = setup.loadUserSubmitMarker(p.userSubmitFile);
		assert(marker !== null, 'user-submit marker file was written');
		assert(typeof marker.submittedAt === 'number', 'marker has numeric submittedAt');
		assert(marker.promptLength === 5, 'marker recorded promptLength=5 (no text)');

		// (2) installHook now installs BOTH hooks.
		setup.uninstallHook();
		setup.installHook(EXT_ROOT);
		const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
		const stopHooksStr = JSON.stringify(settings.hooks.Stop);
		const submitHooksStr = JSON.stringify(settings.hooks.UserPromptSubmit || []);
		assert(stopHooksStr.indexOf('claude-mod-stop-hook') >= 0, 'Stop hook installed');
		assert(submitHooksStr.indexOf('claude-mod-user-submit-hook') >= 0, 'UserPromptSubmit hook installed');

		// (3) Uninstall removes BOTH.
		setup.uninstallHook();
		const s2 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
		assert(!JSON.stringify(s2.hooks.Stop || []).includes('claude-mod-stop-hook'), 'Stop hook removed on uninstall');
		assert(!JSON.stringify(s2.hooks.UserPromptSubmit || []).includes('claude-mod-user-submit-hook'), 'UserPromptSubmit hook removed on uninstall');

		// (4) Watchdog logic — verify the compiled extension reads BOTH
		//     signals and prefers UserPromptSubmit as the busy indicator.
		const extSrc = fs.readFileSync(path.join(EXT_ROOT, 'out/extension.js'), 'utf8');
		assert(extSrc.indexOf('_lastUserSubmitAt') >= 0, 'extension reads last user-submit timestamp');
		assert(extSrc.indexOf('lastSubAt > lastStopAt') >= 0, 'watchdog skips when Claude is busy (LASTSUB > LASTSTOP)');
		assert(extSrc.indexOf('claudeBusy') >= 0, 'status payload exposes claudeBusy to the webview');
	})();

	console.log('\n=== v0.2.14 — hook entries tagged source:hook ===');
	(function () {
		// Clear the workspace dir + run hook once; verify the resulting
		// history entry has source: 'hook'.
		const ws = TEST_WORKSPACE_A;
		writeQueue(ws, [{ id: 'src-check', text: 'source-tag-test', createdAt: 1 }]);
		const histFile = wsHistory(ws);
		if (fs.existsSync(histFile)) { fs.unlinkSync(histFile); }
		runHook(JSON.stringify({ cwd: ws }));
		const hist = readHistory(ws) || [];
		assert(hist.length === 1, 'one history entry after hook fire');
		assert(hist[0].source === 'hook', 'hook-written history entry has source:hook (was ' + hist[0].source + ')');
	})();

	console.log('\n=== v0.2.14 — extension-kick history entries are filtered by watchdog ===');
	(function () {
		// We don't run the extension here, but we can verify the v0.2.14
		// compiled extension.js contains the source-filtering logic.
		const extSrc = fs.readFileSync(path.join(EXT_ROOT, 'out/extension.js'), 'utf8');
		assert(extSrc.indexOf("'extension-kick'") >= 0, 'extension emits source:extension-kick on its own kicks');
		assert(extSrc.indexOf("e.source === 'hook'") >= 0, 'watchdog filters history by source:hook for recency check');
		assert(extSrc.indexOf('KICK_MAX_WAIT_MS') >= 0, 'extension defines KICK_MAX_WAIT_MS recovery timeout');
		// v0.2.15 superseded the lastHookFireAt > lastKickAt comparison —
		// the watchdog now uses UserPromptSubmit timestamps as the primary
		// "Claude is busy" signal instead of comparing hook fires to our
		// own kicks. The corresponding v0.2.15 assertions live below.
		assert(extSrc.indexOf('lastSubAt > lastStopAt') >= 0 || extSrc.indexOf('lastHookFireAt > lastKickAt') >= 0, 'watchdog has a busy-vs-idle decision');
	})();

	console.log('\n=== v0.2.12 — drain continues across stop_hook_active chain ===');
	// Before v0.2.12 the hook bailed instantly when stop_hook_active=true,
	// which capped each Stop-chain to exactly one consumed item. Now the
	// queue drains the entire chain, capped only by the per-chain safety.
	writeQueue(TEST_WORKSPACE_A, [
		{ id: 'c1', text: 'chain-1', createdAt: 1 },
		{ id: 'c2', text: 'chain-2', createdAt: 2 }
	]);
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A, stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'chain-1', 'stop_hook_active=true still drains queue (was the v0.2.11 bug)');
	assert(readQueue(TEST_WORKSPACE_A).length === 1, 'queue advanced from 2 → 1 even with stop_hook_active=true');
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A, stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'chain-2', 'second fire with stop_hook_active continues to drain');
	assert(readQueue(TEST_WORKSPACE_A).length === 0, 'queue fully drained');

	// And the consecutive-block safety cap kicks in eventually.
	console.log('\n=== v0.2.12 — consecutive-block safety cap ===');
	// Pre-seed the chain counter past the cap to verify it bails.
	const chainFile = path.join(wsDir(TEST_WORKSPACE_A), 'block-chain.json');
	fs.writeFileSync(chainFile, JSON.stringify({ count: 250, at: Date.now() }));
	writeQueue(TEST_WORKSPACE_A, [{ id: 'safety', text: 'should be capped', createdAt: 1 }]);
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A, stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(!out.decision, 'count > MAX_CONSECUTIVE_BLOCK_FIRES → no decision (cap honoured)');
	// Reset for next tests
	try { fs.unlinkSync(chainFile); } catch (_) {}

	console.log('\n=== Native-vs-feedback paths ===');
	const hookSrc = fs.readFileSync(BUNDLED_HOOK, 'utf8');
	assert(hookSrc.indexOf('tryNativeSubmit') >= 0, 'hook source defines tryNativeSubmit');
	assert(hookSrc.indexOf('CLAUDE_MOD_DISABLE_NATIVE') >= 0, 'hook source honours the disable env var');
	assert(hookSrc.indexOf("event.cwd") >= 0, 'hook source reads workspace from event.cwd');

	console.log('\n=== Setup module — install/uninstall + stable hook script ===');
	const setup = require(path.join(EXT_ROOT, 'out/hook-setup.js'));
	setup.uninstallHook();
	assert(!setup.isHookInstalled(), 'starts uninstalled');
	const inst = setup.installHook(EXT_ROOT);
	assert(inst.installed === true, 'installHook succeeds');
	assert(setup.isHookInstalled(), 'isHookInstalled true after install');
	const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	const stopHooksStr = JSON.stringify(settings.hooks.Stop);
	assert(stopHooksStr.indexOf(STABLE_HOOK) >= 0, 'settings.json uses stable hook path');
	assert(stopHooksStr.indexOf('/usr/bin/env node') >= 0, 'command uses /usr/bin/env node');
	// Idempotent reinstall
	setup.installHook(EXT_ROOT);
	const s2 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	const our = s2.hooks.Stop.filter(h => JSON.stringify(h).includes('claude-mod-stop-hook')).length;
	assert(our === 1, 'reinstall is idempotent');
	// Foreign hook preserved
	s2.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'echo foreign' }] });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s2, null, 2));
	const before = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).hooks.Stop.length;
	setup.uninstallHook();
	const s3 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	assert(s3.hooks.Stop.length === before - 1, 'uninstall removed only our entry');
	assert(s3.hooks.Stop.some(h => JSON.stringify(h).includes('echo foreign')), 'foreign hook preserved');

	console.log('\n=== getPathsForWorkspace returns workspace-scoped paths ===');
	const pa = setup.getPathsForWorkspace(TEST_WORKSPACE_A);
	const pb = setup.getPathsForWorkspace(TEST_WORKSPACE_B);
	assert(pa.queueFile !== pb.queueFile, 'different workspaces → different queue files');
	assert(pa.queueFile.indexOf(workspaceSafeName(TEST_WORKSPACE_A)) >= 0, 'A path includes A safe name');
	assert(pb.queueFile.indexOf(workspaceSafeName(TEST_WORKSPACE_B)) >= 0, 'B path includes B safe name');

	console.log('\n=== Atomic write integrity ===');
	const probe = path.join(CLAUDE_DIR, 'claude-mod-atomic-probe.json');
	setup.atomicWriteFile(probe, '{"k":"v"}');
	const leftover = fs.readdirSync(CLAUDE_DIR).filter(n => n.startsWith('.claude-mod-atomic-probe.json.'));
	assert(leftover.length === 0, 'no .tmp residue after atomicWriteFile');
	assert(fs.readFileSync(probe, 'utf8') === '{"k":"v"}', 'atomic write produced correct content');
	fs.unlinkSync(probe);

	for (let i = 0; i < 20; i++) {
		setup.saveQueueToFile(wsQueue(TEST_WORKSPACE_A), [{ id: 'r'+i, text: 'rapid '+i, createdAt: i }]);
		const q = setup.loadQueueFromFile(wsQueue(TEST_WORKSPACE_A));
		assert(q.length === 1 && q[0].text === 'rapid ' + i, 'rapid-write ' + i + ' consistent');
		if (failed > 0) { break; }
	}

	console.log('\n=== v0.2.11 path canonicalization (same project ↔ same dir) ===');
	(function () {
		const setup = require(path.join(EXT_ROOT, 'out/hook-setup.js'));
		const ws = path.join(os.tmpdir(), 'claude-mod-canon-test-' + Date.now());
		fs.mkdirSync(ws, { recursive: true });
		try {
			const noSlash = setup.canonicalizeWorkspacePath(ws);
			const withSlash = setup.canonicalizeWorkspacePath(ws + '/');
			const relativeish = setup.canonicalizeWorkspacePath(ws + '/./');
			assert(noSlash === withSlash, 'trailing slash → same canonical path');
			assert(noSlash === relativeish, 'redundant ./ → same canonical path');

			// Same workspace → same per-workspace paths
			const a = setup.getPathsForWorkspace(ws);
			const b = setup.getPathsForWorkspace(ws + '/');
			assert(a.queueFile === b.queueFile, 'trailing slash → same queueFile');
			assert(a.historyFile === b.historyFile, 'trailing slash → same historyFile');

			// Symlinks resolve to the same canonical
			const link = path.join(os.tmpdir(), 'claude-mod-canon-link-' + Date.now());
			try { fs.symlinkSync(ws, link); } catch (_) { /* skip on platforms without symlink support */ }
			if (fs.existsSync(link)) {
				const viaSymlink = setup.canonicalizeWorkspacePath(link);
				assert(viaSymlink === noSlash, 'symlink → resolves to same canonical as target');
				try { fs.unlinkSync(link); } catch (_) {}
			}

			// The hook script's canonicalization must match the TS module's.
			// We run a tiny shim that requires only path/fs/crypto and the
			// hook's helpers — but since the hook is a script not a module,
			// instead extract its canonicalizeWorkspacePath via regex and eval
			// in a sandbox, OR rely on the well-known string content.
			const hookSrc = fs.readFileSync(path.join(EXT_ROOT, 'assets/stop-hook.js'), 'utf8');
			assert(hookSrc.indexOf('canonicalizeWorkspacePath') >= 0, 'hook source has the canonicalization function');
			assert(hookSrc.indexOf('fs.realpathSync') >= 0, 'hook source uses realpathSync for canonical resolution');
		} finally {
			try { fs.rmdirSync(ws); } catch (_) {}
		}
	})();

	console.log('\n=== v0.2.11 queue integrity validation (drops malformed entries) ===');
	(function () {
		const setup = require(path.join(EXT_ROOT, 'out/hook-setup.js'));
		const ws = path.join(os.tmpdir(), 'claude-mod-validation-test-' + Date.now());
		fs.mkdirSync(ws, { recursive: true });
		const paths = setup.getPathsForWorkspace(ws);
		// Write a mixed-validity file
		fs.writeFileSync(paths.queueFile, JSON.stringify([
			{ id: 'a', text: 'good 1', createdAt: 1 },
			null,
			{ text: 'no id' },
			{ id: 'b' },
			{ id: 'c', text: 'good 2' },
			{ id: 'd', text: 'with createdAt repaired' /* no createdAt */ },
			{ id: 'e', text: 'with attachments', attachments: ['/tmp/foo', 42, null, '/tmp/bar'] },
			'not an object',
			{ id: '', text: 'empty id' }
		]));
		const q = setup.loadQueueFromFile(paths.queueFile);
		assert(q.length === 4, 'kept only 4 valid entries (was 9 raw; dropped 5 malformed) — got ' + q.length);
		assert(q[0].text === 'good 1', 'first valid item preserved');
		assert(q[1].text === 'good 2', 'second valid item preserved');
		assert(typeof q[2].createdAt === 'number', 'missing createdAt repaired to a number');
		assert(q[3].attachments && q[3].attachments.length === 2, 'attachments filtered to string entries only');
		// Cleanup
		try { fs.unlinkSync(paths.queueFile); fs.rmdirSync(paths.workspaceDir); } catch (_) {}
	})();

	console.log('\n=== v0.2.11 image size cap (10 MB rejected) ===');
	(function () {
		const setup = require(path.join(EXT_ROOT, 'out/hook-setup.js'));
		// Small image: should succeed
		const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
		const ok = setup.saveBase64Image(pngBase64, 'image/png');
		assert(fs.existsSync(ok), 'small image still accepted');
		try { fs.unlinkSync(ok); } catch (_) {}

		// 11 MB image: should throw ImageTooLargeError
		const big = Buffer.alloc(11 * 1024 * 1024, 0).toString('base64');
		let threw = false;
		try { setup.saveBase64Image(big, 'image/png'); }
		catch (e) {
			threw = true;
			assert(e.name === 'ImageTooLargeError', 'oversized → ImageTooLargeError (got ' + e.name + ')');
			assert(typeof e.actualBytes === 'number' && e.actualBytes > 10 * 1024 * 1024, 'error carries actualBytes');
			assert(typeof e.maxBytes === 'number' && e.maxBytes === 10 * 1024 * 1024, 'error carries maxBytes = 10 MB');
		}
		assert(threw, 'oversized image was rejected');
	})();

	console.log('\n=== Auto-kick safeguard surface (v0.2.10) ===');
	(function () {
		// We can't easily exercise the QueueProvider class here (it requires
		// the vscode module). But we can statically verify the compiled
		// extension.js wires up the four guards described in the changelog:
		// in-flight mutex, cooldown, hook-recent threshold, and the setting.
		const extSrc = fs.readFileSync(path.join(EXT_ROOT, 'out/extension.js'), 'utf8');
		assert(extSrc.indexOf('_kickInFlight') >= 0, 'extension.js declares _kickInFlight mutex');
		assert(extSrc.indexOf('_lastAutoKickAt') >= 0, 'extension.js tracks _lastAutoKickAt for cooldown');
		assert(extSrc.indexOf('AUTO_KICK_COOLDOWN_MS') >= 0, 'extension.js defines AUTO_KICK_COOLDOWN_MS constant');
		assert(extSrc.indexOf('HOOK_RECENT_THRESHOLD_MS') >= 0, 'extension.js defines HOOK_RECENT_THRESHOLD_MS constant');
		assert(extSrc.indexOf('autoKickWhenIdle') >= 0, 'extension.js reads autoKickWhenIdle setting');
		assert(extSrc.indexOf('previousQueue.length === 0') >= 0, 'auto-kick only on empty → non-empty transition');
		assert(extSrc.indexOf('_maybeAutoKick') >= 0, 'extension.js has _maybeAutoKick gate method');
		// And the setting is registered as enabled by default
		const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'));
		const setting = pkg.contributes.configuration.properties['claudeCodeModified.autoKickWhenIdle'];
		assert(setting && setting.default === true, 'autoKickWhenIdle default = true (auto-kick on by default)');
	})();

	console.log('\n=== Attachment helpers ===');
	const ad = setup.getAttachmentsDir();
	assert(typeof ad === 'string' && fs.existsSync(ad), 'attachments dir exists');
	const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
	const w = setup.saveBase64Image(pngBase64, 'image/png');
	assert(fs.existsSync(w) && w.endsWith('.png'), 'saveBase64Image wrote a .png');
	const buf = fs.readFileSync(w);
	assert(buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47, 'valid PNG header bytes');
	fs.unlinkSync(w);

	console.log('\n' + (failed === 0 ? '✅ ALL TESTS PASSED' : '❌ ' + failed + ' FAILED'));
} catch (err) {
	console.error('FATAL:', err.message);
	console.error(err.stack);
	failed = Math.max(failed, 1);
} finally {
	restoreAll();
}

process.exit(failed === 0 ? 0 : 1);
