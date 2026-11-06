'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskReadAuthorizer } = require('../federation-task-read-authorizer.cjs');

test('allows readback only for the configured authenticated peer and exact task', async () => {
  const authorize = createTaskReadAuthorizer({ peerId: 'android-a67l', taskId: 'task-123' });
  assert.deepEqual(await authorize({ peerId: 'android-a67l', taskId: 'task-123' }), { allow: true });
  assert.deepEqual(await authorize({ peerId: 'android-other', taskId: 'task-123' }), { allow: false });
  assert.deepEqual(await authorize({ peerId: 'android-a67l', taskId: 'task-456' }), { allow: false });
  assert.deepEqual(await authorize({}), { allow: false });
  assert.deepEqual(await authorize(null), { allow: false });
});

test('rejects missing or malformed operator read scope at configuration time', () => {
  assert.throws(() => createTaskReadAuthorizer({ taskId: 'task-123' }), /peerId/);
  assert.throws(() => createTaskReadAuthorizer({ peerId: 'android-a67l' }), /taskId/);
  assert.throws(() => createTaskReadAuthorizer({ peerId: '0.0.0.0', taskId: 'task-123' }), /peerId/);
  assert.throws(() => createTaskReadAuthorizer({ peerId: 'android-a67l', taskId: '../other' }), /taskId/);
});
