// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLanguage } from './language-core.mjs';

export const SELF_HOST_COMPILER_SOURCE = `pub fn compiler_version() -> String {
  return "1.1-stage1"
}

fn strip_scalar_types(source: String) -> String {
  let colon = ":"
  let arrow = " -" + ">"
  let space = " "
  let empty = ""
  let string_name = "String"
  let bool_name = "bool"
  let i32_name = "i32"
  let u32_name = "u32"
  let usize_name = "usize"
  return source
    .replaceAll(colon + space + string_name, empty)
    .replaceAll(colon + space + bool_name, empty)
    .replaceAll(colon + space + i32_name, empty)
    .replaceAll(colon + space + u32_name, empty)
    .replaceAll(colon + space + usize_name, empty)
    .replaceAll(arrow + space + string_name, empty)
    .replaceAll(arrow + space + bool_name, empty)
    .replaceAll(arrow + space + i32_name, empty)
    .replaceAll(arrow + space + u32_name, empty)
    .replaceAll(arrow + space + usize_name, empty)
}

pub fn compile_program(source: String) -> String {
  let pub_keyword = "p" + "ub "
  let async_keyword = "a" + "sync "
  let function_keyword = "f" + "n "
  let export_keyword = "ex" + "port "
  let javascript_function = "fun" + "ction "
  let let_keyword = "le" + "t "
  let let_mut_keyword = "le" + "t mut "
  let const_keyword = "con" + "st "
  let mutable_marker = "__KURA_" + "MUTABLE_BINDING__"
  return strip_scalar_types(source)
    .replaceAll(pub_keyword + async_keyword + function_keyword, export_keyword + async_keyword + javascript_function)
    .replaceAll(pub_keyword + function_keyword, export_keyword + javascript_function)
    .replaceAll(async_keyword + function_keyword, async_keyword + javascript_function)
    .replaceAll(function_keyword, javascript_function)
    .replaceAll(let_mut_keyword, mutable_marker)
    .replaceAll(let_keyword, const_keyword)
    .replaceAll(mutable_marker, let_keyword)
}
`;

export function createSelfHostMigrationManifest() {
  return Object.freeze({
    stage: 'module-compiler',
    migrated: Object.freeze([
      'bootstrap source transformation',
      'multi-function module emission',
      'scalar type erasure',
      'export/private function lowering',
      'async function syntax lowering',
      'immutable/mutable binding lowering',
      'fixed-point reproduction',
    ]),
    integration: Object.freeze({ stage0Frontend: 'JavaScript trusted compiler', stage1Compiler: 'Kura source compiled by Stage 0', stage2Compiler: 'Stage 1 self-reproduction', fixedPointRequired: true }),
    remaining: Object.freeze(['tokenizer migration', 'typed parser migration', 'trait solver migration', 'borrow checker migration', 'LLVM backend migration', 'package manager migration']),
    fullCompilerMigration: false,
  });
}

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
async function importText(code, nonce = '') { return import(`data:text/javascript;base64,${Buffer.from(`${code}\n//${nonce}`).toString('base64')}`); }

export async function bootstrapSelfHostedCompiler(options = {}) {
  const source = options.source ?? SELF_HOST_COMPILER_SOURCE;
  const stage0 = compileLanguage(source, { file: options.file ?? 'self-host/compiler.kr', autoRun: false });
  const stage1Module = await importText(stage0.code, 'stage1');
  if (typeof stage1Module.compile_program !== 'function') throw new Error('Stage 0 did not produce the self-host compile_program function.');
  const stage2Code = stage1Module.compile_program(source);
  const stage2Module = await importText(stage2Code, 'stage2');
  if (typeof stage2Module.compile_program !== 'function') throw new Error('Stage 1 failed to reproduce the compiler.');
  const stage3Code = stage2Module.compile_program(source);
  const fixedPoint = stage2Code === stage3Code;
  if (!fixedPoint) throw new Error('Self-host compiler failed fixed-point verification.');
  const probeSource = options.probeSource ?? 'pub fn normalize(source: String) -> String { return source.trim() }\npub fn answer(source: String) -> String { return normalize(source) }';
  const probeCode = stage2Module.compile_program(probeSource);
  const probeModule = await importText(probeCode, 'probe');
  const probeResult = probeModule.answer('  Kura  ');
  if (probeResult !== 'Kura') throw new Error(`Self-host probe returned ${JSON.stringify(probeResult)}.`);
  return {
    fixedPoint,
    source,
    stage0Code: stage0.code,
    stage2Code,
    stage3Code,
    probeSource,
    probeCode,
    probeResult,
    stage1Version: stage2Module.compiler_version?.() ?? null,
    migration: createSelfHostMigrationManifest(),
    hashes: { source: hash(source), stage0: hash(stage0.code), stage2: hash(stage2Code), stage3: hash(stage3Code) },
    capabilities: {
      compilerWrittenInKura: true,
      selfReproduction: true,
      fixedPoint: true,
      supportedBootstrapSubset: ['multi-function modules', 'exported and private functions', 'async function syntax', 'String/bool/i32/u32/usize annotations', 'immutable and mutable bindings', 'arithmetic expressions', 'method calls', 'cross-function calls'],
      moduleCompilerMigrated: true,
      fullCompilerMigration: false,
    },
  };
}

export async function compileWithSelfHostedCompiler(source, options = {}) {
  const bootstrap = await bootstrapSelfHostedCompiler(options);
  const compiler = await importText(bootstrap.stage2Code, `compile-${Date.now()}`);
  const code = compiler.compile_program(source);
  return { code, compilerHash: bootstrap.hashes.stage2, compilerVersion: compiler.compiler_version?.() ?? bootstrap.stage1Version, migration: bootstrap.migration };
}

export async function writeSelfHostArtifacts(directory, options = {}) {
  const output = resolve(directory); await mkdir(output, { recursive: true });
  const result = await bootstrapSelfHostedCompiler(options);
  const files = {
    source: resolve(output, 'compiler.kr'),
    stage0: resolve(output, 'compiler-stage0.mjs'),
    stage1: resolve(output, 'compiler-stage1.mjs'),
    report: resolve(output, 'self-host-report.json'),
  };
  await writeFile(files.source, result.source);
  await writeFile(files.stage0, result.stage0Code);
  await writeFile(files.stage1, result.stage2Code);
  await writeFile(files.report, JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, probeResult: result.probeResult, stage1Version: result.stage1Version, migration: result.migration, capabilities: result.capabilities }, null, 2) + '\n');
  return { ...result, files };
}

export async function verifySelfHostArtifacts(directory) {
  const source = await readFile(resolve(directory, 'compiler.kr'), 'utf8');
  const stage1 = await readFile(resolve(directory, 'compiler-stage1.mjs'), 'utf8');
  const module = await import(pathToFileURL(resolve(directory, 'compiler-stage1.mjs')).href + `?v=${Date.now()}`);
  const reproduced = module.compile_program(source);
  return { ok: reproduced === stage1, expectedHash: hash(stage1), actualHash: hash(reproduced) };
}
