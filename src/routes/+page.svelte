<script lang="ts">
	type OrganizeMode = "flat" | "by-year" | "by-year-month";

	interface ProgressEvent {
		type: "progress";
		phase: "scanning" | "copying" | "done";
		current: number;
		total: number;
		message: string;
	}
	interface ResultData {
		totalPhotos: number;
		skipped: number;
		outputPath: string;
		albums: string[];
	}
	interface ResultEvent {
		type: "result";
		result: ResultData;
	}
	interface ErrorEvent {
		type: "error";
		message: string;
	}
	type OrganizerEvent = ProgressEvent | ResultEvent | ErrorEvent;

	// --- State ---
	let sourcePath = $state("");
	let outputPath = $state("");
	let organizeMode = $state<OrganizeMode>("by-year-month");
	let isProcessing = $state(false);
	let progress = $state<ProgressEvent | null>(null);
	let result = $state<ResultData | null>(null);
	let error = $state<string | null>(null);

	let progressPct = $derived(
		progress && progress.total > 0
			? Math.round((progress.current / progress.total) * 100)
			: 0,
	);

	let canProcess = $derived(
		sourcePath.trim() !== "" && outputPath.trim() !== "" && !isProcessing,
	);

	function reset() {
		result = null;
		error = null;
		progress = null;
	}

	function startProcessing() {
		if (!canProcess) return;

		isProcessing = true;
		result = null;
		error = null;
		progress = null;

		const params = new URLSearchParams({
			source: sourcePath.trim(),
			output: outputPath.trim(),
			mode: organizeMode,
		});

		const es = new EventSource(`/api/process?${params}`);

		es.onmessage = (e) => {
			try {
				const event: OrganizerEvent = JSON.parse(e.data);
				if (event.type === "progress") {
					progress = event;
				} else if (event.type === "result") {
					result = event.result;
					isProcessing = false;
					es.close();
				} else if (event.type === "error") {
					error = event.message;
					isProcessing = false;
					es.close();
				}
			} catch {
				/* ignore */
			}
		};

		es.onerror = () => {
			if (isProcessing) {
				error =
					"Lost connection to the local server. Is `npm run dev` still running?";
				isProcessing = false;
			}
			es.close();
		};
	}
</script>

<svelte:head>
	<title>Google Photos Takeout Helper</title>
</svelte:head>

