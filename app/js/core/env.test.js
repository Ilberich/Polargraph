import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOrigin,
  describeEnvironment,
  plotterUrl,
  CAPABLE,
  BLOCKED_HTTPS,
  BLOCKED_FILE,
} from './env.js';

test('plain HTTP can reach the plotter', () => {
  assert.equal(classifyOrigin({ protocol: 'http:' }), CAPABLE);
});

test('HTTPS is blocked by mixed content', () => {
  // The GitHub Pages case. This is the whole reason for AD-1.
  assert.equal(classifyOrigin({ protocol: 'https:' }), BLOCKED_HTTPS);
});

test('a file:// origin is blocked', () => {
  assert.equal(classifyOrigin({ protocol: 'file:' }), BLOCKED_FILE);
});

test('served from the plotter, the API is same-origin', () => {
  const env = describeEnvironment({ protocol: 'http:' });

  assert.equal(env.canReachPlotter, true);
  assert.equal(env.apiBase, '/api');
  assert.equal(env.reason, null);
});

test('served from Pages, there is no API base and a reason is given', () => {
  const env = describeEnvironment({ protocol: 'https:' });

  assert.equal(env.canReachPlotter, false);
  assert.equal(env.apiBase, null, 'must not offer a connection that cannot work');
  assert.match(env.reason, /HTTPS/);
});

test('every blocked capability explains itself', () => {
  for (const protocol of ['https:', 'file:']) {
    const env = describeEnvironment({ protocol });
    assert.ok(env.reason && env.reason.length > 0, `${protocol} needs a reason`);
  }
});

test('plotter URL is plain HTTP', () => {
  assert.equal(plotterUrl(), 'http://polargraph.local');
  assert.equal(plotterUrl('192.168.1.40'), 'http://192.168.1.40');
});
