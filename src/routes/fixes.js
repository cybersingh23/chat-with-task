import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { taskDir } from '../workspace.js';
import {
  fixStates, loadFixBlocks, applyFix, approveWithText, denyFix, revertFix, readLedger,
  ptrGet, sourcePath, rankPath,
} from '../fixes.js';

// /api/task/:bucket/:id/fixes — the fix lifecycle (spec §5), mounted inside the
// authenticated api router with mergeParams so :bucket/:id resolve here.
export const fixesApi = express.Router({ mergeParams: true });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const dirOf = (req) => taskDir(req.params.bucket, req.params.id);

fixesApi.get('/', wrap(async (req, res) => {
  res.json(fixStates(dirOf(req)));
}));

// Per-field diff of rank.source.json vs live rank.json, for the fields the
// fixes and ledger touch — the §5.6 diff view's data.
fixesApi.get('/diff', wrap(async (req, res) => {
  const dir = dirOf(req);
  const source = JSON.parse(fs.readFileSync(sourcePath(dir), 'utf8'));
  const live = JSON.parse(fs.readFileSync(rankPath(dir), 'utf8'));
  const paths = new Set();
  for (const e of readLedger(dir)) if (e.path) paths.add(e.path);
  for (const b of loadFixBlocks(dir).blocks) if (b.path) paths.add(b.path);
  res.json({
    fields: [...paths].sort().map((p) => ({
      path: p,
      source: ptrGet(source, p),
      live: ptrGet(live, p),
      changed: JSON.stringify(ptrGet(source, p)) !== JSON.stringify(ptrGet(live, p)),
    })),
  });
}));

function findBlock(dir, fixId) {
  const { items } = fixStates(dir);
  const item = items.find((i) => i.id === fixId);
  if (!item) throw Object.assign(new Error(`unknown fix ${fixId}`), { status: 404 });
  return item;
}

fixesApi.post('/:fixId/approve', wrap(async (req, res) => {
  const dir = dirOf(req);
  const item = findBlock(dir, req.params.fixId);
  // An edited approval carries the reviewer's replacement text; it applies
  // their wording and the ledger records edited_from.
  if (typeof req.body?.new === 'string' && req.body.new !== '') {
    return res.json(approveWithText(dir, item, req.user.username, String(req.body.new).slice(0, 4000)));
  }
  if (item.kind === 'grammar') {
    // Grammar arrives applied; approval is sign-off, recorded without touching text.
    const ledger = readLedger(dir);
    const e = ledger.find((x) => x.fix_id === item.id && !x.superseded_at);
    e.signed_off_by = req.user.username;
    e.signed_off_at = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'fix_ledger.json'), JSON.stringify(ledger, null, 2));
    return res.json({ result: 'SIGNED_OFF' });
  }
  const out = applyFix(dir, item, req.user.username);
  res.json(out);
}));

fixesApi.post('/:fixId/deny', wrap(async (req, res) => {
  const dir = dirOf(req);
  const item = findBlock(dir, req.params.fixId);
  const reason = String(req.body?.reason || '').slice(0, 500);
  // Denying is a judgement being recorded — it needs words behind it (§5.6),
  // for the day a vendor disputes the audit.
  if (!reason) return res.status(400).json({ error: 'a reason is required to deny a fix' });
  const kind = item.kind === 'grammar' ? { ...item, status: 'APPLIED' } : { ...item, status: 'PROPOSED' };
  res.json(denyFix(dir, kind, req.user.username, reason));
}));

fixesApi.post('/:fixId/revert', wrap(async (req, res) => {
  res.json(revertFix(dirOf(req), req.params.fixId, req.user.username, String(req.body?.reason || '') || null));
}));

// Bulk approve, mechanical only: meaning-changing edits alter what the sentence
// asserts about a model and get an individual look (§5.6). 44 of 128 edits in
// the reference batch are meaning-changing.
fixesApi.post('/approve-mechanical', wrap(async (req, res) => {
  const dir = dirOf(req);
  const { items } = fixStates(dir);
  const results = [];
  for (const item of items) {
    if (item.meaning_changing) continue;
    if (item.kind === 'proposed' && item.decision === 'pending' && item.applicability === 'OK') {
      results.push({ id: item.id, ...applyFix(dir, item, req.user.username) });
    } else if (item.kind === 'grammar' && !item.reverted && !item.signed_off_by) {
      const ledger = readLedger(dir);
      const e = ledger.find((x) => x.fix_id === item.id && !x.superseded_at);
      if (e && !e.signed_off_by) {
        e.signed_off_by = req.user.username;
        e.signed_off_at = new Date().toISOString();
        fs.writeFileSync(path.join(dir, 'fix_ledger.json'), JSON.stringify(ledger, null, 2));
        results.push({ id: item.id, result: 'SIGNED_OFF' });
      }
    }
  }
  res.json({ results, skippedMeaningChanging: items.filter((i) => i.meaning_changing).length });
}));
