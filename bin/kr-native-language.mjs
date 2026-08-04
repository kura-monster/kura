#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compileLanguageNative } from '../lib/language-native-backend.mjs';

const args = process.argv.slice(2); const command = args.shift() ?? 'help';
const option = (name, fallback = null) => { const index = args.indexOf(name); if (index < 0) return fallback; const value = args[index + 1]; args.splice(index, 2); return value; };
const flag = name => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
const output = option('-o', option('--output')); const json = flag('--json');
function help() { console.log(`Kura high-level native backend\n\nkr-native-language check <file.kr>\nkr-native-language emit <file.kr> -o output.ll\nkr-native-language manifest <file.kr> [--json]\nkr-native-language object <file.kr> -o output.o\n`); }
function run(command, argv) { return new Promise((resolvePromise, reject) => { const child = spawn(command, argv, { stdio: 'inherit', windowsHide: true }); child.once('error', reject); child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}.`))); }); }
try {
  if (command === 'help' || command === '--help' || command === '-h') { help(); process.exit(0); }
  const file = args.shift(); if (!file) throw new Error('A Kura source file is required.');
  const source = await readFile(resolve(file), 'utf8'); const result = compileLanguageNative(source, { file: resolve(file) });
  if (command === 'check') console.log(`${file}: high-level native lowering passed (${result.manifest.hash.slice(0, 12)})`);
  else if (command === 'manifest') console.log(json ? JSON.stringify(result.manifest, null, 2) : `Target: ${result.manifest.target}\nTypes: ${Object.keys(result.manifest.types).length}\nSpecializations: ${result.manifest.specializations.length}\nVTables: ${result.manifest.traitVTables.length}\nClosures: ${result.manifest.closures.length}\nAwait sites: ${result.manifest.asyncAwaitSites.length}\nHash: ${result.manifest.hash}`);
  else if (command === 'emit' || command === 'object') {
    const destination = resolve(output ?? (command === 'emit' ? file.replace(/\.kr$/, '.ll') : file.replace(/\.kr$/, '.o'))); await mkdir(dirname(destination), { recursive: true });
    if (command === 'emit') await writeFile(destination, result.ir);
    else { const llvm = destination.replace(/\.o$/, '.ll'); await writeFile(llvm, result.ir); await run(process.env.CLANG ?? 'clang', ['-Wno-override-module', '-c', llvm, '-o', destination]); }
    console.log(destination);
  } else throw new Error(`Unknown command '${command}'.`);
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
