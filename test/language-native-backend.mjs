// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileLanguageNative } from '../lib/language-native-backend.mjs';

const source = `
trait Display { fn display(self: Number) -> i32; }
struct Number { value: i32 }
enum Choice { First(i32), Second(i32) }
impl Display for Number { fn display(self: Number) -> i32 { return self.value } }
fn identity<T>(value: T) -> T where T: Send { return value }
fn choose(value: Choice) -> i32 {
  return match value {
    Choice::First(number) => number,
    Choice::Second(number) => number + 1,
  }
}
fn main() -> i32 {
  let number: Number = Number(42)
  return identity<i32>(number.display())
}
`;
const result = compileLanguageNative(source, { file: 'native-language.kr' });
assert.match(result.ir, /%struct\.Number = type \{ i32 \}/);
assert.match(result.ir, /%enum\.Choice = type/);
assert.match(result.ir, /@identity__i32/);
assert.match(result.ir, /@vtable_Display_Number/);
assert.match(result.ir, /switch i32/);
assert.equal(result.manifest.specializations.length, 1);
assert.equal(result.manifest.traitVTables.length, 1);
assert.equal(result.manifest.types.Choice.variants.length, 2);

if (process.platform !== 'win32' && spawnSync('clang', ['--version'], { stdio: 'ignore' }).status === 0) {
  const directory = await mkdtemp(join(tmpdir(), 'kura-native-language-'));
  const llvm = join(directory, 'program.ll');
  const object = join(directory, 'program.o');
  await writeFile(llvm, result.ir);
  const built = spawnSync('clang', ['-Wno-override-module', '-c', llvm, '-o', object], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
}
console.log('high-level native backend tests passed');
