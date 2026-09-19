/**
 * Which build this is.
 *
 * Rewritten by the deploy workflow to the commit it published. Left as `dev`
 * when running from a working copy.
 *
 * It exists because a browser serving stale JavaScript looks exactly like a
 * bug that was never fixed, and there is otherwise no way — for a user or for
 * me — to tell the two apart.
 */
export const BUILD = 'dev';
