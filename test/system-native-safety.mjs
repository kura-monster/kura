// SPDX-License-Identifier: MIT OR Apache-2.0
import assert from 'node:assert/strict';
import { NativeCompiler, compileNativeSystemSource } from '../lib/system-native-compiler.mjs';
import { parseNativeSystemSource } from '../lib/system-native-parser.mjs';
import {
  analyzeNativeSafety,
  formatNativeSafetyReport,
} from '../lib/system-native-safety.mjs';

function report(source, options = {}) {
  const program = parseNativeSystemSource(source, { file: options.file ?? 'safety.kr' });
  const compiler = new NativeCompiler(program, {
    safetyMode: options.mode ?? 'audit',
    denyUndocumentedUnsafe: options.denyUndocumentedUnsafe,
  });
  compiler.validate();
  return compiler.safetyReport;
}

const valid = `#![no_std]
#![ownership("strict")]

@must_use
struct Buffer {
  ptr: *mut u8,
  len: usize,
}

extern "C" fn make_buffer() -> Buffer;
fn inspect(value: *const Buffer) {}
fn consume(value: Buffer) {}

fn main() {
  let buffer: Buffer = make_buffer()
  inspect(&buffer)
  consume(ownership.move(buffer))
}
`;
const validLlvm = compileNativeSystemSource(valid, { file: 'valid.kr' });
assert.match(validLlvm, /define .* @main/);
const validReport = report(valid, { mode: 'strict' });
assert.equal(validReport.errors.length, 0);
assert.ok(validReport.moves.length >= 1);
assert.ok(validReport.borrows.length >= 1);

const useAfterMove = `#![no_std]
#![ownership("strict")]
struct Resource { value: usize }
extern "C" fn acquire() -> Resource;
fn consume(value: Resource) {}
fn inspect(value: *const Resource) {}
fn broken() {
  let resource: Resource = acquire()
  consume(resource)
  inspect(&resource)
}
`;
assert.throws(
  () => compileNativeSystemSource(useAfterMove, { file: 'use-after-move.kr' }),
  error => error.code === 'KR-SAFE-OWN-0002',
);

const conflictingBorrow = `#![no_std]
#![ownership("strict")]
struct Resource { value: usize }
extern "C" fn acquire() -> Resource;
fn broken() {
  let resource: Resource = acquire()
  let shared: *const Resource = &resource
  let exclusive: *mut Resource = &mut resource
  ownership.end_borrow(shared)
  ownership.end_borrow(exclusive)
}
`;
assert.throws(
  () => compileNativeSystemSource(conflictingBorrow, { file: 'borrow-conflict.kr' }),
  error => error.code === 'KR-SAFE-BORROW-0006',
);

const localEscape = `#![no_std]
#![ownership("strict")]
struct Resource { value: usize }
extern "C" fn acquire() -> Resource;
fn broken() -> *const Resource {
  let resource: Resource = acquire()
  return &resource
}
`;
assert.throws(
  () => compileNativeSystemSource(localEscape, { file: 'local-escape.kr' }),
  error => error.code === 'KR-SAFE-LIFETIME-0003',
);

const borrowedReturn = `#![no_std]
#![ownership("strict")]
struct Resource { value: usize }
@returns_borrow("input")
fn identity(input: *const Resource) -> *const Resource {
  return input
}
`;
assert.doesNotThrow(() => compileNativeSystemSource(borrowedReturn, { file: 'borrow-return.kr' }));

const invalidBorrowedReturn = `#![no_std]
#![ownership("strict")]
struct Resource { value: usize }
fn identity(input: *const Resource) -> *const Resource {
  return input
}
`;
assert.throws(
  () => compileNativeSystemSource(invalidBorrowedReturn, { file: 'borrow-contract.kr' }),
  error => error.code === 'KR-SAFE-LIFETIME-0005',
);

const traitsSource = `#![no_std]
#![ownership("audit")]
@copy
struct Point { x: u32, y: u32 }
struct RawHandle { pointer: *mut u8 }
@unsafe_contract("the pointer is uniquely owned and transferred")
@send
struct TransferHandle { pointer: *mut u8 }
`;
const traitReport = report(traitsSource, { mode: 'audit' });
assert.deepEqual(
  {
    copy: traitReport.traits.Point.copy,
    send: traitReport.traits.Point.send,
    sync: traitReport.traits.Point.sync,
  },
  { copy: true, send: true, sync: true },
);
assert.equal(traitReport.traits.RawHandle.send, false);
assert.equal(traitReport.traits.RawHandle.sync, false);
assert.equal(traitReport.traits.TransferHandle.send, true);
assert.equal(traitReport.traits.TransferHandle.sync, false);

const undocumentedUnsafe = `#![no_std]
#![ownership("strict")]
#![deny_undocumented_unsafe]
fn broken() {
  unsafe {
    memory.write<u8>(0xB8000, 75)
  }
}
`;
assert.throws(
  () => compileNativeSystemSource(undocumentedUnsafe, { file: 'unsafe-undocumented.kr' }),
  error => ['KR-SAFE-UNSAFE-0003', 'KR-SAFE-UNSAFE-0002'].includes(error.code),
);

const documentedUnsafe = `#![no_std]
#![ownership("strict")]
#![deny_undocumented_unsafe]
fn valid() {
  unsafe("VGA text memory is mapped and this function owns the first cell") {
    memory.write<u8>(0xB8000, 75)
  }
}
`;
assert.doesNotThrow(() => compileNativeSystemSource(documentedUnsafe, { file: 'unsafe-documented.kr' }));

const sharedStatic = `#![no_std]
#![ownership("audit")]
static mut COUNTER: u64 = 0
fn update() {
  unsafe("single boot CPU before SMP startup") {
    COUNTER = COUNTER + 1
  }
}
`;
const staticReport = report(sharedStatic, { mode: 'audit' });
assert.ok(staticReport.warnings.some(item => item.code === 'KR-SAFE-MEMORY-0001'));

const synchronizedStatic = `#![no_std]
#![ownership("strict")]
@synchronized
static mut COUNTER: u64 = 0
fn update() {
  unsafe("ticket lock is held by the caller") {
    COUNTER = COUNTER + 1
  }
}
`;
assert.doesNotThrow(() => compileNativeSystemSource(synchronizedStatic, { file: 'synchronized.kr' }));

const loopMove = `#![no_std]
#![ownership("strict")]
struct Resource { value: usize }
extern "C" fn acquire() -> Resource;
fn consume(value: Resource) {}
fn broken() {
  let resource: Resource = acquire()
  while true {
    consume(resource)
  }
}
`;
assert.throws(
  () => compileNativeSystemSource(loopMove, { file: 'loop-move.kr' }),
  error => error.code === 'KR-SAFE-OWN-0020',
);

const formatted = formatNativeSafetyReport(traitReport);
assert.match(formatted, /Kura Native Safety/);
assert.match(formatted, /Warnings:/);

console.log('system native safety tests passed');
