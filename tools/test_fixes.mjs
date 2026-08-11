// Functional regression tests for the fix engine (src/fixes.js) and the audit-seed ordering.
// Run with: npm test — writes only to a throwaway dir under /tmp.
import fs from 'node:fs';
import path from 'node:path';
import {
  applyFix, approveGrammar, approveWithText, denyFix, revertFix,
  fixApplicability, fixStates, seedLedgerFromGrammar, readLedger, validateTask,
} from '../src/fixes.js';
import { writeAuditSeed } from '../src/ingest.js';

const T = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { console.log(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
};
const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

const base = fs.mkdtempSync('/tmp/fixeng-');
const dir = path.join(base, 'aaaaaaaaaaaaaaaaaaaaaaaa');
fs.mkdirSync(dir, { recursive: true });

const freshRank = () => ({
  preference_rating: '+2: moderately prefer model b',
  ranking_rationale: 'The winner handled the the edge case well. It also it also compiled.',
  results: { model_1: { rank: 2, grading: { code_style: { score: null, rationale: 'ok ok fine' } } }, model_2: { rank: 1 } },
});
const reset = () => {
  fs.writeFileSync(path.join(dir, 'rank.json'), JSON.stringify(freshRank(), null, 2));
  fs.writeFileSync(path.join(dir, 'rank.source.json'), JSON.stringify(freshRank(), null, 2));
  for (const f of ['fix_ledger.json', 'grammar_fixes.json', 'fixes.json']) fs.rmSync(path.join(dir, f), { force: true });
};

// 1. occurrence beyond count => DRIFTED, field untouched (the null-write bug)
reset();
T('occurrence=2 with 1 hit refuses instead of writing null', () => {
  const fix = { id: 'F1', status: 'PROPOSED', path: '/ranking_rationale', old: 'compiled', new: 'built', occurrence: 2 };
  eq(fixApplicability(JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'))), fix), 'DRIFTED', 'applicability');
  eq(applyFix(dir, fix, 'pavit').result, 'DRIFTED', 'apply result');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  if (live.ranking_rationale === null) throw new Error('field was nulled');
});

// 2. occurrence=2 with 2 hits lands on the right one
T('occurrence=2 with 2 hits replaces the second', () => {
  const fix = { id: 'F2', status: 'PROPOSED', path: '/ranking_rationale', old: 'also', new: 'and', occurrence: 2, occurrences_in_field: 2 };
  eq(applyFix(dir, fix, 'pavit').result, 'APPLIED', 'apply');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  eq(live.ranking_rationale, 'The winner handled the the edge case well. It also it and compiled.', 'text');
});

// 3. coerce through null keeps numbers numeric
reset();
T('null -> "4" coerces to number 4', () => {
  const fix = { id: 'F3', status: 'PROPOSED', path: '/results/model_1/grading/code_style/score', old: 'null', new: '4' };
  eq(applyFix(dir, fix, 'pavit').result, 'APPLIED', 'apply');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  if (live.results.model_1.grading.code_style.score !== 4) throw new Error(`got ${JSON.stringify(live.results.model_1.grading.code_style.score)}`);
});

// 4. grammar deny -> approve reversal, and sign-off stamps the LATEST entry
reset();
fs.writeFileSync(path.join(dir, 'grammar_fixes.json'), JSON.stringify([
  { path: '/ranking_rationale', old: 'the the', new: 'the', rule: 'R23', error_type: 'doubled-word' },
]));
// grammar arrives pre-applied: simulate the eval's edit in live
{
  const live = freshRank(); live.ranking_rationale = live.ranking_rationale.replace('the the', 'the');
  fs.writeFileSync(path.join(dir, 'rank.json'), JSON.stringify(live, null, 2));
}
seedLedgerFromGrammar(dir);
T('deny grammar reverts the span', () => {
  const item = fixStates(dir).items.find((i) => i.id === 'G1');
  eq(denyFix(dir, { ...item, status: 'APPLIED' }, 'pavit', 'disagree').result, 'REVERTED', 'deny');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  if (!live.ranking_rationale.includes('the the')) throw new Error('span not reverted');
});
T('approve after deny is a reversal that re-applies', () => {
  const item = fixStates(dir).items.find((i) => i.id === 'G1');
  eq(item.decision, 'denied', 'pre-state');
  eq(approveGrammar(dir, item, 'pavit').result, 'APPLIED', 'reversal');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  if (live.ranking_rationale.includes('the the')) throw new Error('edit not re-applied');
  const after = fixStates(dir).items.find((i) => i.id === 'G1');
  eq(after.decision, 'approved', 'post-state');
  if (fixStates(dir).items.filter((i) => i.id === 'G1').length !== 1) throw new Error('duplicate grammar item rendered');
});
T('sign-off stamps the entry fixStates reads', () => {
  const item = fixStates(dir).items.find((i) => i.id === 'G1');
  eq(approveGrammar(dir, item, 'ernesto').result, 'SIGNED_OFF', 'signoff');
  eq(fixStates(dir).items.find((i) => i.id === 'G1').signed_off_by, 'ernesto', 'visible sign-off');
});

// 5. edited approval after deny (the old dead-end) + applied_new surfaced
reset();
fs.writeFileSync(path.join(dir, 'grammar_fixes.json'), JSON.stringify([
  { path: '/ranking_rationale', old: 'the the', new: 'the', rule: 'R23', error_type: 'doubled-word' },
]));
{
  const live = freshRank(); live.ranking_rationale = live.ranking_rationale.replace('the the', 'the');
  fs.writeFileSync(path.join(dir, 'rank.json'), JSON.stringify(live, null, 2));
}
seedLedgerFromGrammar(dir);
T('edit after deny rebuilds from source with reviewer text', () => {
  let item = fixStates(dir).items.find((i) => i.id === 'G1');
  denyFix(dir, { ...item, status: 'APPLIED' }, 'pavit', 'wrong fix');
  item = fixStates(dir).items.find((i) => i.id === 'G1');
  eq(approveWithText(dir, item, 'pavit', 'that particular').result, 'APPLIED', 'edited approve');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  if (!live.ranking_rationale.includes('that particular edge case')) throw new Error(`text: ${live.ranking_rationale}`);
  const after = fixStates(dir).items.find((i) => i.id === 'G1');
  eq(after.applied_new, 'that particular', 'applied_new');
  eq(after.edited_from, 'the', 'edited_from');
});

// 6. revert with source missing the path refuses without marking
reset();
fs.writeFileSync(path.join(dir, 'rank.source.json'), JSON.stringify({ other: 1 }, null, 2));
T('revert refuses when source lacks the path (no silent ship)', () => {
  const fix = { id: 'F9', status: 'PROPOSED', path: '/ranking_rationale', old: 'compiled', new: 'built' };
  eq(applyFix(dir, fix, 'pavit').result, 'APPLIED', 'setup apply');
  // source has no /ranking_rationale AND live no longer contains 'built'?? it does — inversion is safe here.
  // Force the unsafe case: two entries on the path.
  const fix2 = { id: 'F10', status: 'PROPOSED', path: '/ranking_rationale', old: 'winner', new: 'victor' };
  eq(applyFix(dir, fix2, 'pavit').result, 'APPLIED', 'second apply');
  const r = revertFix(dir, 'F9', 'pavit', 'undo');
  eq(r.result, 'NO_SOURCE_ANCHOR', 'refusal');
  const led = readLedger(dir).find((e) => e.fix_id === 'F9');
  eq(led.decision, 'approved', 'ledger untouched');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  if (!live.ranking_rationale.includes('built')) throw new Error('text changed despite refusal');
});

// 7. single-entry inversion without source still works
reset();
fs.rmSync(path.join(dir, 'rank.source.json'));
T('single-entry revert without source inverts cleanly', () => {
  const fix = { id: 'F11', status: 'PROPOSED', path: '/ranking_rationale', old: 'compiled', new: 'built' };
  applyFix(dir, fix, 'pavit');
  eq(revertFix(dir, 'F11', 'pavit', 'undo').result, 'REVERTED', 'revert');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json')));
  if (!live.ranking_rationale.includes('compiled')) throw new Error('not inverted');
});

// 8. audit seed keeps the grammar section when _audit sections rewrite the file
T('writeAuditSeed keeps the do-not-re-flag section', () => {
  const delivery = path.join(base, 'delivery');
  fs.mkdirSync(path.join(delivery, '_audit'), { recursive: true });
  fs.writeFileSync(path.join(delivery, '_audit', 'final_verdicts.json'),
    JSON.stringify([{ task_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'SOFT' }]));
  fs.writeFileSync(path.join(dir, 'grammar_fixes.json'), JSON.stringify([
    { path: '/ranking_rationale', old: 'the the', new: 'the', rule: 'R23', error_type: 'doubled-word' },
  ]));
  fs.rmSync(path.join(dir, '_audit_seed.md'), { force: true });
  const wrote = writeAuditSeed(delivery, 'aaaaaaaaaaaaaaaaaaaaaaaa', dir);
  const seed = fs.readFileSync(path.join(dir, '_audit_seed.md'), 'utf8');
  if (!wrote) throw new Error('sections write did not happen');
  if (!seed.includes('do not re-flag')) throw new Error('grammar section clobbered');
  if (!seed.includes('Final verdict')) throw new Error('audit sections missing');
});

// 9. recomputed validateTask clears after fixes are decided
reset();
T('validateTask recomputes clean on a healthy task', () => {
  eq(validateTask(dir, { verdict: 'SOFT' }).length, 0, 'warnings');
});

fs.rmSync(base, { recursive: true, force: true });
console.log('done');
