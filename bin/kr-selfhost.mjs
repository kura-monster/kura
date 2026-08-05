#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { writeSelfHostArtifacts, verifySelfHostArtifacts, compileWithSelfHostedCompiler, createSelfHostMigrationManifest, SELF_HOST_COMPILER_SOURCE, SELF_HOST_FRONTEND_SOURCE } from '../lib/self-host.mjs';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const take = (name, fallback = null) => { const index = args.indexOf(name); if (index < 0) return fallback; const value = args[index + 1]; args.splice(index, 2); return value; };
const output = take('-o', take('--output'));

function help() {
  console.log('kr-selfhost source\nkr-selfhost frontend-source\nkr-selfhost manifest\nkr-selfhost compile <file.kr> [-o output.mjs]\nkr-selfhost bootstrap [directory]\nkr-selfhost verify [directory]');
}

try {
  if (command === 'help' || command === '--help' || command === '-h') { help(); process.exit(0); }
  if (command === 'source') console.log(SELF_HOST_COMPILER_SOURCE);
  else if (command === 'frontend-source') console.log(SELF_HOST_FRONTEND_SOURCE);
  else if (command === 'manifest') console.log(JSON.stringify(createSelfHostMigrationManifest(), null, 2));
  else if (command === 'compile') {
    const file = args.shift(); if (!file) throw new Error('Source file required.');
    const source = await readFile(resolve(file), 'utf8'); const result = await compileWithSelfHostedCompiler(source);
    if (output) { const destination = resolve(output); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, result.code, 'utf8'); console.log(destination); }
    else console.log(result.code);
  } else if (command === 'bootstrap') {
    const result = await writeSelfHostArtifacts(args[0] ?? 'build/self-host');
    console.log(JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, files: result.files, stage1Version: result.stage1Version, frontendVersion: result.frontendVersion, frontendAnalysis: result.frontendSelfAnalysis, migration: result.migration, capabilities: result.capabilities }, null, 2));
  } else if (command === 'verify') {
    const result = await verifySelfHostArtifacts(args[0] ?? 'build/self-host'); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } else throw new Error(`Unknown command ${command}.`);
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
