/**
 * Where the pen is, part way through a job.
 *
 * The timeline the estimator builds already says when every move starts and
 * how long it takes, so watching a plot back is a matter of asking it what is
 * happening at a given second. Nothing here re-models anything: if the
 * scrubber and the estimate ever disagreed, one of them would be lying.
 */

/** The entry in progress at `seconds`, or the last one once the job is over. */
export function entryAt({ entries }, seconds) {
  if (entries.length === 0) return -1;

  let low = 0;
  let high = entries.length - 1;

  // The entries are in time order, so the one in progress is a search away
  // rather than a scan — this is asked on every frame of playback.
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (entries[middle].start <= seconds) low = middle;
    else high = middle - 1;
  }

  return low;
}

/**
 * Where the pen is, and what it is doing.
 *
 * `index` is how far the job has got: every entry before it is finished, and
 * the one at it is part way through.
 */
export function positionAt(timeline, seconds) {
  const { entries, totalSeconds } = timeline;
  if (entries.length === 0) return null;

  const clamped = Math.max(0, Math.min(seconds, totalSeconds));
  const index = entryAt(timeline, clamped);
  const entry = entries[index];

  if (entry.kind === 'pause') {
    // Standing where the last move left the gondola, waiting for a pen.
    const previous = lastMoveBefore(entries, index);

    return {
      x: previous ? previous.to.x : 0,
      y: previous ? previous.to.y : 0,
      index,
      fraction: 0,
      state: 'paused',
    };
  }

  const fraction = entry.seconds > 0
    ? Math.max(0, Math.min(1, (clamped - entry.start) / entry.seconds))
    : 1;

  return {
    x: entry.from.x + (entry.to.x - entry.from.x) * fraction,
    y: entry.from.y + (entry.to.y - entry.from.y) * fraction,
    index,
    fraction,
    state: entry.rapid ? 'travelling' : 'drawing',
  };
}

function lastMoveBefore(entries, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (entries[i].kind === 'move') return entries[i];
  }

  return null;
}

/**
 * How far through the job a moment is, as a fraction.
 *
 * Time, not distance: a plot spends its time where the reversals are, and a
 * progress bar measured in millimetres would race through a hatch fill and
 * crawl along a straight line.
 */
export function progressAt(timeline, seconds) {
  if (!(timeline.totalSeconds > 0)) return 0;
  return Math.max(0, Math.min(1, seconds / timeline.totalSeconds));
}
