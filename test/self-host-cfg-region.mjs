import assert from 'node:assert/strict';
import {
  bootstrapSelfHostedCompiler,
  solveWithSelfHostedTraitSolver,
  buildWithSelfHostedCfgRegion,
  checkWithSelfHostedBorrowChecker,
  writeSelfHostArtifacts,
  verifySelfHostArtifacts,
} from '../lib/self-host.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bootstrap = await bootstrapSelfHostedCompiler();
assert.equal(bootstrap.fixedPoint, true);
assert.equal(bootstrap.capabilities.cfgConstructionWrittenInKura, true);
assert.equal(bootstrap.capabilities.regionInferenceWrittenInKura, true);
assert.equal(bootstrap.capabilities.reborrowCheckingWrittenInKura, true);
assert.equal(bootstrap.capabilities.twoPhaseBorrowWrittenInKura, true);
assert.equal(bootstrap.capabilities.closureCaptureCheckingWrittenInKura, true);
assert.equal(bootstrap.capabilities.asyncBorrowCheckingWrittenInKura, true);
assert.equal(bootstrap.capabilities.interproceduralLifetimeContractsWrittenInKura, true);
assert.equal(bootstrap.capabilities.higherRankedTraitBoundsWrittenInKura, true);
assert.equal(bootstrap.capabilities.associatedTypeProjectionWrittenInKura, true);

const projection = await solveWithSelfHostedTraitSolver(`
trait Iterator { type Item }
struct Box<T> {}
impl<T> Iterator for Box<T> { type Item = T }
`, { trait: 'Iterator', type: 'Box<i32>', assoc: 'Item' });
assert.equal(projection.ok, true);
assert.equal(projection.version, '1.2-kura-recursive-projection-specialization-solver');
assert.equal(projection.projections[0][1], 'i32');

const hrtb = await solveWithSelfHostedTraitSolver(`
trait Reader { type Item }
pub fn read_all<T>(value: T) -> T where T: for<a> Reader<a> { return value }
`);
assert.equal(hrtb.ok, true);
assert.deepEqual(hrtb.higherRanked[0][0], ['a']);
assert.equal(hrtb.higherRanked[0][1], 'Reader<a>');

const cfg = await buildWithSelfHostedCfgRegion(`
pub fn identity(value: &String) -> &String { return value }
pub fn update(mut value: String, condition: bool) -> String {
  let view = &value
  if condition { print(view) } else { print(view) }
  value = "updated"
  return value
}
`);
assert.equal(cfg.ok, true);
assert.equal(cfg.version, '1.1-kura-polonius-loop-region-analyzer');
assert.equal(cfg.functions.length, 2);
assert.equal(cfg.contracts[0][0], 'identity');
assert.equal(cfg.contracts[0][1], 'value');
assert.equal(cfg.plan.filter(([id]) => id.startsWith('update.')).length, 2);
assert.equal(cfg.regionFacts.converged, true);

const reborrow = await checkWithSelfHostedBorrowChecker(`
pub fn edit(mut value: String) -> String {
  let root = &mut value
  let child = &mut root
  print(child)
  print(root)
  return value
}
`);
assert.equal(reborrow.ok, true);
assert.ok(reborrow.plan[0][1].some(operation => operation[0] === 'reborrow'));

const suspendedParent = await checkWithSelfHostedBorrowChecker(`
pub fn broken(mut value: String) -> String {
  let root = &mut value
  let child = &mut root
  print(root)
  print(child)
  return value
}
`);
assert.equal(suspendedParent.ok, false);
assert.ok(suspendedParent.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0307'));

const twoPhase = await checkWithSelfHostedBorrowChecker(`
pub fn append(mut values: Values) -> Values {
  values.push(values.length)
  return values
}
`);
assert.equal(twoPhase.ok, true);
assert.ok(twoPhase.plan[0][1].some(operation => operation[0] === 'reserve'));
assert.ok(twoPhase.plan[0][1].some(operation => operation[0] === 'activate'));

const closure = await checkWithSelfHostedBorrowChecker(`
pub fn make(mut value: String) -> String {
  let view = &value
  let action = move || { print(view) }
  value = "changed"
  return value
}
`);
assert.equal(closure.ok, false);
assert.ok(closure.cfgRegion.captures.some(item => item[3] === 'capture_ref_move'));
assert.ok(closure.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0203'));

const asyncBorrow = await checkWithSelfHostedBorrowChecker(`
pub async fn broken(mut value: String) -> String {
  let view = &value
  await task()
  print(view)
  return value
}
`);
assert.equal(asyncBorrow.ok, false);
assert.ok(asyncBorrow.cfgRegion.awaits.length > 0);
assert.ok(asyncBorrow.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0304'));

const staticAsyncBorrow = await checkWithSelfHostedBorrowChecker(`
pub async fn allowed() -> String {
  let view = &static.message
  await task()
  print(view)
  return "ok"
}
`);
assert.equal(staticAsyncBorrow.ok, true);

const artifactDirectory = await mkdtemp(join(tmpdir(), 'kura-cfg-region-'));
try {
  const artifacts = await writeSelfHostArtifacts(artifactDirectory);
  assert.ok(artifacts.files.cfgRegionSource.endsWith('cfg-region.kr'));
  assert.ok(artifacts.files.cfgRegion.endsWith('cfg-region-stage0.mjs'));
  const verified = await verifySelfHostArtifacts(artifactDirectory);
  assert.equal(verified.ok, true);
  assert.equal(verified.cfgResult.version, '1.1-kura-polonius-loop-region-analyzer');
} finally {
  await rm(artifactDirectory, { recursive: true, force: true });
}

console.log('self-host CFG, region, reborrow, two-phase, closure and async borrow tests passed');
