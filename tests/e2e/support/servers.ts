/** Where the two servers of the end-to-end suite listen (see playwright.config.ts). */

export const PREVIEW_PORT = 4173;
export const SUBPATH_PORT = 5173;

/** `vite preview` of the production build, at the root of its origin. */
export const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;

/** The path GitHub Pages gives a project site: the repository name. */
export const SUBPATH = '/PDF-/';

/** The same build served the way GitHub Pages serves it (tests/e2e/support/static-server.mjs). */
export const SUBPATH_URL = `http://127.0.0.1:${SUBPATH_PORT}${SUBPATH}`;

/**
 * A browser that sends this cookie to the sub-path server gets a service worker script that
 * differs from the built one by a trailing comment: to that browser, a new version of the app.
 */
export const SW_VERSION_COOKIE = 'e2e-sw-version';
