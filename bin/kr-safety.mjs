#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { NativeCompiler } from '../lib/system-native-compiler.mjs';
import { parseNativeSystemSource } from '../lib/system-native-parser.mjs';
import {
  SAFETY_ERROR_EXPLANATIONS,
  formatNativeSafetyReport,
} from '../lib/system-native-safety.mjs';

function usage() {
  return `Kura native ownership and safety checker

Usage:
  kr-safety check <file.kr> [--deny-undocumented-unsafe]
  kr-safety audit <file.kr> [--json] [--deny-undocumented-unsafe]
  kr-safety traits <file.kr> [--json]
  kr-safety explain <KR-SAFE-CODE>

Safety language contracts:
  #![ownership("strict")]
  #![deny_undocumented_unsafe]
  @copy, @must_use, @send, @sync, @no_send, @no_sync
  @unsafe_contract("...")
  @returns_borrow("parameter")
  @thread_local, @synchronized

Ownership operations:
  ownership.move(value)
  ownership.borrow(value)
  ownership.borrow_mut(value)
  ownership.end_borrow(reference)
  ownership.drop(value)
  ownership.clone_copy(value)`;
}

function parseArguments(argv) {
  const positional = [];
  const options = { json: false, denyUndocumentedUnsafe: false, help: false };
  for (const argument of argv) {
    if (argument === '--json') options.json = true;
    else if (argument === '--deny-undocumented-unsafe') options.denyUndocumentedUnsafe = true;
    else if (argument === '-h' || argument === '--help') options.help = true;
    else positional.push(argument);
  }
  return { command: positional[0], value: positional[1], options };
}

function renderFailure(error) {
  if (error?.file && error?.line && error?.column) {
    const code = error.code ? `${error.code}: ` : '';
    const hint = error.hint ? `\nhint: ${error.hint}` : '';
    return `${error.file}:${error.line}:${error.column}: ${code}${error.message}${hint}`;
  }
  return error?.stack ?? String(error);
}

async function compileReport(file, options, mode) {
  const source = await readFile(file, 'utf8');
  const program = parseNativeSystemSource(source, { file });
  const compiler = new NativeCompiler(program, {
    file,
    safetyMode: mode,
    denyUndocumentedUnsafe: options.denyUndocumentedUnsafe,
  });
  compiler.validate();
  return compiler.safetyReport;
}

async function main() {
  const { command, value, options } = parseArguments(process.argv.slice(2));
  if (!command || options.help) {
    console.log(usage());
    return;
  }
  if (command === 'explain') {
    if (!value) throw new Error('explain requires a KR-SAFE error code.');
    const explanation = SAFETY_ERROR_EXPLANATIONS[value];
    if (!explanation) throw new Error(`Unknown safety code '${value}'.`);
    console.log(`${value}\n${explanation}`);
    return;
  }
  if (!value) throw new Error(`${command} requires a .kr source file.`);
  if (command === 'check') {
    const report = await compileReport(value, options, 'strict');
    console.log(`${value}: ownership, borrow, lifetime, Send/Sync, and unsafe checks passed`);
    if (report.warnings.length) console.log(formatNativeSafetyReport(report));
    return;
  }
  if (command === 'audit') {
    const report = await compileReport(value, options, 'audit');
    process.stdout.write(formatNativeSafetyReport(report, { json: options.json }));
    if (report.errors.length) process.exitCode = 1;
    return;
  }
  if (command === 'traits') {
    const report = await compileReport(value, options, 'audit');
    if (options.json) console.log(JSON.stringify(report.traits, null, 2));
    else {
      for (const [name, traits] of Object.entries(report.traits)) {
        console.log(`${name}: Copy=${traits.copy} Send=${traits.send} Sync=${traits.sync}`);
      }
    }
    return;
  }
  throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
}

main().catch(error => {
  console.error(renderFailure(error));
  process.exitCode = 1;
});
