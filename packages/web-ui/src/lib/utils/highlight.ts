import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('go', go);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('css', css);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('java', java);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('diff', diff);

hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['py'], { languageName: 'python' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });
hljs.registerAliases(['htm', 'xml'], { languageName: 'html' });
hljs.registerAliases(['c++'], { languageName: 'cpp' });
hljs.registerAliases(['golang'], { languageName: 'go' });
hljs.registerAliases(['patch'], { languageName: 'diff' });

export const SUPPORTED_MARKDOWN_LANGUAGES = [
	'bash',
	'typescript',
	'javascript',
	'python',
	'rust',
	'go',
	'json',
	'yaml',
	'sql',
	'css',
	'html',
	'java',
	'c',
	'cpp',
	'diff'
] as const;

export function normalizeLanguage(language?: string | null): string | undefined {
	if (!language) return undefined;
	const normalized = language.toLowerCase().trim().replace(/^language-/, '');
	if (!normalized) return undefined;

	if (normalized === 'sh' || normalized === 'shell' || normalized === 'zsh') return 'bash';
	if (normalized === 'ts' || normalized === 'tsx') return 'typescript';
	if (normalized === 'js' || normalized === 'jsx') return 'javascript';
	if (normalized === 'py') return 'python';
	if (normalized === 'yml') return 'yaml';
	if (normalized === 'htm' || normalized === 'xml') return 'html';
	if (normalized === 'c++') return 'cpp';
	if (normalized === 'golang') return 'go';
	if (normalized === 'patch') return 'diff';

	return normalized;
}

export function isLanguageSupported(language?: string | null): boolean {
	const normalized = normalizeLanguage(language);
	return normalized ? hljs.getLanguage(normalized) !== undefined : false;
}

export function highlightCode(code: string, language?: string | null): string {
	const normalized = normalizeLanguage(language);

	if (normalized && hljs.getLanguage(normalized)) {
		try {
			return hljs.highlight(code, { language: normalized }).value;
		} catch {
			// Fall through to auto detection.
		}
	}

	try {
		return hljs.highlightAuto(code).value;
	} catch {
		return escapeHtml(code);
	}
}

export function highlightCodeBlocks(root: ParentNode): void {
	for (const codeBlock of root.querySelectorAll('pre code')) {
		if (!(codeBlock instanceof HTMLElement)) continue;

		const language = getCodeBlockLanguage(codeBlock);
		const source = codeBlock.textContent ?? '';
		if (!source.trim()) continue;

		codeBlock.innerHTML = highlightCode(source, language);
		codeBlock.classList.add('hljs');

		const normalized = normalizeLanguage(language);
		if (normalized) {
			codeBlock.classList.add(`language-${normalized}`);
			codeBlock.dataset.language = normalized;
		}
	}
}

export function getCodeBlockLanguage(codeBlock: HTMLElement): string | undefined {
	const explicit = codeBlock.dataset.language;
	if (explicit) return explicit;

	const languageClass = Array.from(codeBlock.classList).find((value) => value.startsWith('language-'));
	return languageClass ? languageClass.slice('language-'.length) : undefined;
}

function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
