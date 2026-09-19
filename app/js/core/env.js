/**
 * Runtime environment detection.
 *
 * Implements AD-1: the same bundle is served from two places, and only one of
 * them can talk to the plotter. A page served over HTTPS cannot fetch a
 * plaintext endpoint on the local network — browsers block it as active mixed
 * content, with no user override. So the GitHub Pages copy is a design tool
 * only, and machine control lives at the plotter's own address.
 *
 * Detecting this up front lets the app say so plainly, instead of offering a
 * connection form that could only ever fail.
 */

/** Default mDNS hostname the firmware advertises. */
export const DEFAULT_PLOTTER_HOST = 'polargraph.local';

/** Machine control is available; the API is same-origin. */
export const CAPABLE = 'capable';

/** Served over HTTPS. Mixed content blocks any request to a plaintext device. */
export const BLOCKED_HTTPS = 'blocked-https';

/** Opened straight off disk. The origin is opaque, so cross-origin requests fail. */
export const BLOCKED_FILE = 'blocked-file';

/**
 * Classify a location for machine-control capability.
 *
 * Takes a location-like object rather than reading the global, so it is
 * testable without a DOM.
 *
 * @param {{protocol: string}} location
 * @returns {string} one of CAPABLE, BLOCKED_HTTPS, BLOCKED_FILE
 */
export function classifyOrigin(location) {
  switch (location.protocol) {
    case 'http:':
      return CAPABLE;
    case 'https:':
      return BLOCKED_HTTPS;
    default:
      return BLOCKED_FILE;
  }
}

/**
 * Describe what this page can do and why.
 *
 * @param {{protocol: string}} location
 * @returns {{capability: string, canReachPlotter: boolean, apiBase: string|null, reason: string|null}}
 */
export function describeEnvironment(location) {
  const capability = classifyOrigin(location);
  const canReachPlotter = capability === CAPABLE;

  return {
    capability,
    canReachPlotter,
    // Same-origin when served from the plotter, so there is no CORS case.
    apiBase: canReachPlotter ? '/api' : null,
    reason: canReachPlotter ? null : REASONS[capability],
  };
}

const REASONS = {
  [BLOCKED_HTTPS]:
    'This page is served over HTTPS, which browsers forbid from contacting a ' +
    'plain-HTTP device on your network. Open the app from the plotter itself ' +
    'to use machine control.',
  [BLOCKED_FILE]:
    'This page was opened directly from disk, so it has no origin the plotter ' +
    'will accept. Open the app from the plotter itself to use machine control.',
};

/** The address to send the user to when this origin cannot reach the plotter. */
export function plotterUrl(host = DEFAULT_PLOTTER_HOST) {
  return `http://${host}`;
}
