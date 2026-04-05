import { promises as fs } from 'fs';
import path from 'path';

export type OrganizeMode = 'flat' | 'by-year' | 'by-year-month';

export interface OrganizerProgress {
	type: 'progress';
	phase: 'scanning' | 'copying' | 'done';
	current: number;
	total: number;
	message: string;
}

export interface OrganizerResult {
	type: 'result';
	result: {
		totalPhotos: number;
		skipped: number;
		outputPath: string;
		albums: string[];
	};
}

export interface OrganizerError {
	type: 'error';
	message: string;
}

export type OrganizerEvent = OrganizerProgress | OrganizerResult | OrganizerError;

// ── helpers ────────────────────────────────────────────────────────────────

const PHOTO_EXT = new Set([
	'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif', 'tiff', 'tif', 'raw',
	'arw', 'cr2', 'cr3', 'nef', 'orf', 'raf', 'rw2', 'dng', 'svg'
]);
const VIDEO_EXT = new Set([
	'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'm4v', '3gp', 'webm', 'mpg', 'mpeg', 'mts', 'm2ts'
]);

function isMedia(filename: string): boolean {
	const ext = filename.split('.').pop()?.toLowerCase() ?? '';
	return PHOTO_EXT.has(ext) || VIDEO_EXT.has(ext);
}

interface PhotoMeta {
	photoTakenTime?: number;
	creationTime?: number;
}

function parseMeta(raw: string): PhotoMeta | null {
	try {
		const data = JSON.parse(raw);
		const meta: PhotoMeta = {};
		if (data.photoTakenTime?.timestamp) meta.photoTakenTime = parseInt(data.photoTakenTime.timestamp, 10);
		if (data.creationTime?.timestamp) meta.creationTime = parseInt(data.creationTime.timestamp, 10);
		return meta;
	} catch {
		return null;
	}
}

function sidecarCandidates(filePath: string): string[] {
	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const candidates: string[] = [];
	candidates.push(path.join(dir, base + '.json'));
	const lastDot = base.lastIndexOf('.');
	if (lastDot > 0) {
		candidates.push(path.join(dir, base.slice(0, lastDot) + '.json'));
	}
	// supplement-style: photo(1).jpg -> photo.jpg(1).json
	const parenMatch = base.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
	if (parenMatch) {
		candidates.push(path.join(dir, `${parenMatch[1]}${parenMatch[3]}(${parenMatch[2]}).json`));
	}
	return candidates;
}

function dateFolder(date: Date, mode: OrganizeMode): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	if (mode === 'flat') return '';
	if (mode === 'by-year') return String(y);
	return `${y}/${y}-${m}`;
}

function uniqueOutPath(used: Set<string>, relPath: string): string {
	if (!used.has(relPath)) { used.add(relPath); return relPath; }
	const lastSlash = relPath.lastIndexOf('/');
	const prefix = lastSlash >= 0 ? relPath.slice(0, lastSlash + 1) : '';
	const basename = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;
	const dot = basename.lastIndexOf('.');
	const base = dot >= 0 ? basename.slice(0, dot) : basename;
	const ext = dot >= 0 ? basename.slice(dot) : '';
	let i = 1;
	let candidate: string;
	do { candidate = `${prefix}${base}(${i})${ext}`; i++; } while (used.has(candidate));
	used.add(candidate);
	return candidate;
}

async function walkDir(dir: string): Promise<string[]> {
	const results: string[] = [];
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...await walkDir(fullPath));
		} else if (entry.isFile()) {
			results.push(fullPath);
		}
	}
	return results;
}

function albumFromPath(filePath: string, sourceRoot: string): string {
	const rel = path.relative(sourceRoot, filePath);
	const parts = rel.split(path.sep);
	const gpIdx = parts.findIndex(
		(p) => p.toLowerCase().includes('google photos') || p.toLowerCase().includes('google foto')
	);
	if (gpIdx >= 0 && parts.length > gpIdx + 2) return parts[gpIdx + 1];
	if (parts.length >= 2) return parts[parts.length - 2];
	return 'Photos';
}

// ── main export ────────────────────────────────────────────────────────────

export async function* organizeFolder(
	sourcePath: string,
	outputPath: string,
	mode: OrganizeMode
): AsyncGenerator<OrganizerEvent> {
	// Validate source path
	let stat;
	try {
		stat = await fs.stat(sourcePath);
	} catch {
		yield { type: 'error', message: `Source path does not exist: ${sourcePath}` };
		return;
	}
	if (!stat.isDirectory()) {
		yield { type: 'error', message: `Source path is not a directory: ${sourcePath}` };
		return;
	}

	// Prevent writing output inside source to avoid infinite recursion
	const resolvedSource = path.resolve(sourcePath);
	const resolvedOutput = path.resolve(outputPath);
	if (resolvedOutput.startsWith(resolvedSource + path.sep) || resolvedOutput === resolvedSource) {
		yield { type: 'error', message: 'Output path must not be inside the source folder.' };
		return;
	}

	yield { type: 'progress', phase: 'scanning', current: 0, total: 0, message: 'Scanning source folder…' };

	const allFiles = await walkDir(resolvedSource);
	const mediaPaths = allFiles.filter((f) => isMedia(path.basename(f)));

	if (mediaPaths.length === 0) {
		yield { type: 'error', message: 'No media files found in the source folder.' };
		return;
	}

	await fs.mkdir(resolvedOutput, { recursive: true });

	const usedPaths = new Set<string>();
	const albumSet = new Set<string>();
	let processed = 0;
	let skipped = 0;

	for (const mediaPath of mediaPaths) {
		processed++;
		yield {
			type: 'progress',
			phase: 'copying',
			current: processed,
			total: mediaPaths.length,
			message: `Copying ${path.basename(mediaPath)}…`
		};

		albumSet.add(albumFromPath(mediaPath, resolvedSource));

		// Read sidecar JSON for date
		let meta: PhotoMeta | null = null;
		for (const candidate of sidecarCandidates(mediaPath)) {
			try {
				const raw = await fs.readFile(candidate, 'utf8');
				meta = parseMeta(raw);
				if (meta) break;
			} catch { /* not found */ }
		}

		let takenAt: Date;
		if (meta?.photoTakenTime) {
			takenAt = new Date(meta.photoTakenTime * 1000);
		} else if (meta?.creationTime) {
			takenAt = new Date(meta.creationTime * 1000);
		} else {
			const info = await fs.stat(mediaPath);
			takenAt = info.mtime;
		}

		const folder = dateFolder(takenAt, mode);
		const relOut = uniqueOutPath(
			usedPaths,
			folder ? `${folder}/${path.basename(mediaPath)}` : path.basename(mediaPath)
		);
		const destPath = path.join(resolvedOutput, relOut);

		try {
			await fs.mkdir(path.dirname(destPath), { recursive: true });
			await fs.copyFile(mediaPath, destPath);
			const tsSeconds = takenAt.getTime() / 1000;
			await fs.utimes(destPath, tsSeconds, tsSeconds);
		} catch {
			skipped++;
		}
	}

	yield {
		type: 'progress',
		phase: 'done',
		current: mediaPaths.length,
		total: mediaPaths.length,
		message: `Done! Copied ${processed - skipped} files.`
	};

	yield {
		type: 'result',
		result: {
			totalPhotos: processed - skipped,
			skipped,
			outputPath: resolvedOutput,
			albums: Array.from(albumSet).sort()
		}
	};
}
