'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = /^[a-f0-9]{64}\.json$/;

function createFileApprovalNonceStore({ directory, maxEntries = 100000, clock = () => Date.now() } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('approval nonce directory must be an absolute path');
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000000) {
    throw new Error('maxEntries must be 1..1000000');
  }
  if (typeof clock !== 'function') throw new Error('clock must be a function');

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('approval nonce directory must be a real directory, not a symlink');
  }
  const root = fs.realpathSync(directory);

  function pruneExpired(now = clock()) {
    if (!Number.isFinite(now)) throw new Error('now must be finite');
    let retained = 0;
    for (const name of fs.readdirSync(root)) {
      if (!FILE_NAME.test(name)) continue;
      const file = path.join(root, name);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        retained++;
        continue;
      }
      let record;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        retained++;
        continue;
      }
      if (Number.isFinite(record.expiresAt) && record.expiresAt <= now) {
        try {
          fs.unlinkSync(file);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      } else {
        retained++;
      }
    }
    return retained;
  }

  function consume({ issuer, nonce, expiresAt, now = clock() } = {}) {
    if (typeof issuer !== 'string' || !issuer || issuer.length > 128 ||
        typeof nonce !== 'string' || !nonce || nonce.length > 128) {
      throw new Error('issuer and nonce are required bounded strings');
    }
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error('nonce expiry must be in the future');
    }

    const retained = pruneExpired(now);
    if (retained >= maxEntries) {
      return { ok: false, reason: 'approval_replay_cache_full' };
    }

    const key = crypto.createHash('sha256').update(issuer + '\0' + nonce).digest('hex');
    const file = path.join(root, key + '.json');
    let descriptor;
    try {
      descriptor = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ consumedAt: now, expiresAt }));
      fs.fsyncSync(descriptor);
      return { ok: true };
    } catch (error) {
      if (error.code === 'EEXIST') return { ok: false, reason: 'approval_replayed' };
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  return Object.freeze({ consume, pruneExpired });
}

module.exports = { createFileApprovalNonceStore };
