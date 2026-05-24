import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Type a prompt into Anthropic's Claude Code chat input via macOS scripting.
 *
 * Strategy:
 *   1. Activate the VS Code app so it has focus.
 *   2. Send ⌘ Esc — Anthropic's documented shortcut to focus their chat input
 *      (you can see this hint in their input box placeholder: "⌘ Esc to focus
 *      or unfocus Claude").
 *   3. Write the prompt to a temp file, read it back via osascript, set the
 *      clipboard from that, then paste — this keeps multi-line, unicode, and
 *      special-character text intact (much more reliable than `keystroke
 *      "long text"`).
 *   4. Press Return to submit.
 *
 * First time this runs, macOS prompts the user to grant Accessibility
 * permission to VS Code (or to "osascript" depending on signing). If the user
 * denies, this function returns success=false with the underlying error so
 * the extension can surface a fallback (e.g. copy-to-clipboard + notification).
 */
export interface KickResult {
	success: boolean;
	error?: string;
}

export interface KickOptions {
	// If true, skip the ⌘ Esc keystroke that focuses Claude's chat input
	// (used when the caller has already focused via the
	// `claude-vscode.focus` VS Code command, which bypasses the
	// keybinding's when-clause and works regardless of where focus is).
	skipFocusKeystroke?: boolean;
}

export async function kickClaudeCodeChat(text: string, options?: KickOptions): Promise<KickResult> {
	if (process.platform !== 'darwin') {
		return { success: false, error: 'Auto-kick currently supports macOS only (osascript).' };
	}
	if (!text || !text.trim()) {
		return { success: false, error: 'Empty text — nothing to kick.' };
	}

	// Stash the text in a temp file. The AppleScript reads it back into a
	// variable and sets the clipboard from it. This avoids the nightmare of
	// escaping multi-line strings inside an osascript command-line argument.
	const tmpFile = path.join(os.tmpdir(), 'claude-mod-kick-' + Date.now() + '-' + Math.floor(Math.random() * 100000) + '.txt');
	try {
		fs.writeFileSync(tmpFile, text);
	} catch (err: any) {
		return { success: false, error: 'Could not write kick temp file: ' + err.message };
	}

	// Escape the path for AppleScript — backslash + double quote
	const escapedPath = tmpFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

	// If the extension already focused Claude's chat via the
	// `claude-vscode.focus` VS Code command, skip the ⌘ Esc keystroke.
	// (Anthropic's keybinding for ⌘ Esc has a `when` clause of
	// "!useTerminal && editorTextFocus" — when our webview's Fire-now
	// button has focus, that's NOT in an editor, so the keystroke is
	// silently dropped and our paste lands in the wrong control.
	// executeCommand bypasses the when-clause and focuses unconditionally.)
	const skipFocus = !!(options && options.skipFocusKeystroke);
	const focusStanza = skipFocus
		? '-- focus already obtained via vscode.commands.executeCommand("claude-vscode.focus")'
		: 'keystroke (ASCII character 27) using {command down}\n\t\t\t\tdelay 0.25';

	const script = `
		try
			set kickFile to POSIX file "${escapedPath}"
			set kickContents to (read kickFile as «class utf8»)
			set the clipboard to kickContents
			tell application "Visual Studio Code" to activate
			delay 0.3
			tell application "System Events"
				${focusStanza}
				-- Paste
				keystroke "v" using {command down}
				delay 0.25
				-- Submit
				key code 36
			end tell
			return "ok"
		on error errMsg number errNum
			return "ERR " & errNum & ": " & errMsg
		end try
	`;

	return new Promise((resolve) => {
		cp.execFile(
			'osascript',
			['-e', script],
			{ timeout: 7000 },
			(err, stdout, stderr) => {
				// Best-effort cleanup of the temp file. Don't fail the whole
				// op if unlink fails.
				try { fs.unlinkSync(tmpFile); } catch (_) { /* noop */ }

				if (err) {
					resolve({ success: false, error: (stderr || err.message || String(err)).toString().trim() });
					return;
				}
				const out = (stdout || '').toString().trim();
				if (out.startsWith('ERR')) {
					resolve({ success: false, error: out });
				} else {
					resolve({ success: true });
				}
			}
		);
	});
}
