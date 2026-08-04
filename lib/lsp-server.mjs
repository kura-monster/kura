// SPDX-License-Identifier: MIT OR Apache-2.0
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, parse } from './compiler.mjs';
import { formatKura } from './formatter.mjs';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const KEYWORDS = [
  'fn', 'let', 'const', 'if', 'else', 'while', 'for', 'in', 'return', 'true', 'false',
  'null', 'struct', 'enum', 'match', 'import', 'from', 'export', 'async', 'await',
  'trait', 'impl', 'where', 'pure', 'kernel', 'comptime', 'test',
];

const BUILTINS = {
  println: { signature: 'println(value)', documentation: 'Prints a value followed by a newline.' },
  print: { signature: 'print(value)', documentation: 'Writes a value without adding a newline.' },
  len: { signature: 'len(value) -> int', documentation: 'Returns the length of a string, array, or collection.' },
  str: { signature: 'str(value) -> string', documentation: 'Converts a value to a string.' },
  int: { signature: 'int(value) -> int', documentation: 'Converts a value to an integer.' },
  float: { signature: 'float(value) -> float', documentation: 'Converts a value to a floating-point number.' },
  range: { signature: 'range(start, end)', documentation: 'Creates an integer range from start (inclusive) to end (exclusive).' },
  panic: { signature: 'panic(message)', documentation: 'Stops execution with an error message.' },
  assert: { signature: 'assert(condition, message?)', documentation: 'Fails the current test when condition is false.' },
  assert_eq: { signature: 'assert_eq(actual, expected, message?)', documentation: 'Fails unless actual and expected are equal.' },
  assert_ne: { signature: 'assert_ne(actual, expected, message?)', documentation: 'Fails when actual and expected are equal.' },
  assert_deep_eq: { signature: 'assert_deep_eq(actual, expected, message?)', documentation: 'Deeply compares arrays and objects.' },
  fail: { signature: 'fail(message?)', documentation: 'Immediately fails the current test.' },
};

const STD_MODULES = [
  'ai', 'assert', 'cli', 'collections', 'crypto', 'encoding', 'env', 'fs', 'http',
  'json', 'log', 'math', 'path', 'process', 'random', 'testing', 'time', 'url',
];

const KURA_AI_MEMBERS = {
  client: 'Kura.ai.client(baseUrl, apiKey, model)',
  message: 'Kura.ai.message(role, content)',
  system: 'Kura.ai.system(content)',
  user: 'Kura.ai.user(content)',
  assistant: 'Kura.ai.assistant(content)',
  toolMessage: 'Kura.ai.toolMessage(content)',
  schema: 'Kura.ai.schema(json)',
  tool: 'Kura.ai.tool(name, description, schema, handler)',
};

const SYMBOL_KIND = {
  Function: 12,
  Struct: 23,
  Enum: 10,
  Variable: 13,
  Test: 12,
  Trait: 11,
};

const COMPLETION_KIND = {
  Text: 1, Method: 2, Function: 3, Constructor: 4, Field: 5, Variable: 6,
  Class: 7, Interface: 8, Module: 9, Property: 10, Unit: 11, Value: 12,
  Enum: 13, Keyword: 14, Snippet: 15,
};

