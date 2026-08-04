// SPDX-License-Identifier: MIT OR Apache-2.0

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileLanguage } from './language-core.mjs';

export const SELF_HOST_COMPILER_SOURCE = `pub fn compile_program(source: String) -> String {
  let header_end = source.indexOf("{")
  let footer = source.lastIndexOf("}")
  let header = source.slice(0, header_end).trim()
  let body = source.slice(header_end + 1, footer)
  let name_start = header.indexOf("fn ") + 3
  let name_end = header.indexOf("(")
  let name = header.slice(name_start, name_end).trim()
  let parameter_start = name_end + 1
  let parameter_end = header.indexOf(")")
  let parameter_text = header.slice(parameter_start, parameter_end).trim()
  let colon = parameter_text.indexOf(":")
  let parameter = parameter_text.slice(0, colon).trim()
  let let_keyword = "le" + "t "
  let const_keyword = "con" + "st "
  let js_body = body.replaceAll(let_keyword, const_keyword)
  return "export function " + name + "(" + parameter + ") {" + js_body + "}\\n"
}
`;

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
  const probeSource = options.probeSource ?? 'pub fn answer(source: String) -> String { return source.trim() }';
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
    hashes: { source: hash(source), stage0: hash(stage0.code), stage2: hash(stage2Code), stage3: hash(stage3Code) },
    capabilities: {
      compilerWrittenInKura: true,
      selfReproduction: true,
      fixedPoint: true,
      supportedBootstrapSubset: ['single exported function', 'typed single parameter', 'String operations', 'let bindings', 'return expressions', 'method calls'],
      fullCompilerMigration: false,
    },
  };
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
  await writeFile(files.report, JSON.stringify({ fixedPoint: result.fixedPoint, hashes: result.hashes, probeResult: result.probeResult, capabilities: result.capabilities }, null, 2) + '\n');
  return { ...result, files };
}

export async function verifySelfHostArtifacts(directory) {
  const source = await readFile(resolve(directory, 'compiler.kr'), 'utf8');
  const stage1 = await readFile(resolve(directory, 'compiler-stage1.mjs'), 'utf8');
  const module = await import(pathToFileURL(resolve(directory, 'compiler-stage1.mjs')).href + `?v=${Date.now()}`);
  const reproduced = module.compile_program(source);
  return { ok: reproduced === stage1, expectedHash: hash(stage1), actualHash: hash(reproduced) };
}
