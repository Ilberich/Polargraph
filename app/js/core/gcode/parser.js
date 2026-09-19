/**
 * Gcode → moves.
 *
 * Feeds three things: importing externally generated gcode, the on-canvas
 * preview, and the scrubber. Each needs to know where the tool was and where it
 * is going, so moves are emitted with both endpoints rather than as raw
 * commands the caller would have to integrate itself.
 *
 * The parser is modal, because the dialect is: a line may set only the axes
 * that change, and everything else carries over.
 */

const WORD = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;

/**
 * Strip comments from a line.
 *
 * Both gcode comment forms: `;` to end of line, and `(...)` inline.
 */
export function stripComments(line) {
  const semicolon = line.indexOf(';');
  const withoutTrailing = semicolon === -1 ? line : line.slice(0, semicolon);

  return withoutTrailing.replace(/\([^)]*\)/g, ' ');
}

/** Parse the words on one line into `{G: 1, X: 10, ...}`. */
export function parseWords(line) {
  const words = {};
  WORD.lastIndex = 0;

  let match;
  while ((match = WORD.exec(line)) !== null) {
    words[match[1].toUpperCase()] = Number(match[2]);
  }

  return words;
}

/**
 * Parse gcode into a flat list of records.
 *
 * Records are one of:
 *   `{type: 'move', rapid, from, to, feed, line}`
 *   `{type: 'pause' | 'home' | 'end', line}`
 *
 * `line` is the 1-based source line, so the scrubber and the machine's
 * reported progress can be matched up.
 *
 * Unknown commands are skipped rather than rejected: files from other tools
 * carry codes this machine has no use for, and dropping them is better than
 * refusing the file.
 */
export function parseGcode(source) {
  const records = [];

  let position = { x: 0, y: 0, z: 0 };
  let feed = 0;
  let absolute = true;

  const lines = String(source ?? '').split(/\r?\n/);

  lines.forEach((raw, index) => {
    const words = parseWords(stripComments(raw));
    const lineNumber = index + 1;

    if ('G' in words) {
      const g = words.G;

      if (g === 90) {
        absolute = true;
      } else if (g === 91) {
        absolute = false;
      } else if (g === 28) {
        // No endstops: G28 returns to the calibrated home corner, whose
        // position this parser cannot know. Recorded, not simulated.
        records.push({ type: 'home', line: lineNumber });
      } else if (g === 0 || g === 1) {
        if ('F' in words) feed = words.F;

        const to = {
          x: 'X' in words ? (absolute ? words.X : position.x + words.X) : position.x,
          y: 'Y' in words ? (absolute ? words.Y : position.y + words.Y) : position.y,
          z: 'Z' in words ? (absolute ? words.Z : position.z + words.Z) : position.z,
        };

        // A line that repeats the current position moves nothing. Keeping it
        // would put zero-length segments in the preview and the time estimate.
        const moved = to.x !== position.x || to.y !== position.y || to.z !== position.z;

        if (moved) {
          records.push({
            type: 'move',
            rapid: g === 0,
            from: position,
            to,
            feed,
            line: lineNumber,
          });
          position = to;
        }
      }
    }

    if ('M' in words) {
      if (words.M === 0) {
        records.push({ type: 'pause', line: lineNumber });
      } else if (words.M === 2 || words.M === 30) {
        records.push({ type: 'end', line: lineNumber });
      }
    }
  });

  return records;
}

/**
 * Group parsed gcode back into paths.
 *
 * A rapid starts a new stroke and a controlled move extends it, which is the
 * inverse of how the writer lays paths out. This is what makes imported gcode
 * editable on the canvas rather than merely viewable.
 */
export function gcodeToPaths(source) {
  const records = parseGcode(source);
  const paths = [];
  let current = null;

  const flush = () => {
    if (current && current.points.length > 1) paths.push(current);
    current = null;
  };

  for (const record of records) {
    if (record.type !== 'move') {
      // A pause or program end breaks the stroke.
      if (record.type !== 'home') flush();
      continue;
    }

    if (record.rapid) {
      flush();
      current = { points: [record.to], closed: false, meta: {} };
    } else {
      if (!current) current = { points: [record.from], closed: false, meta: {} };
      current.points.push(record.to);
    }
  }

  flush();
  return paths;
}

/** Total XY distance, split by move kind. Z changes do not move the gondola. */
export function measureGcode(source) {
  let draw = 0;
  let travel = 0;

  for (const record of parseGcode(source)) {
    if (record.type !== 'move') continue;

    const distance = Math.hypot(
      record.to.x - record.from.x,
      record.to.y - record.from.y
    );

    if (record.rapid) travel += distance;
    else draw += distance;
  }

  return { draw, travel, total: draw + travel };
}
