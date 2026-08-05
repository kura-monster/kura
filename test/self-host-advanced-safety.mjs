import assert from 'node:assert/strict';
import {
  bootstrapSelfHostedCompiler,
  solveWithSelfHostedTraitSolver,
  checkWithSelfHostedBorrowChecker,
  compileWithSelfHostedCompiler,
} from '../lib/self-host.mjs';

const bootstrap = await bootstrapSelfHostedCompiler();
assert.equal(bootstrap.fixedPoint, true);
assert.equal(bootstrap.capabilities.associatedTypeSolverWrittenInKura, true);
assert.equal(bootstrap.capabilities.coherenceCheckerWrittenInKura, true);
assert.equal(bootstrap.capabilities.pathSensitiveBorrowCheckerWrittenInKura, true);
assert.equal(bootstrap.capabilities.nonLexicalLoanExpirationWrittenInKura, true);

const associated = await solveWithSelfHostedTraitSolver(`
trait Iterator { type Item }
struct Numbers {}
impl Iterator for Numbers { type Item = i32 }
`, { trait: 'Iterator', type: 'Numbers' });
assert.equal(associated.ok, true);
assert.equal(associated.matches.length, 1);
assert.deepEqual(associated.matches[0][2][0], ['Item', 'i32']);

const missing = await solveWithSelfHostedTraitSolver(`
trait Iterator { type Item }
struct Numbers {}
impl Iterator for Numbers {}
`);
assert.equal(missing.ok, false);
assert.ok(missing.diagnostics.some(item => item.code === 'KR-SELF-TRAIT-1006'));

const overlap = await solveWithSelfHostedTraitSolver(`
trait Render { type Output }
struct Box {}
impl<T> Render for Box<T> { type Output = String }
impl Render for Box<i32> { type Output = String }
`);
assert.equal(overlap.ok, false);
assert.ok(overlap.diagnostics.some(item => item.code === 'KR-SELF-TRAIT-1008'));

const nll = await checkWithSelfHostedBorrowChecker(`
pub fn update(mut value: String, condition: bool) -> String {
  let view = &value
  if condition { print(view) } else { print(view) }
  value = "updated"
  return value
}
`);
assert.equal(nll.ok, true);
assert.equal(nll.plan.length, 2);

const conflict = await checkWithSelfHostedBorrowChecker(`
pub fn broken(mut value: String) -> String {
  let view = &value
  let edit = &mut value
  print(view)
  return value
}
`);
assert.equal(conflict.ok, false);
assert.ok(conflict.diagnostics.some(item => item.code === 'KR-SELF-BORROW-0201'));

const fields = await checkWithSelfHostedBorrowChecker(`
pub fn fields(mut user: User) -> User {
  let name = &user.name
  user.age = 20
  print(name)
  return user
}
`);
assert.equal(fields.ok, true);

await assert.rejects(
  () => compileWithSelfHostedCompiler(`
trait Iterator { type Item }
struct Numbers {}
impl Iterator for Numbers {}
pub fn main() -> String { return "bad" }
`),
  error => error.code === 'KR-SELF-TRAIT-1006',
);

console.log('self-host advanced trait and borrow safety tests passed');
