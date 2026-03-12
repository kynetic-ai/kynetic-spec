import { parse as parseYaml } from 'yaml';
import type {
	BatchItemSummary,
	BatchSpecItemSummary,
	BatchTaskSummary,
	PlanDetail,
	PlanSummary
} from '@kynetic-ai/shared';

type PlanLike = Pick<PlanSummary, 'derived_specs' | 'derived_tasks'>;

interface MarkdownBlock {
	type: 'markdown';
	markdown: string;
}

interface EmbeddedBlockBase {
	type: 'embedded';
	embedType: 'spec' | 'task';
	rawMarkdown: string;
	refs: string[];
}

interface EmbeddedLoadingBlock extends EmbeddedBlockBase {
	state: 'loading';
}

interface EmbeddedErrorBlock extends EmbeddedBlockBase {
	state: 'error';
	errorMessage: string;
}

interface EmbeddedReadyBlock extends EmbeddedBlockBase {
	state: 'ready';
	items: BatchSpecItemSummary[] | BatchTaskSummary[];
}

export type PlanContentBlock =
	| MarkdownBlock
	| EmbeddedLoadingBlock
	| EmbeddedErrorBlock
	| EmbeddedReadyBlock;

interface EmbeddedCandidate {
	type: 'embedded-candidate';
	embedType: 'spec' | 'task';
	rawMarkdown: string;
	refs: string[];
}

function normalizeRef(ref: string | null | undefined): string | null {
	if (!ref) return null;
	return ref.startsWith('@') ? ref.slice(1) : ref;
}

function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

function collectRefAliases(ref: string): string[] {
	const normalized = normalizeRef(ref);
	return normalized ? [normalized, ref, normalized.toUpperCase()] : [ref];
}

function createBatchLookup(items: BatchItemSummary[]): Map<string, BatchItemSummary> {
	const lookup = new Map<string, BatchItemSummary>();

	for (const item of items) {
		for (const key of collectRefAliases(item.ulid)) {
			lookup.set(key, item);
		}
		for (const slug of item.slugs) {
			for (const key of collectRefAliases(slug)) {
				lookup.set(key, item);
			}
		}
	}

	return lookup;
}

function resolveDerivedRef(refs: string[], slug: string): string | null {
	const normalizedSlug = normalizeRef(slug);
	if (!normalizedSlug) return null;

	for (const ref of refs) {
		const normalizedRef = normalizeRef(ref);
		if (!normalizedRef) continue;
		if (normalizedRef === normalizedSlug || normalizedRef.toUpperCase() === normalizedSlug.toUpperCase()) {
			return ref.startsWith('@') ? ref : `@${normalizedRef}`;
		}
	}

	return null;
}

function extractSlugsFromYamlArray(source: string): string[] | null {
	try {
		const parsed = parseYaml(source);
		if (!Array.isArray(parsed)) return null;

		const slugs = parsed
			.map((entry) => {
				if (!entry || typeof entry !== 'object') return undefined;

				const candidate = entry as { slug?: unknown; title?: unknown };
				if (typeof candidate.slug === 'string' && candidate.slug.length > 0) {
					return candidate.slug;
				}
				if (typeof candidate.title === 'string' && candidate.title.trim().length > 0) {
					return slugify(candidate.title);
				}
				return undefined;
			})
			.filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);

		return slugs.length > 0 ? slugs : null;
	} catch {
		return null;
	}
}

function hasDeriveFromSpecsDirective(source: string): boolean {
	try {
		const parsed = parseYaml(source);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return (parsed as { derive_from_specs?: unknown }).derive_from_specs === true;
		}
	} catch {
		// Fall back to textual detection for incomplete or malformed YAML snippets.
	}

	return /(?:^|\n)\s*derive_from_specs\s*:\s*true\s*$/im.test(source);
}

function detectEmbeddedCandidate(
	sectionHeading: string | null,
	rawMarkdown: string,
	code: string,
	sectionContext: string,
	plan: PlanLike
): EmbeddedCandidate | null {
	if (sectionHeading === 'specs') {
		const slugs = extractSlugsFromYamlArray(code);
		if (!slugs) return null;

		const refs = slugs
			.map((slug) => resolveDerivedRef(plan.derived_specs, slug))
			.filter((ref): ref is string => Boolean(ref));

		if (refs.length !== slugs.length || refs.length === 0) return null;
		return { type: 'embedded-candidate', embedType: 'spec', rawMarkdown, refs };
	}

	if (sectionHeading === 'tasks') {
		const deriveFromSpecs =
			hasDeriveFromSpecsDirective(code) || hasDeriveFromSpecsDirective(sectionContext);
		if (deriveFromSpecs && plan.derived_tasks.length > 0) {
			return {
				type: 'embedded-candidate',
				embedType: 'task',
				rawMarkdown,
				refs: [...plan.derived_tasks]
			};
		}

		const slugs = extractSlugsFromYamlArray(code);
		if (slugs) {
			const refs = slugs
				.map((slug) => resolveDerivedRef(plan.derived_tasks, slug))
				.filter((ref): ref is string => Boolean(ref));

			if (refs.length === slugs.length && refs.length > 0) {
				return { type: 'embedded-candidate', embedType: 'task', rawMarkdown, refs };
			}
		}

	}

	return null;
}