export function startLanguageServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const logger = options.logger ?? ((message) => process.stderr.write(`[kura-lsp] ${message}\n`));
  const documents = new Map();
  const stdlibRoot = options.stdlibRoot ?? process.env.KURA_LSP_STDLIB ?? path.join(packageRoot, 'std');
  let shutdownRequested = false;
  let buffer = Buffer.alloc(0);

  const send = payload => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };

  const publishDiagnostics = uri => {
    const document = documents.get(uri);
    if (!document) return;
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: getDiagnostics(document.text, uri, { stdlibRoot }) },
    });
  };

  const handlers = {
    initialize(params) {
      return {
        capabilities: {
          textDocumentSync: 1,
          completionProvider: { resolveProvider: false, triggerCharacters: ['.', ':', '"'] },
          hoverProvider: true,
          definitionProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          documentFormattingProvider: true,
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
          codeActionProvider: true,
        },
        serverInfo: { name: 'Kura Language Server', version: '0.1.0' },
      };
    },
    initialized() {
      logger('initialized');
      return null;
    },
    shutdown() {
      shutdownRequested = true;
      return null;
    },
    exit() {
      process.exitCode = shutdownRequested ? 0 : 1;
      input.pause?.();
      return null;
    },
    'textDocument/didOpen'(params) {
      const item = params.textDocument;
      documents.set(item.uri, { text: item.text, version: item.version ?? 0 });
      publishDiagnostics(item.uri);
      return null;
    },
    'textDocument/didChange'(params) {
      const current = documents.get(params.textDocument.uri) ?? { text: '', version: 0 };
      const change = params.contentChanges?.at(-1);
      documents.set(params.textDocument.uri, {
        text: change?.text ?? current.text,
        version: params.textDocument.version ?? current.version,
      });
      publishDiagnostics(params.textDocument.uri);
      return null;
    },
    'textDocument/didClose'(params) {
      documents.delete(params.textDocument.uri);
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: params.textDocument.uri, diagnostics: [] } });
      return null;
    },
    'textDocument/completion'(params) {
      const document = documents.get(params.textDocument.uri);
      return document ? getCompletions(document.text, params.position) : [];
    },
    'textDocument/hover'(params) {
      const document = documents.get(params.textDocument.uri);
      return document ? getHover(document.text, params.position) : null;
    },
    'textDocument/definition'(params) {
      const document = documents.get(params.textDocument.uri);
      if (!document) return null;
      const word = wordAt(document.text, params.position);
      if (!word) return null;
      for (const [uri, item] of documents) {
        const declaration = findDeclaration(item.text, word);
        if (declaration) return { uri, range: declaration.range };
      }
      return null;
    },
    'textDocument/documentSymbol'(params) {
      const document = documents.get(params.textDocument.uri);
      return document ? getDocumentSymbols(document.text) : [];
    },
    'workspace/symbol'(params) {
      const query = String(params.query ?? '').toLowerCase();
      const output = [];
      for (const [uri, item] of documents) {
        for (const symbol of getDocumentSymbols(item.text)) {
          if (!query || symbol.name.toLowerCase().includes(query)) output.push({ ...symbol, location: { uri, range: symbol.range } });
        }
      }
      return output;
    },
    'textDocument/formatting'(params) {
      const document = documents.get(params.textDocument.uri);
      if (!document) return [];
      try {
        const formatted = formatKura(document.text, {
          indentWidth: params.options?.tabSize ?? 2,
          useTabs: params.options?.insertSpaces === false,
        });
        if (formatted === document.text) return [];
        return [{ range: fullDocumentRange(document.text), newText: formatted }];
      } catch {
        return [];
      }
    },
    'textDocument/signatureHelp'(params) {
      const document = documents.get(params.textDocument.uri);
      return document ? getSignatureHelp(document.text, params.position) : null;
    },
    'textDocument/codeAction'(params) {
      const actions = [];
      if (params.context?.diagnostics?.length) {
        actions.push({
          title: 'Format Kura document',
          kind: 'source.fixAll.kura',
          command: { title: 'Format Kura document', command: 'kura.formatDocument' },
        });
      }
      return actions;
    },
  };

  const processMessage = async message => {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
    const handler = handlers[message.method];
    if (!handler) {
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      return;
    }
    try {
      const result = await handler(message.params ?? {});
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
    } catch (error) {
      logger(error?.stack ?? String(error));
      if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error?.message ?? String(error) } });
    }
  };

  input.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      try {
        void processMessage(JSON.parse(body));
      } catch (error) {
        logger(`invalid JSON-RPC payload: ${error.message}`);
      }
    }
  });

  input.resume?.();
  return { documents, send, close: () => input.pause?.() };
}

export function getDiagnostics(text, uri = '<input>', options = {}) {
  const file = uriToFile(uri);
  const report = diagnose(text, { file, stdlibRoot: options.stdlibRoot ?? process.env.KURA_LSP_STDLIB ?? path.join(packageRoot, 'std') });
  return (report.messages ?? []).map(message => ({
    range: rangeFromMessage(message, text),
    severity: severityNumber(message.severity),
    code: message.code ?? 'KR-CHECK-0001',
    source: 'Kura',
    message: [message.title, message.message, message.hint ? `Help: ${message.hint}` : null].filter(Boolean).join('\n'),
  }));
}

