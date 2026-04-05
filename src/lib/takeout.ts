import JSZip from 'jszip';

export interface PhotoMeta {
	title: string;
	description?: string;
	photoTakenTime?: number; // unix seconds
	creationTime?: number;
	latitude?: number;
	longitude?: number;
}

export interface ProcessedPhoto {
	filename: string;
	blob: Blob;
	takenAt: Date;
	albumName: string;
	originalPath: string;
}

export interface ExtractionProgress {
	phase: 'reading' | 'extracting' | 'organizing' | 'done';
	current: number;
	total: number;
	message: string;
}

export type ProgressCallback = (p: ExtractionProgress) => void;
export type OrganizeMode = 'flat' | 'by-year' | 'by-year-month';

const PHOTO_EXTENSIONS = new Set([
	'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'heic', 'heif', 'tiff', 'tif', 'raw',
	'arw', 'cr2', 'cr3', 'nef', 'orf', 'raf', 'rw2', 'dng', 'svg'
]);
const VIDEO_EXTENSIONS = new Set([
	'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'm4v', '3gp', 'webm', 'mpg', 'mpeg', 'mts', 'm2ts'
]);

function isMedia(filename: string): boolean {
	const ext = filename.split('.').pop()?.toLowerCase() ?? '';
	return PHOTO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

function isJsonMeta(filename: string): boolean {
	return filename.toLowerCase().endsWith('.json');
}

/** Parse Google Photos sidecar JSON */
function parseMeta(raw: string): PhotoMeta | null {
	try {
		const data = JSON.parse(raw);
		const meta: PhotoMeta = { title: data.title ?? '' };
		if (data.description) meta.description = data.description;
		if (data.photoTakenTime?.timestamp) {
			meta.photoTakenTime = parseInt(data.photoTakenTime.timestamp, 10);
		}
		if (data.creationTime?.timestamp) {
			meta.creationTime = parseInt(data.creationTime.timestamp, 10);
		}
		if (data.geoData?.latitude) {
			meta.latitude = data.geoData.latitude;
			meta.longitude = data.geoData.longitude;
		} else if (data.geoDataExif?.latitude) {
			meta.latitude = data.geoDataExif.latitude;
			meta.longitude = data.geoDataExif.longitude;
		}
		return meta;
	} catch {
		return null;
	}
}

/** Find possible JSON sidecar paths for a given media file path */
function sidecarCandidates(filePath: string): string[] {
	// Google Photos names sidecars like: photo.jpg.json or photo.json
	// Also truncates long filenames, so photo(1).jpg -> photo(1).jpg.json OR photo.jpg(1).json
	const candidates: string[] = [];
	candidates.push(filePath + '.json');
	// If filename has extension, also try basename.json
	const lastDot = filePath.lastIndexOf('.');
	if (lastDot > 0) {
		candidates.push(filePath.substring(0, lastDot) + '.json');
	}
	// supplement-style: photo(1).jpg -> photo.jpg(1).json
	const parenMatch = filePath.match(/^(.*)\((\d+)\)(\.[^.]+)$/);
	if (parenMatch) {
		candidates.push(`${parenMatch[1]}${parenMatch[3]}(${parenMatch[2]}).json`);
	}
	return candidates;
}

/** Derive album name from the path inside the zip */
function albumFromPath(relativePath: string): string {
	// Structure: Takeout/Google Photos/<Album>/<file>
	const parts = relativePath.split('/');
	// Find "Google Photos" segment
	const gpIdx = parts.findIndex(
		(p) => p.toLowerCase().includes('google photos') || p.toLowerCase().includes('google foto')
	);
	if (gpIdx >= 0 && parts.length > gpIdx + 2) {
		return parts[gpIdx + 1];
	}
	// Fallback: second-to-last path component
	if (parts.length >= 2) return parts[parts.length - 2];
	return 'Photos';
}

/** Format date for folder path */
function dateFolder(date: Date, mode: OrganizeMode): string {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	if (mode === 'flat') return '';
	if (mode === 'by-year') return `${y}`;
	return `${y}/${y}-${m}`;
}

/** Deduplicate output filenames */
function uniqueFilename(used: Set<string>, name: string): string {
	if (!used.has(name)) {
		used.add(name);
		return name;
	}
	const dot = name.lastIndexOf('.');
	const base = dot >= 0 ? name.slice(0, dot) : name;
	const ext = dot >= 0 ? name.slice(dot) : '';
	let i = 1;
	let candidate: string;
	do {
		candidate = `${base}(${i})${ext}`;
		i++;
	} while (used.has(candidate));
	used.add(candidate);
	return candidate;
}

export interface ExtractionResult {
	outputZip: Blob;
	totalPhotos: number;
	skipped: number;
	albums: string[];
}

export async function processTakeoutZips(
	files: File[],
	organizeMode: OrganizeMode,
	onProgress: ProgressCallback
): Promise<ExtractionResult> {
	// Phase 1: Scan each zip ONE AT A TIME and collect sidecar JSON metadata.
	// Never hold more than one zip in memory to avoid exhausting browser memory
	// with large multi-part takeouts (e.g. 5 × 2 GB).
	const metaIndex = new Map<string, PhotoMeta>();
	// Also record which media paths live in which file, so phase 2 can skip
	// re-scanning the directory.
	const mediaPathsByFile: string[][] = [];
	let totalMedia = 0;

	onProgress({ phase: 'reading', current: 0, total: files.length, message: 'Scanning zip files…' });

	for (let i = 0; i < files.length; i++) {
		onProgress({
			phase: 'reading',
			current: i + 1,
			total: files.length,
			message: `Scanning ${files[i].name}…`
		});

		const zip = await JSZip.loadAsync(files[i]);
		const mediaPaths: string[] = [];
		const jsonTasks: Promise<void>[] = [];

		zip.forEach((path, obj) => {
			if (obj.dir) return;
			const filename = path.split('/').pop() ?? '';
			if (isMedia(filename)) {
				mediaPaths.push(path);
			} else if (isJsonMeta(filename)) {
				jsonTasks.push(
					obj.async('string').then((raw) => {
						const meta = parseMeta(raw);
						if (meta) metaIndex.set(path, meta);
					})
				);
			}
		});

		await Promise.all(jsonTasks);
		mediaPathsByFile.push(mediaPaths);
		totalMedia += mediaPaths.length;
		// zip falls out of scope here; GC can reclaim the 2 GB ArrayBuffer
	}

	// Phase 2: Extract media from each zip ONE AT A TIME, looking up sidecars
	// from the already-collected metaIndex (which is tiny in comparison).
	const outputZip = new JSZip();
	const usedFilenames = new Set<string>();
	const albumSet = new Set<string>();
	let skipped = 0;
	let processed = 0;

	for (let i = 0; i < files.length; i++) {
		const mediaPaths = mediaPathsByFile[i];
		if (mediaPaths.length === 0) continue;

		onProgress({
			phase: 'extracting',
			current: processed,
			total: totalMedia,
			message: `Extracting from ${files[i].name}…`
		});

		const zip = await JSZip.loadAsync(files[i]);

		for (const mediaPath of mediaPaths) {
			processed++;
			onProgress({
				phase: 'organizing',
				current: processed,
				total: totalMedia,
				message: `Processing ${mediaPath.split('/').pop() ?? ''}…`
			});

			const mediaObj = zip.file(mediaPath)!;
			const filename = mediaPath.split('/').pop()!;
			const album = albumFromPath(mediaPath);
			albumSet.add(album);

			// Find sidecar JSON (already parsed in phase 1)
			let meta: PhotoMeta | null = null;
			for (const candidate of sidecarCandidates(mediaPath)) {
				const m = metaIndex.get(candidate);
				if (m) { meta = m; break; }
			}

			// Determine date
			let takenAt: Date;
			if (meta?.photoTakenTime) {
				takenAt = new Date(meta.photoTakenTime * 1000);
			} else if (meta?.creationTime) {
				takenAt = new Date(meta.creationTime * 1000);
			} else {
				// Fall back to zip entry lastModDate
				takenAt = (mediaObj as JSZip.JSZipObject & { date?: Date }).date ?? new Date(0);
			}

			// Determine output path
			const folder = dateFolder(takenAt, organizeMode);
			const outName = uniqueFilename(usedFilenames, folder ? `${folder}/${filename}` : filename);

			// Copy file data into output zip
			const data = await mediaObj.async('arraybuffer');
			outputZip.file(outName, data, { date: takenAt });
		}
		// zip falls out of scope here; GC can reclaim the 2 GB ArrayBuffer
	}

	onProgress({
		phase: 'done',
		current: totalMedia,
		total: totalMedia,
		message: `Done! Processed ${processed} files.`
	});

	const blob = await outputZip.generateAsync({
		type: 'blob',
		compression: 'DEFLATE',
		compressionOptions: { level: 1 } // fast, since media is already compressed
	});

	return {
		outputZip: blob,
		totalPhotos: processed - skipped,
		skipped,
		albums: Array.from(albumSet).sort()
	};
}
