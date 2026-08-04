// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import {
  analyzeLanguage,
  compileLanguage,
  parseLanguage,
} from '../lib/language-core.mjs';

const source = `
trait Display { fn display(self: Item) -> String; }
@partial_drop
struct Item { name: String, count: u32 }
enum Result2<T, E> { Ok(T), Err(E) }
impl Drop for Item { fn drop(self: Item) { cleanup(self) } }
fn identity<T>(value: T) -> T where T: Send { return value }
fn result() -> Result2<Item, String> { return Result2::Ok(Item("k", 1)) }
fn use_result(value: Result2<Item, String>) -> String {
  return match value {
    Result2::Ok(item) => item.name,
    Result2::Err(error) => error,
  }
}
fn main() -> i32 {
  let item: Item = Item("Kura", 1)
  let name = move item.name
  let count = item.count
  let add = |value: i32| -> i32 { count + value }
  defer print(name)
  return add(1)
}
`;
const ast = parseLanguage(source, { file: 'core.kr' });
assert.equal(ast.declarations.filter(item => item.kind === 'EnumDeclaration').length, 1);
const report = analyzeLanguage(ast);
assert.equal(report.ok, true, JSON.stringify(report.diagnostics, null, 2));
assert.ok(report.dropPlans.main.drops.some(item => item.name === 'item'));
assert.ok(report.borrowFacts.main.partialMoves.some(item => item.path === 'item.name'));
assert.ok(report.closures.some(item => item.captures.includes('count')));
const compiled = compileLanguage(source, { file: 'core.kr', autoRun: false });
assert.match(compiled.code, /const Result2/);
assert.match(compiled.code, /__kr_drop\(item\)/);
assert.match(compiled.code, /tag === "Ok"/);

const missingArm = `enum Choice { A, B } fn broken(value: Choice) -> i32 { return match value { Choice::A => 1 } }`;
assert.throws(() => compileLanguage(missingArm, { file: 'missing.kr' }), error => error.code === 'KR-LANG-MATCH-0004');

const badTrait = `trait Read { fn read(self: File) -> i32; } struct File { fd: i32 } impl Read for File { fn other(self: File) -> i32 { return 0 } }`;
assert.throws(() => compileLanguage(badTrait, { file: 'trait.kr' }), error => error.code === 'KR-LANG-TRAIT-0003');

const tryOutsideResult = `fn broken() -> i32 { let value = load()? return value }`;
assert.throws(() => compileLanguage(tryOutsideResult, { file: 'try.kr' }), error => error.code === 'KR-LANG-RESULT-0001');

const genericSource = `fn identity<T>(value: T) -> T where T: Send { return value } fn main() -> i32 { return identity<i32>(4) }`;
const genericReport = analyzeLanguage(genericSource, { file: 'generic.kr' });
assert.equal(genericReport.ok, true);
assert.deepEqual(genericReport.specializations[0].typeArguments, ['i32']);

const nllSource = `struct Data { value: i32 } fn valid(data: Data) -> i32 { let first = &data let copy = first let second = &mut data return second.value }`;
const nllReport = analyzeLanguage(nllSource, { file: 'nll.kr' });
assert.equal(nllReport.ok, true, JSON.stringify(nllReport.diagnostics));
assert.ok(nllReport.borrowFacts.valid.nllEnds.length >= 2);

const partialDrop = `struct Guard { value: String } impl Drop for Guard { fn drop(self: Guard) { self.value } } fn broken() { let guard: Guard = Guard("x") let value = move guard.value }`;
assert.throws(() => compileLanguage(partialDrop, { file: 'partial-drop.kr' }), error => error.code === 'KR-LANG-MOVE-0002');

const resultSource = `pub fn load() -> Result<i32, String> { return Result::Ok(7) } pub fn run() -> Result<i32, String> { let value = load()? return Result::Ok(value + 1) }`;
const resultBuild = compileLanguage(resultSource, { file: 'result.kr', autoRun: false });
const resultUrl = `data:text/javascript;base64,${Buffer.from(resultBuild.code).toString('base64')}`;
const resultModule = await import(resultUrl);
assert.deepEqual(resultModule.run(), { tag: 'Ok', values: [8] });

console.log('typed language core tests passed');
