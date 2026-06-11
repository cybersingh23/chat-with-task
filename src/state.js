import fs from 'node:fs';
import path from 'node:path';
import { taskDir, httpError } from './workspace.js';

// Per-task review state, shared across users: _studio.json in the task folder.
export const VERDICTS = ['NO_ISSUES', 'SBQ', 'FIXES_IN_PROGRESS', 'SECOND_OPINION'];

export function getState(bucket, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(taskDir(bucket, id), '_studio.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(bucket, id, state) {
  fs.writeFileSync(path.join(taskDir(bucket, id), '_studio.json'), JSON.stringify(state, null, 2));
}

export function claimTask(bucket, id, username) {
  const state = getState(bucket, id);
  if (state.claimed_by && state.claimed_by !== username) {
    throw httpError(409, `already claimed by ${state.claimed_by}`);
  }
  state.claimed_by = username;
  state.claimed_at = new Date().toISOString();
  saveState(bucket, id, state);
  return state;
}

export function releaseTask(bucket, id, username, isAdmin) {
  const state = getState(bucket, id);
  if (state.claimed_by && state.claimed_by !== username && !isAdmin) {
    throw httpError(403, `claimed by ${state.claimed_by} — only they or an admin can release`);
  }
  delete state.claimed_by;
  delete state.claimed_at;
  saveState(bucket, id, state);
  return state;
}

export function setVerdict(bucket, id, verdict, username) {
  if (verdict !== null && !VERDICTS.includes(verdict)) {
    throw httpError(400, `verdict must be one of ${VERDICTS.join(', ')} (or null to clear)`);
  }
  const state = getState(bucket, id);
  if (verdict === null) {
    delete state.verdict;
    delete state.verdict_by;
    delete state.verdict_at;
  } else {
    state.verdict = verdict;
    state.verdict_by = username;
    state.verdict_at = new Date().toISOString();
  }
  saveState(bucket, id, state);
  return state;
}
