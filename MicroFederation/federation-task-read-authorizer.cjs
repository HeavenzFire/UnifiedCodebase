'use strict';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Permit readback only for the single peer/task pair provisioned by the
// operator for this deployment. All other reads remain denied.
function createTaskReadAuthorizer({ peerId, taskId } = {}) {
  if (typeof peerId !== 'string' || !ID.test(peerId)) {
    throw new Error('task-read peerId must be a valid node identifier');
  }
  if (typeof taskId !== 'string' || !ID.test(taskId)) {
    throw new Error('task-read taskId must be a valid task identifier');
  }
  return async function authorizeTaskRead(request) {
    const candidate = request && typeof request === 'object' ? request : {};
    return Object.freeze({
      allow: candidate.peerId === peerId && candidate.taskId === taskId
    });
  };
}

module.exports = { createTaskReadAuthorizer };
