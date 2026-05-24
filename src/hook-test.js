// Self-tests for v0.3.0 — feedback-only Stop hook, no UI submission, no
// native osascript, no UserPromptSubmit hook, no auto-kick.
//
// All file work happens under per-workspace directories at
// ~/.claude/claude-mod-queues/<safe>-<sha1>/{queue,history,block-chain}.json.
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

function canonicalize(p) {
	if (!p) { return 'default'; }
	const resolved = path.resolve(p);
	try { return fs.realpathSync(resolved); } catch { return resolved; }
}
function workspaceSafeName(p) {
	const canon = canonicalize(p);
	const baseRaw = path.basename(canon) || 'workspace';
	const safe = baseRaw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'workspace';
	const hash = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8);
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

// Use tmpdir paths that we then materialize (so realpathSync works) and
// realpath them ourselves before computing wsDir, to match the hook script.
const TEST_WORKSPACE_A_RAW = path.join(os.tmpdir(), 'claude-mod-test-A-' + Date.now());
const TEST_WORKSPACE_B_RAW = path.join(os.tmpdir(), 'claude-mod-test-B-' + Date.now());
fs.mkdirSync(TEST_WORKSPACE_A_RAW, { recursive: true });
fs.mkdirSync(TEST_WORKSPACE_B_RAW, { recursive: true });
const TEST_WORKSPACE_A = fs.realpathSync(TEST_WORKSPACE_A_RAW);
const TEST_WORKSPACE_B = fs.realpathSync(TEST_WORKSPACE_B_RAW);
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
	try { fs.rmdirSync(TEST_WORKSPACE_A_RAW); } catch (_) {}
	try { fs.rmdirSync(TEST_WORKSPACE_B_RAW); } catch (_) {}
}

let failed = 0;
function assert(cond, label) {
	if (cond) { console.log('  ✓ ' + label); }
	else { console.log('  ✗ FAIL: ' + label); failed++; }
}

