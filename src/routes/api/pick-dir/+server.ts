import type { RequestHandler } from './$types';
import { execFile, type ExecFileException } from 'child_process';

function tryPicker(cmd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(cmd, args, (err: ExecFileException | null, stdout: string) => {
			if (err) {
				// err.code 'ENOENT' = command not installed; non-zero exit = user cancelled
				resolve(null);
			} else {
				const p = stdout.trim().replace(/\/$/, '');
				resolve(p || null);
			}
		});
	});
}

async function pickDirectory(): Promise<string | null> {
	if (process.platform === 'linux') {
		// Try zenity (GNOME / most distros)
		const zenity = await tryPicker('zenity', [
			'--file-selection',
			'--directory',
			'--title=Select folder'
		]);
		if (zenity !== null) return zenity;

		// Fallback to kdialog (KDE)
		return tryPicker('kdialog', ['--getexistingdirectory', '/']);
	}

	if (process.platform === 'darwin') {
		const result = await tryPicker('osascript', [
			'-e',
			'POSIX path of (choose folder with prompt "Select folder")'
		]);
		return result?.replace(/\/$/, '') ?? null;
	}

	return null;
}

export const GET: RequestHandler = async () => {
	const selected = await pickDirectory();

	if (selected === null) {
		return new Response(
			JSON.stringify({ error: 'No folder selected or native picker not available on this platform.' }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	return new Response(JSON.stringify({ path: selected }), {
		headers: { 'Content-Type': 'application/json' }
	});
};
