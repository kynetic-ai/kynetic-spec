import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const webUiRoot = path.join(repoRoot, 'packages', 'web-ui');
const appCssPath = path.join(webUiRoot, 'src', 'app.css');
const messageBlockPath = path.join(webUiRoot, 'src', 'lib', 'components', 'session', 'MessageBlock.svelte');
const plansPagePath = path.join(webUiRoot, 'src', 'routes', 'plans', '+page.svelte');
let builtCssCache: string | undefined;

function buildWebUi(): string {
	if (builtCssCache) {
		return builtCssCache;
	}

	execFileSync('npm', ['--workspace', 'packages/web-ui', 'run', 'build'], {
		cwd: repoRoot,
		stdio: 'pipe',
		encoding: 'utf8'
	});

	const assetDir = path.join(webUiRoot, 'build', '_app', 'immutable', 'assets');
	if (!existsSync(assetDir)) {
		throw new Error(`Expected build asset directory at ${assetDir}`);
	}

	const cssFile = execFileSync('bash', ['-lc', `ls ${JSON.stringify(assetDir)}/*.css | head -n 1`], {
		cwd: repoRoot,
		encoding: 'utf8'
	}).trim();

	if (!cssFile) {
		throw new Error('Expected at least one built CSS asset');
	}

	builtCssCache = readFileSync(cssFile, 'utf8');
	return builtCssCache;
}

describe('prose typography setup', () => {
	// AC: @prose-typography-setup ac-1
	it('uses prose containers with dark-mode inversion on markdown surfaces', () => {
		const messageBlock = readFileSync(messageBlockPath, 'utf8');
		const plansPage = readFileSync(plansPagePath, 'utf8');

		expect(messageBlock).toContain('prose prose-sm dark:prose-invert max-w-none');
		expect(plansPage).toContain('prose prose-sm dark:prose-invert max-w-none');
	});

	// AC: @prose-typography-setup ac-1
	// AC: @prose-typography-setup ac-2
	it(
		'includes Tailwind typography styles in the built CSS bundle',
		() => {
		const appCss = readFileSync(appCssPath, 'utf8');
		expect(appCss).toContain('@plugin "@tailwindcss/typography";');

		const builtCss = buildWebUi();
		expect(builtCss).toContain('.prose');
		expect(builtCss).toContain('blockquote');
		expect(builtCss).toContain('table');
		expect(builtCss).toContain('.dark\\:prose-invert');
		},
		30_000
	);
});