<div class="min-h-screen bg-gray-950 text-gray-100 font-sans">
	<!-- Header -->
	<header class="border-b border-gray-800 bg-gray-900 px-6 py-4">
		<div class="mx-auto max-w-3xl flex items-center gap-3">
			<span class="text-3xl select-none">📸</span>
			<div>
				<h1 class="text-xl font-bold text-white leading-tight">
					Google Photos Takeout Helper
				</h1>
				<p class="text-sm text-gray-400">
					Organize your extracted Takeout photos by date — runs
					entirely on your machine
				</p>
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-3xl px-6 py-10 space-y-8">
		<!-- How it works -->
		<section class="rounded-xl bg-gray-900 border border-gray-800 p-6">
			<h2
				class="text-sm font-semibold uppercase tracking-wider text-blue-400 mb-4"
			>
				How it works
			</h2>
			<ol
				class="space-y-2 text-sm text-gray-300 list-decimal list-inside"
			>
				<li>
					Export your photos at <a
						href="https://takeout.google.com"
						target="_blank"
						rel="noopener noreferrer"
						class="text-blue-400 underline hover:text-blue-300"
						>takeout.google.com</a
					>
					— select <strong>Google Photos only</strong>
				</li>
				<li>Download and extract all the ZIP files Google sends you</li>
				<li>
					Enter the path to the extracted <code class="text-gray-300"
						>Google Photos</code
					> folder below
				</li>
				<li>
					Choose an output folder and how to organize, then click <strong
						>Process</strong
					>
				</li>
				<li>
					Files are copied and organized directly on disk — no browser
					limits, no download needed
				</li>
			</ol>
			<p class="mt-4 text-xs text-gray-500">
				Processing runs on the local server. No data ever leaves your
				machine.
			</p>
		</section>

		<!-- Paths -->
		<section
			class="rounded-xl bg-gray-900 border border-gray-800 p-6 space-y-5"
		>
			<h2
				class="text-sm font-semibold uppercase tracking-wider text-blue-400"
			>
				1. Folders
			</h2>

			<div class="space-y-1.5">
				<label
					for="source-path"
					class="block text-sm text-gray-300 font-medium"
				>
					Source folder <span class="text-gray-500 font-normal"
						>(your extracted Google Photos folder)</span
					>
				</label>
				<input
					id="source-path"
					type="text"
					placeholder="/home/you/Takeout/Google Photos"
					class="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-2.5 text-sm text-gray-100
						placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
						disabled:opacity-50"
					bind:value={sourcePath}
					disabled={isProcessing}
				/>
			</div>

			<div class="space-y-1.5">
				<label
					for="output-path"
					class="block text-sm text-gray-300 font-medium"
				>
					Output folder <span class="text-gray-500 font-normal"
						>(will be created if it doesn't exist)</span
					>
				</label>
				<input
					id="output-path"
					type="text"
					placeholder="/home/you/Photos/Organized"
					class="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-2.5 text-sm text-gray-100
						placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
						disabled:opacity-50"
					bind:value={outputPath}
					disabled={isProcessing}
				/>
			</div>
		</section>

		<!-- Organization mode -->
		<section
			class="rounded-xl bg-gray-900 border border-gray-800 p-6 space-y-4"
		>
			<h2
				class="text-sm font-semibold uppercase tracking-wider text-blue-400"
			>
				2. Organization
			</h2>
			<div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
				{#each [{ value: "flat", label: "📁 Flat", desc: "All photos in one folder" }, { value: "by-year", label: "📅 By Year", desc: "Sub-folders per year" }, { value: "by-year-month", label: "🗓️ By Month", desc: "Year/Year-Month folders" }] as opt (opt.value)}
					<button
						class="rounded-lg border p-4 text-left transition-colors
							{organizeMode === opt.value
							? 'border-blue-500 bg-blue-950/40 text-white'
							: 'border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-500'}"
						onclick={() =>
							(organizeMode = opt.value as OrganizeMode)}
						disabled={isProcessing}
					>
						<div class="font-semibold text-sm">{opt.label}</div>
						<div class="text-xs mt-1 text-gray-400">{opt.desc}</div>
					</button>
				{/each}
			</div>
		</section>

		<!-- Process -->
		<section
			class="rounded-xl bg-gray-900 border border-gray-800 p-6 space-y-4"
		>
			<h2
				class="text-sm font-semibold uppercase tracking-wider text-blue-400"
			>
				3. Process
			</h2>

			<button
				class="w-full rounded-lg py-3 px-6 font-semibold text-base transition-all
					{!canProcess
					? 'bg-gray-700 text-gray-500 cursor-not-allowed'
					: 'bg-blue-600 hover:bg-blue-500 text-white active:scale-[0.99]'}"
				onclick={startProcessing}
				disabled={!canProcess}
			>
				{isProcessing ? "Processing…" : "🚀 Process Photos"}
			</button>

			{#if isProcessing && progress}
				<div class="space-y-2">
					<div class="flex justify-between text-xs text-gray-400">
						<span class="truncate pr-2">{progress.message}</span>
						<span class="shrink-0">{progressPct}%</span>
					</div>
					<div class="h-2 rounded-full bg-gray-700 overflow-hidden">
						<div
							class="h-full rounded-full bg-blue-500 transition-all duration-200"
							style="width: {progressPct}%"
						></div>
					</div>
					<div class="text-xs text-gray-500 capitalize">
						{progress.phase}…
					</div>
				</div>
			{/if}

			{#if error}
				<div
					class="rounded-lg bg-red-950/50 border border-red-800 p-4 text-sm text-red-300"
				>
					<span class="font-semibold">Error: </span>{error}
					<button
						class="ml-3 underline text-red-400 hover:text-red-200 text-xs"
						onclick={reset}>Dismiss</button
					>
				</div>
			{/if}

			{#if result && !isProcessing}
				<div
					class="rounded-lg bg-green-950/40 border border-green-800 p-4 space-y-3"
				>
					<div
						class="flex items-center gap-2 text-green-300 font-semibold"
					>
						<span>✅</span> Processing complete!
					</div>
					<div class="grid grid-cols-2 gap-2 text-sm">
						<div class="rounded bg-gray-800 p-3">
							<div class="text-gray-400 text-xs">
								Photos copied
							</div>
							<div class="text-white font-bold text-lg">
								{result.totalPhotos}
							</div>
						</div>
						<div class="rounded bg-gray-800 p-3">
							<div class="text-gray-400 text-xs">
								Skipped / errors
							</div>
							<div class="text-white font-bold text-lg">
								{result.skipped}
							</div>
						</div>
					</div>
					<div class="rounded bg-gray-800 p-3 text-sm break-all">
						<span class="text-gray-400 text-xs block mb-1"
							>Output location</span
						>
						<code class="text-green-300">{result.outputPath}</code>
					</div>
					{#if result.albums.length > 0}
						<div class="text-xs text-gray-400">
							<span class="font-medium text-gray-300"
								>Albums found:</span
							>
							{result.albums.join(", ")}
						</div>
					{/if}
				</div>
			{/if}
		</section>

		<!-- Tips -->
		<section
			class="rounded-xl bg-gray-900 border border-gray-800 p-6 text-sm text-gray-400 space-y-2"
		>
			<h2
				class="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3"
			>
				Tips
			</h2>
			<ul class="space-y-1.5 list-disc list-inside">
				<li>
					Extract all Google Takeout ZIPs first — they all contain
					parts of the same <code class="text-gray-300"
						>Google Photos</code
					> folder structure.
				</li>
				<li>
					Each photo has a matching <code class="text-gray-300"
						>.json</code
					> sidecar with its original capture time. This app uses those
					for correct date-based sorting.
				</li>
				<li>
					Files are <strong>copied</strong>, not moved — your
					originals are always preserved.
				</li>
				<li>The output folder must not be inside the source folder.</li>
			</ul>
		</section>
	</main>

	<footer
		class="text-center text-xs text-gray-600 py-8 border-t border-gray-800"
	>
		Inspired by <a
			href="https://github.com/TheLastGimbus/GooglePhotosTakeoutHelper"
			target="_blank"
			rel="noopener noreferrer"
			class="underline hover:text-gray-400">GooglePhotosTakeoutHelper</a
		>
		&nbsp;·&nbsp; All processing is local — nothing leaves your machine.
	</footer>
</div>
