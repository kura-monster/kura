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
assert.equal(bootstrap.capabilities.poloniusRegionFactsWrittenInKura, true);
assert.equal(bootstrap.capabilities.loopFixedPointDataflowWrittenInKura, true);
assert.equal(bootstrap.capabilities.varianceInferenceWrittenInKura, true);
assert.equal(bootstrap.capabilities.pinnedGeneratorBorrowModelWrittenInKura, true);
assert.equal(bootstrap.capabilities.negativeImplCheckingWrittenInKura, true);
assert.equal(bootstrap.capabilities.specializationOrderingWrittenInKura, true);
assert.equal(bootstrap.capabilities.recursiveAssociatedTypeProjectionWrittenInKura, true);

const specialization = await solveWithSelfHostedTraitSolver(`
trait Show { type Out }
struct Box<T> {}
default impl<T> Show for Box<T> { type Out = T }
impl Show for Box<i32> { type Out = String }
`, { trait: 'Show', type: 'Box<i32>', assoc: 'Out' });
assert.equal(specialization.ok, true);
assert.equal(specialization.version, '1.2-kura-recursive-projection-specialization-solver');
assert.equal(specialization.projections[0][1], 'String');
assert.equal(specialization.specialization[0][2], 'Box<i32>');

const negative = await solveWithSelfHostedTraitSolver(`
trait Send { type Marker }
struct Never {}
impl !Send for Never {}
`, { trait: 'Send', type: 'Never' });
assert.equal(negative.ok, false);
assert.ok(negative.diagnostics.some(item => item.code === 'KR-SELF-TRAIT-1201'));
assert.equal(negative.negativeMatches.length, 1);

const recursive = await solveWithSelfHostedTraitSolver(`
trait Iterator { type Item }
trait Wrapper { type Output }
struct Box<T> {}
impl<T> Iterator for Box<T> { type Item = T }
impl<T> Wrapper for Box<T> { type Output = Iterator::Item<Box<T>> }
`, { trait: 'Wrapper', type: 'Box<i32>', assoc: 'Output' });
assert.equal(recursive.ok, true);
assert.equal(recursive.projections[0][1], 'i32');
assert.ok(recursive.normalizationTrace.some(item => item[2] === 'resolved'));

const cfg = await buildWithSelfHostedCfgRegion(`
struct Shared<T> { value: &T }
struct Unique<T> { value: &mut T }
pub async fn pinned(mut value: String) -> String {
  pin(value)
  let view = &value
  await task()
  print(view)
  return value
}
`);
assert.equal(cfg.ok, true);
assert.equal(cfg.version, '1.1-kura-polonius-loop-region-analyzer');
assert.equal(cfg.regionFacts.converged, true);
assert.ok(cfg.regionFacts.facts.some(item => item[0] === 'loan_live'));
assert.deepEqual(cfg.varianceFacts.slice(0, 2).map(item => item[2]), ['covariant', 'invariant']);
assert.equal(cfg.generatorLayout[0][4], true);

const pinned = await checkWithSelfHostedBorrowChecker(`
pub async fn pinned(mut value: String) -> String {
  pin(value)
  let view = &value
  await task()
  print(view)
  return value
}
`);
assert.equal(pinned.ok, true);
assert.equal(pinned.version, '2.1-kura-polonius-pin-generator-borrow-checker');
assert.equal(pinned.summaries[0][5][0][3], true);

const unpinned = await checkWithSelfHostedBorrowChecker(`
pub async fn broken(mut value: String) -> String {
  let view = &value
  await task()
  print(view)
  return value
}
`);
assert.equal(unpinned.ok, false);
assert.ok(unpinned.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0304'));

const loop = await buildWithSelfHostedCfgRegion(`
pub fn broken(mut value: String, condition: bool) -> String {
  while condition { move value }
  return value
}
`);
assert.equal(loop.ok, false);
assert.ok(loop.diagnostics.some(item => item.code === 'KR-SELF-LOOP-0001'));
assert.equal(loop.loopFixedPoints[0][2], true);

const lifetime = await buildWithSelfHostedCfgRegion(`
pub fn identity(value: &String) -> &String { return value }
`);
assert.equal(lifetime.ok, true);
assert.deepEqual(lifetime.lifetimeSubstitutions[0].slice(0, 4), ['identity', 'output', 'value', 'covariant']);

const artifactDirectory = await mkdtemp(join(tmpdir(), 'kura-polonius-traits-'));
try {
  await writeSelfHostArtifacts(artifactDirectory);
  const verified = await verifySelfHostArtifacts(artifactDirectory);
  assert.equal(verified.ok, true);
  assert.equal(verified.traitResult.version, '1.2-kura-recursive-projection-specialization-solver');
  assert.equal(verified.cfgResult.version, '1.1-kura-polonius-loop-region-analyzer');
  assert.equal(verified.borrowResult.version, '2.1-kura-polonius-pin-generator-borrow-checker');
} finally {
  await rm(artifactDirectory, { recursive: true, force: true });
}

console.log('self-host Polonius-style region and advanced trait tests passed');
