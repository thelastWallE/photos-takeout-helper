import type { RequestHandler } from './$types';
import { organizeFolder, type OrganizeMode } from '$lib/server/organizer';

export const GET: RequestHandler = ({ url }) => {
	const source = url.searchParams.get('source') ?? '';
	const output = url.searchParams.get('output') ?? '';
	const modeParam = url.searchParams.get('mode') ?? 'by-year-month';

	const VALID_MODES = new Set<string>(['flat', 'by-year', 'by-year-month']);
	const mode: OrganizeMode = VALID_MODES.has(modeParam)
		? (modeParam as OrganizeMode)
		: 'by-year-month';

	if (!source || !output) {
		return new Response('Missing source or output parameter', { status: 400 });
	}

	const enc = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (data: object) => {
				controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
			};

			try {
				for await (const event of organizeFolder(source, output, mode)) {
					send(event);
					if (event.type === 'result' || event.type === 'error') break;
				}
			} catch (e) {
				send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
			}

			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