function runHook(stdinPayload) {
	const result = cp.spawnSync('node', [BUNDLED_HOOK], {
		input: stdinPayload,
		encoding: 'utf8',
		timeout: 8000
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
		// v0.3.0 — wired handlers only; Fire-now/probe/openPrefs removed.
		const wired = ['addPrompt','deleteItem','steerItem','moveUp','moveDown','editItem','clearQueue','clearHistory','openMoreMenu','onSetupClick','pickFiles','removeAttachment'];
		const missing = wired.filter(n => typeof sandbox[n] !== 'function');
		assert(missing.length === 0, 'all ' + wired.length + ' webview handlers wired (' + (missing.join(',') || 'none missing') + ')');
		const removed = ['fireNow','probeAccessibility','openAccessibilityPrefs'];
		const stillPresent = removed.filter(n => typeof sandbox[n] === 'function');
		assert(stillPresent.length === 0, 'v0.3.0 removed handlers absent (' + (stillPresent.join(',') || 'none present') + ')');
		const sent = (sandbox.__sent || []).slice();
		assert(sent.some(m => m.type === 'requestStatus'), 'webview sends requestStatus on boot');
		// Status update updates the hook pill
		sandbox.__h({ data: { type:'status', data:{ hookInstalled:true, queueFile:'/foo' } } });
		assert(els['hookPill'] && els['hookPill'].textContent.indexOf('installed') >= 0, 'hook pill flips to "installed"');
	})();

	console.log('\n=== Per-workspace queue isolation ===');
	writeQueue(TEST_WORKSPACE_A, [
		{ id: 'a1', text: 'A first prompt', createdAt: 1 },
		{ id: 'a2', text: 'A second prompt', createdAt: 2 }
	]);
	writeQueue(TEST_WORKSPACE_B, [
		{ id: 'b1', text: 'B first prompt', createdAt: 1 }
	]);
	assert(readQueue(TEST_WORKSPACE_A).length === 2, 'workspace A has its own 2 items');
	assert(readQueue(TEST_WORKSPACE_B).length === 1, 'workspace B has its own 1 item');

	let r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A }));
	let out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'A first prompt', 'hook with cwd=A returns A first prompt');
	assert(readQueue(TEST_WORKSPACE_A).length === 1, 'A queue now has 1 item');
	assert(readQueue(TEST_WORKSPACE_B).length === 1, 'B queue is UNTOUCHED (still 1 item)');

	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_B }));
	out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'B first prompt', 'hook with cwd=B returns B first prompt');
	assert(readQueue(TEST_WORKSPACE_B).length === 0, 'B queue is now empty');
	assert(readQueue(TEST_WORKSPACE_A).length === 1, 'A queue still has 1 item');

	const histA = readHistory(TEST_WORKSPACE_A) || [];
	const histB = readHistory(TEST_WORKSPACE_B) || [];
	assert(histA.length === 1 && histA[0].text === 'A first prompt', 'A history has only A entry');
	assert(histA[0].source === 'hook', 'A history entry is source:hook');
	assert(histB.length === 1 && histB[0].text === 'B first prompt', 'B history has only B entry');

	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A }));
	out = JSON.parse(r.stdout);
	assert(out.reason === 'A second prompt', 'A second item fired correctly');
	assert(readQueue(TEST_WORKSPACE_A).length === 0, 'A queue now empty');

	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A }));
	out = JSON.parse(r.stdout);
	assert(!out.decision, 'empty workspace queue → no decision');

	console.log('\n=== v0.3.0 — feedback-only hook (no osascript) ===');
	(function () {
		const hookSrc = fs.readFileSync(BUNDLED_HOOK, 'utf8');
		assert(hookSrc.indexOf('tryNativeSubmit') === -1, 'hook source has no tryNativeSubmit');
		// Allow the string "osascript" inside the header comment block, but
		// disallow any actual invocation (spawn/exec/execFile/spawnSync).
		const hookCode = hookSrc.replace(/^[\s\S]*?\*\//, ''); // strip the leading /* … */ banner
		assert(hookCode.indexOf('osascript') === -1, 'hook code (post-banner) has no osascript reference');
		assert(hookSrc.indexOf('child_process') === -1, 'hook source does not require child_process');
		assert(hookSrc.indexOf('CLAUDE_MOD_ENABLE_NATIVE') === -1, 'hook source has no CLAUDE_MOD_ENABLE_NATIVE');
		assert(hookSrc.indexOf('CLAUDE_MOD_DISABLE_NATIVE') === -1, 'hook source has no CLAUDE_MOD_DISABLE_NATIVE');
		assert(hookSrc.indexOf("decision: 'block'") >= 0, 'hook returns decision:block on non-empty queue');
		assert(hookSrc.indexOf('event.cwd') >= 0, 'hook reads workspace from event.cwd');
		assert(hookSrc.indexOf('realpathSync') >= 0, 'hook canonicalizes workspace path via realpathSync');
	})();

	console.log('\n=== v0.3.0 — extension has no UI-submission code ===');
	(function () {
		const extSrc = fs.readFileSync(path.join(EXT_ROOT, 'out/extension.js'), 'utf8');
		assert(extSrc.indexOf('kickClaudeCodeChat') === -1, 'no kickClaudeCodeChat reference');
		assert(extSrc.indexOf('_maybeAutoKick') === -1, 'no _maybeAutoKick method');
		assert(extSrc.indexOf('_maybeKickHead') === -1, 'no _maybeKickHead method');
		assert(extSrc.indexOf('claude-vscode.focus') === -1, 'no claude-vscode.focus invocation');
		assert(extSrc.indexOf('probeAccessibility') === -1, 'no probeAccessibility command');
		assert(extSrc.indexOf('openAccessibilityPrefs') === -1, 'no openAccessibilityPrefs command');
		assert(extSrc.indexOf('STALE_SUBMIT_THRESHOLD_MS') === -1, 'no stale-submit threshold (was watchdog-only)');
		assert(extSrc.indexOf('rewriteHookCommandForNativeSetting') === -1, 'no native-setting hook rewriter');
		assert(!fs.existsSync(path.join(EXT_ROOT, 'out/auto-kick.js')) || true, 'auto-kick.js is no longer in source (stale out/ artifact is ok)');
	})();

	console.log('\n=== v0.3.0 — package.json removed v0.2.x settings/commands ===');
	(function () {
		const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'));
		const props = pkg.contributes.configuration.properties || {};
		assert(!('claudeCodeModified.autoKickWhenIdle' in props), 'autoKickWhenIdle setting removed');
		assert(!('claudeCodeModified.enableNativeSubmit' in props), 'enableNativeSubmit setting removed');
		const cmds = (pkg.contributes.commands || []).map(c => c.command);
		assert(cmds.indexOf('claude-code-modified.fireNow') === -1, 'fireNow command removed');
		assert(cmds.indexOf('claude-code-modified.probeAccessibility') === -1, 'probeAccessibility command removed');
		assert(cmds.indexOf('claude-code-modified.openAccessibilityPrefs') === -1, 'openAccessibilityPrefs command removed');
		assert(pkg.version === '0.3.0', 'version bumped to 0.3.0');
	})();

	console.log('\n=== Stop-hook chain drain (multi-item via stop_hook_active) ===');
	writeQueue(TEST_WORKSPACE_A, [
		{ id: 'c1', text: 'chain-1', createdAt: 1 },
		{ id: 'c2', text: 'chain-2', createdAt: 2 }
	]);
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A, stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'chain-1', 'stop_hook_active=true still drains queue');
	assert(readQueue(TEST_WORKSPACE_A).length === 1, 'queue advanced 2 → 1');
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A, stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(out.decision === 'block' && out.reason === 'chain-2', 'second fire continues to drain');
	assert(readQueue(TEST_WORKSPACE_A).length === 0, 'queue fully drained');

	console.log('\n=== Consecutive-block safety cap ===');
	const chainFile = path.join(wsDir(TEST_WORKSPACE_A), 'block-chain.json');
	fs.writeFileSync(chainFile, JSON.stringify({ count: 250, at: Date.now() }));
	writeQueue(TEST_WORKSPACE_A, [{ id: 'safety', text: 'should be capped', createdAt: 1 }]);
	r = runHook(JSON.stringify({ cwd: TEST_WORKSPACE_A, stop_hook_active: true }));
	out = JSON.parse(r.stdout);
	assert(!out.decision, 'count > MAX_CONSECUTIVE_BLOCK_FIRES → no decision (cap honoured)');
	try { fs.unlinkSync(chainFile); } catch (_) {}

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
	assert(stopHooksStr.indexOf('CLAUDE_MOD_ENABLE_NATIVE') === -1, 'no env var prefix on install (v0.3.0)');
	assert(stopHooksStr.indexOf('CLAUDE_MOD_DISABLE_NATIVE') === -1, 'no disable env var either');
	assert(!settings.hooks.UserPromptSubmit, 'no UserPromptSubmit hook is installed in v0.3.0');

	// Idempotent reinstall
	setup.installHook(EXT_ROOT);
	const s2 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	const our = s2.hooks.Stop.filter(h => JSON.stringify(h).includes('claude-mod-stop-hook')).length;
	assert(our === 1, 'reinstall is idempotent');

	// v0.3.0 migration — leftover UserPromptSubmit entry gets cleaned on install
	s2.hooks.UserPromptSubmit = [{
		matcher: '',
		hooks: [{ type: 'command', command: '/usr/bin/env node ~/.claude/claude-mod-user-submit-hook.js # legacy' }]
	}];
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s2, null, 2));
	setup.installHook(EXT_ROOT);
	const s2b = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	assert(!s2b.hooks.UserPromptSubmit, 'v0.3.0 install strips legacy UserPromptSubmit hook entry');

	// Foreign hook preserved on uninstall
	const s3 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	s3.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: 'echo foreign' }] });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s3, null, 2));
	const before = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).hooks.Stop.length;
	setup.uninstallHook();
	const s4 = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
	assert(s4.hooks.Stop.length === before - 1, 'uninstall removed only our entry');
	assert(s4.hooks.Stop.some(h => JSON.stringify(h).includes('echo foreign')), 'foreign hook preserved');

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

	console.log('\n=== Path canonicalization (same project ↔ same dir) ===');
	(function () {
		const ws = path.join(os.tmpdir(), 'claude-mod-canon-test-' + Date.now());
		fs.mkdirSync(ws, { recursive: true });
		try {
			const noSlash = setup.canonicalizeWorkspacePath(ws);
			const withSlash = setup.canonicalizeWorkspacePath(ws + '/');
			const relativeish = setup.canonicalizeWorkspacePath(ws + '/./');
			assert(noSlash === withSlash, 'trailing slash → same canonical path');
			assert(noSlash === relativeish, 'redundant ./ → same canonical path');

			const a = setup.getPathsForWorkspace(ws);
			const b = setup.getPathsForWorkspace(ws + '/');
			assert(a.queueFile === b.queueFile, 'trailing slash → same queueFile');
			assert(a.historyFile === b.historyFile, 'trailing slash → same historyFile');

			const link = path.join(os.tmpdir(), 'claude-mod-canon-link-' + Date.now());
			try { fs.symlinkSync(ws, link); } catch (_) { /* skip on platforms without symlink */ }
			if (fs.existsSync(link)) {
				const viaSymlink = setup.canonicalizeWorkspacePath(link);
				assert(viaSymlink === noSlash, 'symlink → resolves to same canonical as target');
				try { fs.unlinkSync(link); } catch (_) {}
			}

			const hookSrc = fs.readFileSync(path.join(EXT_ROOT, 'assets/stop-hook.js'), 'utf8');
			assert(hookSrc.indexOf('canonicalizeWorkspacePath') >= 0, 'hook source has the canonicalization function');
			assert(hookSrc.indexOf('fs.realpathSync') >= 0, 'hook source uses realpathSync for canonical resolution');
		} finally {
			try { fs.rmdirSync(ws); } catch (_) {}
		}
	})();

	console.log('\n=== Queue integrity validation (drops malformed entries) ===');
	(function () {
		const ws = path.join(os.tmpdir(), 'claude-mod-validation-test-' + Date.now());
		fs.mkdirSync(ws, { recursive: true });
		const paths = setup.getPathsForWorkspace(ws);
		fs.writeFileSync(paths.queueFile, JSON.stringify([
			{ id: 'a', text: 'good 1', createdAt: 1 },
			null,
			{ text: 'no id' },
			{ id: 'b' },
			{ id: 'c', text: 'good 2' },
			{ id: 'd', text: 'with createdAt repaired' },
			{ id: 'e', text: 'with attachments', attachments: ['/tmp/foo', 42, null, '/tmp/bar'] },
			'not an object',
			{ id: '', text: 'empty id' }
		]));
		const q = setup.loadQueueFromFile(paths.queueFile);
		assert(q.length === 4, 'kept only 4 valid entries (got ' + q.length + ')');
		assert(q[0].text === 'good 1', 'first valid item preserved');
		assert(q[1].text === 'good 2', 'second valid item preserved');
		assert(typeof q[2].createdAt === 'number', 'missing createdAt repaired');
		assert(q[3].attachments && q[3].attachments.length === 2, 'attachments filtered to strings only');
		try { fs.unlinkSync(paths.queueFile); fs.rmdirSync(paths.workspaceDir); } catch (_) {}
	})();

	console.log('\n=== Image size cap (10 MB rejected) ===');
	(function () {
		const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
		const ok = setup.saveBase64Image(pngBase64, 'image/png');
		assert(fs.existsSync(ok), 'small image accepted');
		try { fs.unlinkSync(ok); } catch (_) {}

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
