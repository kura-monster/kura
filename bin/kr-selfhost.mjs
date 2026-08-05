#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { writeSelfHostArtifacts, verifySelfHostArtifacts, compileWithSelfHostedCompiler, analyzeWithSelfHostedFrontend, parseWithSelfHostedFrontend, solveWithSelfHostedTraitSolver, checkWithSelfHostedBorrowChecker, buildWithSelfHostedCfgRegion, createSelfHostMigrationManifest, SELF_HOST_COMPILER_SOURCE, SELF_HOST_FRONTEND_SOURCE, SELF_HOST_TRAIT_SOLVER_SOURCE, SELF_HOST_CFG_REGION_SOURCE, SELF_HOST_BORROW_CHECKER_SOURCE } from '../lib/self-host.mjs';

const args = process.argv.slice(2);
const command = args.shift() ?? 'help';
const take = (name, fallback = null) => { const index = args.indexOf(name); if (index < 0) return fallback; const value = args[index + 1]; args.splice(index, 2); return value; };
const output = take('-o', take('--output'));
const queryTrait = take('--trait', '');
const queryType = take('--type', '');
const queryAssoc = take('--assoc', '');

function help() {
  console.log('kr-selfhost source\nkr-selfhost frontend-source\nkr-selfhost trait-solver-source\nkr-selfhost cfg-region-source\nkr-selfhost borrow-checker-source\nkr-selfhost manifest\nkr-selfhost compile <file.kr> [-o output.mjs]\nkr-selfhost semantic <file.kr>\nkr-selfhost expression <expression>\nkr-selfhost pattern <pattern>\nkr-selfhost traits <file.kr> [--trait Trait --type Type --assoc Item]\nkr-selfhost cfg <file.kr>\nkr-selfhost regions <file.kr>\nkr-selfhost borrow <file.kr>\nkr-selfhost bootstrap [directory]\nkr-selfhost verify [directory]');
}

try {
  if (command === 'help' || command === '--help' || command === '-h') { help(); process.exit(0); }
  if (command === 'source') console.log(SELF_HOST_COMPILER_SOURCE);
  else if (command === 'frontend-source') console.log(SELF_HOST_FRONTEND_SOURCE);
  else if (command === 'trait-solver-source') console.log(SELF_HOST_TRAIT_SOLVER_SOURCE);
  else if (command === 'cfg-region-source') console.log(SELF_HOST_CFG_REGION_SOURCE);
  else if (command === 'borrow-checker-source') console.log(SELF_HOST_BORROW_CHECKER_SOURCE);
  else if (command === 'manifest') console.log(JSON.stringify(createSelfHostMigrationManifest(), null, 2));
  else if (command === 'compile') {
    const file = args.shift(); if (!file) throw new Error('Source file required.');
    const source = await readFile(resolve(file), 'utf8'); const result = await compileWithSelfHostedCompiler(source);
    if (output) { const destination = resolve(output); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, result.code, 'utf8'); console.log(destination); }
    else console.log(result.code);
  } else if (command === 'semantic') {
    const file = args.shift(); if (!file) throw new Error('Source file required.');
    const source = await readFile(resolve(file), 'utf8');
    console.log(JSON.stringify(await analyzeWithSelfHostedFrontend(source), null, 2));
  } else if (command === 'expression' || command === 'pattern') {
    const source = args.join(' '); if (!source) throw new Error(`${command} source required.`);
    console.log(JSON.stringify(await parseWithSelfHostedFrontend(command, source), null, 2));
  } else if (command === 'traits') {
    const file = args.shift(); if (!file) throw new Error('Source file required.');
    const source = await readFile(resolve(file), 'utf8');
    const result = await solveWithSelfHostedTraitSolver(source, { trait: queryTrait, type: queryType, assoc: queryAssoc });
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } else if (command === 'cfg' || command === 'regions') {
    const file = args.shift(); if (!file) throw new Error('Source file required.');
    const source = await readFile(resolve(file), 'utf8');
    const result = await buildWithSelfHostedCfgRegion(source);
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } else if (command === 'borrow') {
    const file = args.shift(); if (!file) throw new Error('Source file required.');
    const source = await readFile(resolve(file), 'utf8');
    const result = await checkWithSelfHostedBorrowChecker(source);
    console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } else if (command === 'bootstrap') {
    const result = await writeSelfHostArtifacts(args[0] ?? 'build/self-host');
    console.log(JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, files: result.files, stage1Version: result.stage1Version, frontendVersion: result.frontendVersion, frontendAnalysis: result.frontendSelfAnalysis, migration: result.migration, capabilities: result.capabilities }, null, 2));
  } else if (command === 'verify') {
    const result = await verifySelfHostArtifacts(args[0] ?? 'build/self-host'); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } else throw new Error(`Unknown command ${command}.`);
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
