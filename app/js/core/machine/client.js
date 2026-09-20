/**
 * The REST client. One function per endpoint, and one way to fail.
 *
 * `fetch` is injected rather than reached for, so the whole client is testable
 * without a network and without a DOM — which matters here more than usual,
 * because the interesting behaviour is what happens when the plotter does not
 * answer, and that is hard to arrange on purpose with a real one.
 *
 * Every failure arrives as an ApiError carrying the firmware's stable slug, so
 * the UI can tell "you have not homed yet" from "the cable fell out" without
 * reading prose. See docs/API.md.
 */

/** A request that reached the plotter and was refused, or never arrived. */
export class ApiError extends Error {
  constructor(slug, message, status = 0) {
    super(message);
    this.name = 'ApiError';
    /** Stable, machine-readable. `offline` when nothing answered. */
    this.slug = slug;
    this.status = status;
  }

  /** Nothing answered: a plotter that is off, asleep, or on another network. */
  get offline() {
    return this.slug === 'offline';
  }
}

/** How long to wait before deciding nothing is going to answer. */
export const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Wrap a fetch so a hung request fails rather than hanging the UI.
 *
 * A plotter that has lost power does not refuse connections, it simply never
 * answers — so without a deadline the status poll would stop coming back and
 * the app would sit there looking connected forever.
 */
async function withTimeout(promise, ms, signalAbort) {
  let timer = null;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          signalAbort?.();
          reject(new ApiError('offline', 'The plotter did not answer.'));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function createClient({
  fetch: fetchImpl,
  base = '/api',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function request(method, path, { json, body, timeout } = {}) {
    const url = `${base}${path}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;

    const options = { method, signal: controller?.signal };

    if (json !== undefined) {
      options.headers = { 'content-type': 'application/json' };
      options.body = JSON.stringify(json);
    } else if (body !== undefined) {
      // Gcode goes up as-is; the firmware streams it to the card.
      options.headers = { 'content-type': 'text/plain' };
      options.body = body;
    }

    let response;

    try {
      response = await withTimeout(
        fetchImpl(url, options),
        timeout ?? timeoutMs,
        () => controller?.abort()
      );
    } catch (problem) {
      if (problem instanceof ApiError) throw problem;
      // A network-level failure is indistinguishable from an absent plotter,
      // and for the user's purposes it is the same thing.
      throw new ApiError('offline', 'The plotter could not be reached.');
    }

    if (response.status === 204) return null;

    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new ApiError(
        payload?.error ?? 'http_error',
        payload?.message ?? `The plotter returned ${response.status}.`,
        response.status
      );
    }

    return payload;
  }

  return {
    request,

    status: () => request('GET', '/status'),

    listFiles: () => request('GET', '/files'),
    // A long upload needs longer than a status poll: a megabyte over the
    // Pico's WiFi is measured in seconds, not milliseconds.
    upload: (name, gcode, timeout = 120_000) =>
      request('POST', `/files/${encodeURIComponent(name)}`, { body: gcode, timeout }),
    deleteFile: (name) => request('DELETE', `/files/${encodeURIComponent(name)}`),

    start: (file, settings) => request('POST', '/job/start', { json: { file, settings } }),
    pause: () => request('POST', '/job/pause'),
    resume: () => request('POST', '/job/resume'),
    stop: () => request('POST', '/job/stop'),

    jog: (dx, dy, feed) => request('POST', '/jog', { json: { dx, dy, feed } }),
    seed: (options) => request('POST', '/position/seed', { json: options }),

    captureCorner: (index, paperPoint) =>
      request('POST', '/calibration/corner', { json: { index, paperPoint } }),
    solveCalibration: () => request('POST', '/calibration/solve'),
    // The gondola drives to the fourth corner, so this takes as long as a jog.
    verifyCalibration: (timeout = 60_000) =>
      request('POST', '/calibration/verify', { timeout }),
    confirmCalibration: (accepted) =>
      request('POST', '/calibration/confirm', { json: { accepted } }),

    getConfig: () => request('GET', '/config'),
    setConfig: (changes) => request('PUT', '/config', { json: changes }),
  };
}
