import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient, ApiError } from './client.js';

/** A fetch that answers whatever the test says, and records what it was asked. */
function fakeFetch(responder) {
  const calls = [];

  const impl = async (url, options) => {
    calls.push({ url, ...options });
    return responder(url, options);
  };

  impl.calls = calls;
  return impl;
}

const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('a status call goes to the documented path', async () => {
  const fetchImpl = fakeFetch(() => ok({ state: 'idle' }));
  const client = createClient({ fetch: fetchImpl });

  assert.deepEqual(await client.status(), { state: 'idle' });
  assert.equal(fetchImpl.calls[0].url, '/api/status');
  assert.equal(fetchImpl.calls[0].method, 'GET');
});

test('gcode is sent as-is, not wrapped in JSON', async () => {
  // The firmware streams the body straight to the card; encoding it would mean
  // decoding it again on a machine that cannot hold the file.
  const fetchImpl = fakeFetch(() => ok({ name: 'a.gcode', bytes: 4 }, 201));
  const client = createClient({ fetch: fetchImpl });

  await client.upload('a.gcode', 'G90\n');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, '/api/files/a.gcode');
  assert.equal(call.body, 'G90\n');
  assert.equal(call.headers['content-type'], 'text/plain');
});

test('a file name with a space survives the round trip', async () => {
  const fetchImpl = fakeFetch(() => ok({}, 201));
  await createClient({ fetch: fetchImpl }).upload('wrench 2.gcode', 'G90\n');

  assert.equal(fetchImpl.calls[0].url, '/api/files/wrench%202.gcode');
});

test('a refusal arrives with the firmware’s own slug', async () => {
  // So the UI can tell "you have not homed yet" from "the cable fell out"
  // without reading prose.
  const fetchImpl = fakeFetch(() =>
    ok({ error: 'untrusted_position', message: 'seed the position first' }, 409));

  await assert.rejects(
    () => createClient({ fetch: fetchImpl }).start('a.gcode'),
    (problem) => {
      assert.ok(problem instanceof ApiError);
      assert.equal(problem.slug, 'untrusted_position');
      assert.equal(problem.status, 409);
      assert.equal(problem.offline, false);
      return true;
    }
  );
});

test('an error with no body still has a slug', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: false,
    status: 500,
    json: async () => { throw new Error('not json'); },
  }));

  await assert.rejects(
    () => createClient({ fetch: fetchImpl }).status(),
    (problem) => problem.slug === 'http_error' && problem.status === 500
  );
});

test('204 means there is nothing to read', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, status: 204, json: async () => {
    throw new Error('should not be read');
  } }));

  assert.equal(await createClient({ fetch: fetchImpl }).deleteFile('a.gcode'), null);
});

test('a network failure is reported as offline', async () => {
  const fetchImpl = fakeFetch(() => { throw new TypeError('Failed to fetch'); });

  await assert.rejects(
    () => createClient({ fetch: fetchImpl }).status(),
    (problem) => problem.offline === true
  );
});

test('a plotter that never answers fails rather than hanging', async () => {
  // A machine that has lost power does not refuse connections, it simply goes
  // quiet — so without a deadline the poll would never come back and the app
  // would sit there looking connected.
  const fetchImpl = fakeFetch(() => new Promise(() => {}));
  const client = createClient({ fetch: fetchImpl, timeoutMs: 20 });

  await assert.rejects(() => client.status(), (problem) => problem.offline === true);
});

test('an upload is given longer than a status poll', async () => {
  // A megabyte over the Pico's WiFi is measured in seconds.
  let resolve;
  const fetchImpl = fakeFetch(() => new Promise((r) => { resolve = r; }));
  const client = createClient({ fetch: fetchImpl, timeoutMs: 10 });

  const upload = client.upload('big.gcode', 'x'.repeat(1000), 200);
  setTimeout(() => resolve(ok({ name: 'big.gcode', bytes: 1000 }, 201)), 60);

  assert.deepEqual(await upload, { name: 'big.gcode', bytes: 1000 });
});

test('job control posts to the documented endpoints', async () => {
  const fetchImpl = fakeFetch(() => ok({ state: 'running' }));
  const client = createClient({ fetch: fetchImpl });

  await client.start('a.gcode', { maxSpeed: 1200 });
  await client.pause();
  await client.resume();
  await client.stop();

  assert.deepEqual(
    fetchImpl.calls.map((c) => `${c.method} ${c.url}`),
    ['POST /api/job/start', 'POST /api/job/pause',
     'POST /api/job/resume', 'POST /api/job/stop']
  );
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body),
    { file: 'a.gcode', settings: { maxSpeed: 1200 } });
});
