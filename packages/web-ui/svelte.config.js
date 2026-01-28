import adapter from '@sveltejs/adapter-static';

// Base path for GitHub Pages deployment (set via BASE_PATH env var)
const basePath = process.env.BASE_PATH || '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter({
			// Output directory for static build (to be embedded in daemon)
			pages: 'build',
			assets: 'build',
			// Use 404.html for GitHub Pages SPA routing (GH Pages serves this for missing routes)
			// For local daemon, index.html would work but 404.html is compatible with both
			fallback: '404.html',
			precompress: false,
			strict: true
		}),
		paths: {
			// Set base path for GitHub Pages (empty for daemon/local)
			base: basePath
		}
	}
};

export default config;
