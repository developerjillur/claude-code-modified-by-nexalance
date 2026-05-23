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

	console.log('\n=== Stop-event loop protection ===');
	writeQueue(TEST_WORKSPACE_A, [{ id: 'x', text: 'should not fire', createdAt: 1 }]);
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A, stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(!out.decision, 'stop_hook_active → no consumption');
	assert(readQueue(TEST_WORKSPACE_A).length === 1, 'queue preserved during loop protection');

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