function flushMarkdown(buffer: string[], blocks: PlanContentBlock[]) {
	const markdown = buffer.join('\n').trim();
	if (markdown) {
		blocks.push({ type: 'markdown', markdown });
	}
	buffer.length = 0;
}

function parsePlanContentCandidates(content: string, plan: PlanLike): Array<MarkdownBlock | EmbeddedCandidate> {
	const lines = content.split('\n');
	const blocks: Array<MarkdownBlock | EmbeddedCandidate> = [];
	const markdownBuffer: string[] = [];
	const sectionContext: string[] = [];
	let currentH2: string | null = null;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		const headingMatch = line.match(/^##\s+(.+?)\s*$/);

		if (headingMatch) {
			currentH2 = headingMatch[1]?.trim().toLowerCase() ?? null;
			sectionContext.length = 0;
			markdownBuffer.push(line);
			sectionContext.push(line);
			continue;
		}

		const fenceMatch = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
		if (!fenceMatch) {
			markdownBuffer.push(line);
			sectionContext.push(line);
			continue;
		}

		const blockLines = [line];
		let closed = false;

		for (index += 1; index < lines.length; index += 1) {
			const nextLine = lines[index] ?? '';
			blockLines.push(nextLine);
			if (/^```\s*$/.test(nextLine)) {
				closed = true;
				break;
			}
		}

		const rawMarkdown = blockLines.join('\n');
		const language = fenceMatch[1]?.toLowerCase() ?? '';
		const code = closed ? blockLines.slice(1, -1).join('\n') : blockLines.slice(1).join('\n');

		if ((language === 'yaml' || language === 'yml') && currentH2) {
			const candidate = detectEmbeddedCandidate(
				currentH2,
				rawMarkdown,
				code,
				sectionContext.join('\n'),
				plan
			);
			if (candidate) {
				flushMarkdown(markdownBuffer, blocks as PlanContentBlock[]);
				blocks.push(candidate);
				sectionContext.push(rawMarkdown);
				continue;
			}
		}

		markdownBuffer.push(rawMarkdown);
		sectionContext.push(rawMarkdown);
	}

	flushMarkdown(markdownBuffer, blocks as PlanContentBlock[]);
	return blocks;
}

export function buildPlanContentBlocks(
	plan: PlanDetail,
	options: {
		batchItems?: BatchItemSummary[];
		batchLoading?: boolean;
		batchError?: string;
	}
): PlanContentBlock[] {
	if (!plan.content) return [];

	const batchLookup = createBatchLookup(options.batchItems ?? []);
	const candidates = parsePlanContentCandidates(plan.content, plan);
	const blocks: PlanContentBlock[] = [];

	for (const block of candidates) {
		if (block.type === 'markdown') {
			blocks.push(block);
			continue;
		}

		if (options.batchLoading) {
			blocks.push({
				type: 'embedded',
				embedType: block.embedType,
				rawMarkdown: block.rawMarkdown,
				refs: block.refs,
				state: 'loading'
			});
			continue;
		}

		if (options.batchError) {
			blocks.push({
				type: 'embedded',
				embedType: block.embedType,
				rawMarkdown: block.rawMarkdown,
				refs: block.refs,
				state: 'error',
				errorMessage: options.batchError
			});
			continue;
		}

		const items = block.refs
			.map((ref) => {
				const normalized = normalizeRef(ref);
				if (!normalized) return null;
				return batchLookup.get(normalized) ?? batchLookup.get(normalized.toUpperCase()) ?? null;
			})
			.filter((item): item is BatchItemSummary => Boolean(item));

		if (items.length !== block.refs.length) {
			blocks.push({ type: 'markdown', markdown: block.rawMarkdown });
			continue;
		}

		if (block.embedType === 'spec' && items.every((item) => item.kind === 'item')) {
			blocks.push({
				type: 'embedded',
				embedType: block.embedType,
				rawMarkdown: block.rawMarkdown,
				refs: block.refs,
				state: 'ready',
				items: items as BatchSpecItemSummary[]
			});
			continue;
		}

		if (block.embedType === 'task' && items.every((item) => item.kind === 'task')) {
			blocks.push({
				type: 'embedded',
				embedType: block.embedType,
				rawMarkdown: block.rawMarkdown,
				refs: block.refs,
				state: 'ready',
				items: items as BatchTaskSummary[]
			});
			continue;
		}

		blocks.push({ type: 'markdown', markdown: block.rawMarkdown });
	}

	return blocks;
}