export function getCompletions(text, position) {
  const before = textBeforePosition(text, position);
  if (/std:\s*["'][^"']*$/.test(before)) {
    return STD_MODULES.map(name => ({ label: name, kind: COMPLETION_KIND.Module, detail: `std:${name}`, insertText: name }));
  }
  if (/Kura\.ai\.[A-Za-z_]*$/.test(before)) {
    return Object.entries(KURA_AI_MEMBERS).map(([label, detail]) => ({ label, kind: COMPLETION_KIND.Method, detail }));
  }
  const items = [
    ...KEYWORDS.map(label => ({ label, kind: COMPLETION_KIND.Keyword, detail: 'Kura keyword' })),
    ...Object.entries(BUILTINS).map(([label, value]) => ({ label, kind: COMPLETION_KIND.Function, detail: value.signature, documentation: value.documentation })),
    ...STD_MODULES.map(label => ({ label: `std:${label}`, kind: COMPLETION_KIND.Module, detail: 'Kura standard library module' })),
    { label: 'fn', kind: COMPLETION_KIND.Snippet, detail: 'Function declaration', insertTextFormat: 2, insertText: 'fn ${1:name}(${2})${3: -> ${4:type}} {\n  ${0}\n}' },
    { label: 'test', kind: COMPLETION_KIND.Snippet, detail: 'Kura test', insertTextFormat: 2, insertText: 'test "${1:name}" {\n  ${0}\n}' },
    { label: 'main', kind: COMPLETION_KIND.Snippet, detail: 'Main function', insertTextFormat: 2, insertText: 'fn main() {\n  ${0}\n}' },
    { label: 'import std', kind: COMPLETION_KIND.Snippet, detail: 'Import a standard library module', insertTextFormat: 2, insertText: 'import { ${1:name} } from std:"${2:module}";' },
  ];
  for (const declaration of collectDeclarations(text)) {
    items.push({
      label: declaration.name,
      kind: declaration.kind === 'Function' || declaration.kind === 'Test' ? COMPLETION_KIND.Function : declaration.kind === 'Variable' ? COMPLETION_KIND.Variable : COMPLETION_KIND.Class,
      detail: declaration.detail,
    });
  }
  return deduplicateByLabel(items);
}

export function getHover(text, position) {
  const word = wordAt(text, position);
  if (!word) return null;
  if (BUILTINS[word]) return markdownHover(`\`${BUILTINS[word].signature}\`\n\n${BUILTINS[word].documentation}`);
  if (KEYWORDS.includes(word)) return markdownHover(`**${word}** — Kura language keyword.`);
  if (STD_MODULES.includes(word) && /std:\s*["'][^"']*$/.test(textBeforePosition(text, position))) {
    return markdownHover(`\`std:${word}\`\n\nBuilt-in Kura standard library module.`);
  }
  const aiEntry = KURA_AI_MEMBERS[word];
  if (aiEntry && /Kura\.ai\./.test(textBeforePosition(text, position))) return markdownHover(`\`${aiEntry}\`\n\nKura.ai native primitive.`);
  const declaration = findDeclaration(text, word);
  return declaration ? markdownHover(`\`${declaration.detail}\``) : null;
}

export function getDocumentSymbols(text) {
  return collectDeclarations(text).map(item => ({
    name: item.name,
    detail: item.detail,
    kind: SYMBOL_KIND[item.kind] ?? 13,
    range: item.range,
    selectionRange: item.range,
  }));
}

export function getSignatureHelp(text, position) {
  const before = textBeforePosition(text, position);
  const match = /([A-Za-z_][A-Za-z0-9_.]*)\s*\(([^()]*)$/.exec(before);
  if (!match) return null;
  const name = match[1].split('.').at(-1);
  const activeParameter = Math.max(0, match[2].split(',').length - 1);
  let signature = BUILTINS[name]?.signature ?? Object.values(KURA_AI_MEMBERS).find(item => item.includes(`.${name}(`));
  if (!signature) {
    const declaration = findDeclaration(text, name);
    signature = declaration?.detail;
  }
  if (!signature) return null;
  const parameters = signatureParameters(signature).map(label => ({ label }));
  return { signatures: [{ label: signature, parameters }], activeSignature: 0, activeParameter: Math.min(activeParameter, Math.max(0, parameters.length - 1)) };
}

function collectDeclarations(text) {
  const declarations = [];
  try {
    const ast = parse(text, { file: '<lsp>' });
    walkNodes(ast.body ?? [], node => {
      const kind = node.kind;
      if (!['Function', 'Struct', 'Enum', 'Variable', 'Test'].includes(kind)) return;
      const name = kind === 'Test' ? node.name : node.name;
      if (!name) return;
      const location = findNameRange(text, name, node.line ?? 1, node.column ?? 1);
      declarations.push({ name, kind, detail: declarationDetail(node), range: location });
    });
  } catch {
    const pattern = /\b(?:async\s+|pure\s+|kernel\s+|export\s+)*(fn|struct|enum|trait|let|const)\s+([A-Za-z_][A-Za-z0-9_]*)|\b(?:async\s+)?test\s+["']([^"']+)["']/g;
    let match;
    while ((match = pattern.exec(text))) {
      const name = match[2] ?? match[3];
      const offset = match.index + match[0].lastIndexOf(name);
      const start = positionAt(text, offset);
      declarations.push({ name, kind: titleCase(match[1] ?? 'test'), detail: match[0], range: { start, end: { line: start.line, character: start.character + name.length } } });
    }
  }
  return declarations;
}

function walkNodes(nodes, visit) {
  for (const node of nodes) {
    visit(node);
    if (Array.isArray(node.body)) walkNodes(node.body, visit);
    if (Array.isArray(node.consequent)) walkNodes(node.consequent, visit);
    if (Array.isArray(node.alternate)) walkNodes(node.alternate, visit);
  }
}

function declarationDetail(node) {
  switch (node.kind) {
    case 'Function': return `${node.async ? 'async ' : ''}fn ${node.name}(${(node.params ?? []).map(item => item.name + (item.type ? `: ${item.type}` : '')).join(', ')})${node.returnType ? ` -> ${node.returnType}` : ''}`;
    case 'Struct': return `struct ${node.name}`;
    case 'Enum': return `enum ${node.name}`;
    case 'Variable': return `${node.keyword ?? 'let'} ${node.name}${node.type ? `: ${node.type}` : ''}`;
    case 'Test': return `${node.async ? 'async ' : ''}test ${JSON.stringify(node.name)}`;
    default: return node.name;
  }
}

function findDeclaration(text, name) {
  return collectDeclarations(text).find(item => item.name === name) ?? null;
}

function findNameRange(text, name, line, column) {
  const lines = text.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length - 1, line - 1));
  const character = Math.max(0, lines[index]?.indexOf(name, Math.max(0, column - 1)) ?? 0);
  return { start: { line: index, character }, end: { line: index, character: character + name.length } };
}

function rangeFromMessage(message, text) {
  const lines = String(text).split(/\r?\n/);
  const line = Math.max(0, Math.min(lines.length - 1, Number(message.line ?? 1) - 1));
  const character = Math.max(0, Math.min(lines[line]?.length ?? 0, Number(message.column ?? 1) - 1));
  const length = Math.max(1, Number(message.length ?? 1));
  return { start: { line, character }, end: { line, character: Math.min((lines[line]?.length ?? character) + 1, character + length) } };
}

function severityNumber(value) {
  return value === 'warning' ? 2 : value === 'information' ? 3 : value === 'hint' ? 4 : 1;
}

function fullDocumentRange(text) {
  const lines = String(text).split(/\r?\n/);
  return { start: { line: 0, character: 0 }, end: { line: Math.max(0, lines.length - 1), character: lines.at(-1)?.length ?? 0 } };
}

function textBeforePosition(text, position) {
  return String(text).slice(0, offsetAt(text, position));
}

function wordAt(text, position) {
  const offset = offsetAt(text, position);
  const source = String(text);
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1])) start--;
  while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end++;
  return source.slice(start, end) || null;
}

function offsetAt(text, position) {
  const lines = String(text).split(/\r?\n/);
  let offset = 0;
  const line = Math.max(0, Math.min(lines.length - 1, position?.line ?? 0));
  for (let index = 0; index < line; index++) offset += lines[index].length + 1;
  return offset + Math.max(0, Math.min(lines[line]?.length ?? 0, position?.character ?? 0));
}

function positionAt(text, offset) {
  const source = String(text);
  const safe = Math.max(0, Math.min(source.length, offset));
  const before = source.slice(0, safe);
  const lines = before.split(/\r?\n/);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function signatureParameters(signature) {
  const match = /\((.*)\)/.exec(signature);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map(item => item.trim());
}

function markdownHover(value) {
  return { contents: { kind: 'markdown', value } };
}

function deduplicateByLabel(items) {
  const seen = new Set();
  return items.filter(item => !seen.has(item.label) && seen.add(item.label));
}

function titleCase(value) {
  return String(value).slice(0, 1).toUpperCase() + String(value).slice(1);
}

function uriToFile(uri) {
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  } catch {
    return path.basename(uri);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) startLanguageServer();
