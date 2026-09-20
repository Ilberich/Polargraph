import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createConnection, intervalFor, FAILURES_BEFORE_OFFLINE, CONNECTED, OFFLINE } from './connection.js';
import { ApiError } from './client.js';

/** A client whose status call does whatever the test queued next. */
function fakeClient(...answers) {
  let index = 0;

  return {
    status: async () => {
      const answer = answers[Math.min(index++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const idle = { state: 'idle', positionTrusted: true };
const running = { state: 'running', positionTrusted: true };
const gone = new ApiError('offline', 'nothing answered');

test('a good poll connects', async () => {
  const connection = createConnection({ client: fakeClient(idle) });
  const view = await connection.poll();

  assert.equal(view.connection, CONNECTED);
  assert.equal(view.machineState, 'idle');
  assert.equal(view.stale, false);
});

test('one missed poll is not a disconnection', async () => {
  // WiFi drops a packet; a Pico is busy writing to the card. Going offline on
  // the first failure would have the UI flickering through a plot.
  const connection = createConnection({ client: fakeClient(idle, gone) });

  await connection.poll();
  const view = await connection.poll();

  assert.equal(view.connection, CONNECTED, 'still believed to be there');
  assert.equal(view.stale, true, 'but what is shown is no longer current');
  assert.deepEqual(view.status, idle);
});

test('a run of failures is', async () => {
  const connection = createConnection({ client: fakeClient(idle, gone, gone, gone) });

  await connection.poll();
  for (let i = 0; i < FAILURES_BEFORE_OFFLINE; i++) await connection.poll();

  const view = connection.view();
  assert.equal(view.connection, OFFLINE);
  assert.equal(view.status, null, 'nothing is claimed about a machine that is gone');
  assert.equal(view.machineState, 'offline');
});

test('a plotter that comes back is connected again, and not stale', async () => {
  const answers = [idle, gone, gone, gone, running];
  const connection = createConnection({ client: fakeClient(...answers) });

  for (let i = 0; i < 4; i++) await connection.poll();
  assert.equal(connection.view().connection, OFFLINE);

  const view = await connection.poll();
  assert.equal(view.connection, CONNECTED);
  assert.equal(view.stale, false);
  assert.equal(view.machineState, 'running');
});

test('changes are announced, and unchanged polls are not', async () => {
  // So a UI can rebuild from onChange without redrawing five times a second.
  const seen = [];
  const connection = createConnection({
    client: fakeClient(idle, idle, running),
    onChange: (view) => seen.push(view.machineState),
  });

  await connection.poll();
  await connection.poll();
  await connection.poll();

  assert.deepEqual(seen, ['idle', 'running']);
});

test('polling slows down when nothing is happening', async () => {
  // The Pico has better things to do with its radio while it plots, and an
  // idle machine does not need asking every second.
  assert.ok(intervalFor('running') < intervalFor('idle'));
  assert.ok(intervalFor('paused') < intervalFor('idle'));
  assert.equal(intervalFor('nonsense'), intervalFor('idle'));
});

test('a command folds its answer straight into the view', async () => {
  // Every control endpoint answers with the same shape /status does, so a
  // button does something visible without waiting for the next poll.
  const connection = createConnection({ client: fakeClient(idle) });
  await connection.poll();

  const result = await connection.command(async () => running);

  assert.equal(result.ok, true);
  assert.equal(connection.view().machineState, 'running');
});

test('a refused command is reported without dropping the connection', async () => {
  const connection = createConnection({ client: fakeClient(idle) });
  await connection.poll();

  const refusal = new ApiError('untrusted_position', 'seed first', 409);
  const result = await connection.command(async () => { throw refusal; });

  assert.equal(result.ok, false);
  assert.equal(result.error.slug, 'untrusted_position');
  assert.equal(connection.view().connection, CONNECTED, 'the plotter answered, it just said no');
});

test('a command that finds nothing there counts against the connection', async () => {
  const connection = createConnection({ client: fakeClient(idle) });
  await connection.poll();

  for (let i = 0; i < FAILURES_BEFORE_OFFLINE; i++) {
    await connection.command(async () => { throw gone; });
  }

  assert.equal(connection.view().connection, OFFLINE);
});

test('stopping the loop stops the polling', async () => {
  let polls = 0;
  const connection = createConnection({
    client: { status: async () => { polls += 1; return idle; } },
  });

  connection.start();
  await new Promise((r) => setTimeout(r, 30));
  connection.stop();

  const after = polls;
  await new Promise((r) => setTimeout(r, 60));

  assert.ok(after >= 1, 'it polled at least once');
  assert.equal(polls, after, 'and stopped when told to');
});
