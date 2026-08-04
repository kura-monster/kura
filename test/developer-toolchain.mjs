// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IncrementalCompilerCache, createSourceMap, createDwarfMetadata, KuraDebuggerSession,
  KuraProfiler, AddressSanitizerModel, RaceDetectorModel,
} from '../lib/developer-toolchain.mjs';

const cacheDirectory = await mkdtemp(join(tmpdir(), 'kura-cache-'));
const cache = new IncrementalCompilerCache(cacheDirectory);
await cache.put({ source: 'fn main() {}', file: '/tmp/main.kr', target: 'llvm' }, { ir: 'define void @main() {}' });
const cached = await cache.get({ source: 'fn main() {}', file: '/tmp/main.kr', target: 'llvm' });
assert.match(cached.payload.ir, /define void/);
assert.equal(cache.stats().entries, 1);

const sourceMap = createSourceMap({ file: 'main.kr', source: 'fn main() {}', generatedFile: 'main.mjs', mappings: [{ generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0 }] });
assert.equal(sourceMap.version, 3);
assert.ok(sourceMap.mappings.length > 0);
assert.match(createDwarfMetadata({ file: 'main.kr', functions: [{ name: 'main', line: 1 }] }).text, /DISubprogram/);

const debuggerSession = new KuraDebuggerSession();
const breakpoint = debuggerSession.setBreakpoint('/tmp/main.kr', 2, 1, 'value === 42');
assert.equal(debuggerSession.shouldBreak({ file: '/tmp/main.kr', line: 2 }, { value: 42 }).id, breakpoint.id);
debuggerSession.pushFrame({ id: 1, name: 'main', locals: { value: 42 } });
assert.equal(debuggerSession.evaluate('value + 1', 1), 43);

let clock = 0;
const profiler = new KuraProfiler({ clock: () => ++clock });
const region = profiler.begin('compile'); profiler.increment('modules'); profiler.end(region);
assert.equal(profiler.report().groups['function:compile'].calls, 1);

const asan = new AddressSanitizerModel(); const address = asan.allocate(8); asan.write(address, [1, 2, 3]);
assert.deepEqual([...asan.read(address, 3)], [1, 2, 3]); asan.free(address);
assert.throws(() => asan.read(address, 1), error => error.code === 'KR-ASAN-UAF');
const race = new RaceDetectorModel(); race.access({ thread: 1, address: 0x1000, write: true }); race.access({ thread: 2, address: 0x1000, write: false });
assert.equal(race.report().races, 1);
console.log('developer toolchain tests passed');
