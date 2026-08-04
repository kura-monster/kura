#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  analyzeLanguage,
  compileLanguage,
  formatLanguageReport,
  parseLanguage,
} from '../lib/language-core.mjs';

function usage() {
  return `Kura typed language core

Usage:
  kr-language check <file.kr> [--json]
  kr-language build <file.kr> [-o output.mjs]
  kr-language run <file.kr>
  kr-language ast <file.kr> [--json]
  kr-language mir <file.kr> [--json]

Features:
  generics and where constraints
  traits and impl validation
  enum and exhaustive match
  closures with capture analysis
  Result propagation with ?
  RAII Drop plans and defer
  partial move and non-lexical borrow analysis`;
}

function parseArgs(argv) {
  const positional = [];
  const options = { json: false, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '-o' || argv[i] === '--output') options.output = argv[++i];
    else positional.push(argv[i]);
  }
  return { command: positional[0], file: positional[1], options };
}

async function main() {
  const { command, file, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') { console.log(usage()); return; }
  if (!file) throw new Error(`${command} requires a .kr file.`);
  const source = await readFile(file, 'utf8');
  if (command === 'check') {
    const report = analyzeLanguage(source, { file });
    process.stdout.write(formatLanguageReport(report, { json: options.json }));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (command === 'ast') {
    console.log(JSON.stringify(parseLanguage(source, { file }), null, 2));
    return;
  }
  if (command === 'mir') {
    const report = analyzeLanguage(source, { file });
    console.log(JSON.stringify({ dropPlans: report.dropPlans, borrowFacts: report.borrowFacts, closures: report.closures, specializations: report.specializations }, null, 2));
    return;
  }
  if (command === 'build' || command === 'run') {
    const result = compileLanguage(source, { file, autoRun: command === 'run' });
    const output = path.resolve(options.output ?? `${file.replace(/\.kr$/i, '')}.mjs`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, result.code, 'utf8');
    if (command === 'build') console.log(output);
    else await import(`${pathToFileURL(output).href}?t=${Date.now()}`);
    return;
  }
  throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
}

main().catch(error => {
  const location = error?.file ? `${error.file}:${error.line}:${error.column}: ` : '';
  console.error(`${location}${error?.code ? `${error.code}: ` : ''}${error.message ?? error}`);
  if (error?.hint) console.error(`hint: ${error.hint}`);
  process.exitCode = 1;
});
