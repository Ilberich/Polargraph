/**
 * Knowing whether there is a plotter, and what it is doing.
 *
 * A polling loop with two jobs beyond fetching: deciding when "connected"
 * stops being true, and not lying in the meantime.
 *
 * **One missed poll is not a disconnection.** WiFi drops a packet, a Pico is
 * busy writing to the card — both produce a failed request from a machine that
 * is perfectly fine. Going offline on the first failure would have the UI
 * flickering through a plot. So it takes a run of failures, and until then the
 * last known status stands with a note that it is stale.
 *
 * **Polling slows down when nothing is happening.** A plotter sitting idle does
 * not need asking every second, and the Pico has better things to do with its
 * radio while it is plotting.
 */

import { ApiError } from './client.js';

export const OFFLINE = 'offline';
export const CONNECTED = 'connected';

/** Failures in a row before the plotter is called gone. */
export const FAILURES_BEFORE_OFFLINE = 3;

/** How often to ask, by what the machine is doing. */
export const INTERVALS_MS = {
  running: 1000,
  paused: 2000,
  idle: 5000,
  offline: 5000,
};

export function intervalFor(state) {
  return INTERVALS_MS[state] ?? INTERVALS_MS.idle;
}

/**
 * Create a connection to one plotter.
 *
 * `onChange` is called whenever the view of the machine changes — not on every
 * poll, so a UI can rebuild itself from it without redrawing five times a
 * second.
 */
export function createConnection({ client, onChange = () => {}, now = Date.now } = {}) {
  const state = {
    connection: OFFLINE,
    status: null,
    /** True when `status` is the last thing we heard, not the current truth. */
    stale: false,
    error: null,
    failures: 0,
    lastSeen: null,
  };

  let timer = null;
  let running = false;

  function view() {
    return {
      connection: state.connection,
      status: state.status,
      stale: state.stale,
      error: state.error,
      lastSeen: state.lastSeen,
      machineState: state.status?.state ?? OFFLINE,
    };
  }

  function announce(changed) {
    if (changed) onChange(view());
  }

  function succeed(status) {
    const changed =
      state.connection !== CONNECTED ||
      state.stale ||
      JSON.stringify(state.status) !== JSON.stringify(status);

    state.connection = CONNECTED;
    state.status = status;
    state.stale = false;
    state.error = null;
    state.failures = 0;
    state.lastSeen = now();

    announce(changed);
  }

  function fail(problem) {
    state.failures += 1;

    const gone = state.failures >= FAILURES_BEFORE_OFFLINE;
    const changed = gone
      ? state.connection !== OFFLINE
      : !state.stale && state.status !== null;

    if (gone) {
      state.connection = OFFLINE;
      state.status = null;
      state.stale = false;
    } else if (state.status !== null) {
      // Keep showing what we last knew, and say that is what it is.
      state.stale = true;
    }

    state.error = problem instanceof ApiError ? problem : new ApiError('offline', String(problem));
    announce(changed);
  }

  async function poll() {
    try {
      succeed(await client.status());
    } catch (problem) {
      fail(problem);
    }

    return view();
  }

  function schedule() {
    if (!running) return;

    const delay = intervalFor(
      state.connection === OFFLINE ? OFFLINE : state.status?.state ?? 'idle'
    );

    timer = setTimeout(tick, delay);
  }

  async function tick() {
    timer = null;
    await poll();
    schedule();
  }

  return {
    view,
    poll,

    start() {
      if (running) return;

      running = true;
      tick();
    },

    stop() {
      running = false;

      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    /**
     * Run a command and fold the status it returns back in.
     *
     * Every control endpoint answers with the same shape `/status` does, so
     * acting on the machine updates the view without waiting for the next
     * poll — the button does something visible immediately.
     */
    async command(action) {
      try {
        const status = await action(client);
        if (status && typeof status === 'object' && 'state' in status) succeed(status);

        return { ok: true, status };
      } catch (problem) {
        if (problem instanceof ApiError && problem.offline) fail(problem);
        else {
          state.error = problem;
          announce(true);
        }

        return { ok: false, error: problem };
      }
    },
  };
}
