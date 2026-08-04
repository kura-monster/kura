// SPDX-License-Identifier: MIT OR Apache-2.0
import { formatSystemType, parseSystemType } from './system.mjs';
import { attribute, fail, hasAttribute, isPointer, typeEquals } from './system-native-common.mjs';

const OWNERSHIP_MODES = new Set(['compat', 'audit', 'strict']);
const UNSAFE_PATH_PREFIXES = [
  'memory.', 'pointer.', 'function.address', 'function.call', 'cpu.', 'io.', 'atomic.',
];
const TRAIT_OVERRIDE_ATTRIBUTES = new Set(['send', 'sync', 'no_send', 'no_sync', 'copy']);

function pathName(expression) {
  if (!expression) return null;
  if (expression.kind === 'Identifier') return expression.name;
  if (expression.kind === 'MemberExpression') {
    const parent = pathName(expression.object);
    return parent ? `${parent}.${expression.property}` : null;
  }
  return null;
}

function tokenLocation(token = {}, file = '<input>') {
  return { file, line: token.line ?? 1, column: token.column ?? 1 };
}

function cloneRecord(value) {
  return {
    state: value.state,
    sharedBorrows: value.sharedBorrows,
    mutableBorrow: value.mutableBorrow,
    initialized: value.initialized,
  };
}

function typeKey(type) {
  return formatSystemType(type);
}

export function ownershipMode(program, options = {}) {
  const explicit = options.mode ?? options.safetyMode;
  if (explicit) {
    if (!OWNERSHIP_MODES.has(explicit)) throw new TypeError(`Unknown ownership mode '${explicit}'.`);
    return explicit;
  }
  const directive = program.directives.find(item => item.name === 'ownership');
  const selected = directive?.args?.[0] ?? (directive ? 'strict' : 'compat');
  if (!OWNERSHIP_MODES.has(selected)) {
    throw new TypeError(`Unknown ownership mode '${selected}'. Expected compat, audit, or strict.`);
  }
  return selected;
}

export class NativeSafetyDiagnostic {
  constructor(severity, code, message, token, file, options = {}) {
    this.severity = severity;
    this.code = code;
    this.message = message;
    Object.assign(this, tokenLocation(token, file));
    this.hint = options.hint ?? null;
    this.function = options.function ?? null;
    this.variable = options.variable ?? null;
    this.operation = options.operation ?? null;
  }
}

class TraitResolver {
  constructor(compiler, report) {
    this.compiler = compiler;
    this.report = report;
    this.cache = new Map();
    this.active = new Set();
  }

  traits(type) {
    const key = typeKey(type);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.active.has(key)) return { copy: false, send: false, sync: false, recursive: true };
    this.active.add(key);
    const result = this.compute(type);
    this.active.delete(key);
    this.cache.set(key, result);
    return result;
  }

  compute(type) {
    switch (type.kind) {
      case 'integer':
      case 'bool':
      case 'void':
      case 'never':
        return { copy: true, send: true, sync: true };
      case 'pointer':
        return { copy: true, send: false, sync: false, rawPointer: true };
      case 'array': {
        const element = this.traits(type.element);
        return { copy: element.copy, send: element.send, sync: element.sync };
      }
      case 'named': {
        const declaration = this.compiler.structs.get(type.name);
        if (!declaration) return { copy: false, send: false, sync: false, unknown: true };
        const fields = declaration.fields.map(field => ({
          field,
          type: this.compiler.resolveType(field.type, field.token),
        }));
        const inferred = fields.map(item => this.traits(item.type));
        const fieldsCopy = inferred.every(item => item.copy);
        let copy = hasAttribute(declaration, 'copy') && fieldsCopy;
        let send = inferred.every(item => item.send);
        let sync = inferred.every(item => item.sync);
        if (hasAttribute(declaration, 'send')) send = true;
        if (hasAttribute(declaration, 'sync')) sync = true;
        if (hasAttribute(declaration, 'no_send')) send = false;
        if (hasAttribute(declaration, 'no_sync')) sync = false;
        return {
          copy,
          send,
          sync,
          fields: fields.map((item, index) => ({
            name: item.field.name,
            type: formatSystemType(item.type),
            traits: inferred[index],
          })),
          asserted: {
            copy: hasAttribute(declaration, 'copy'),
            send: hasAttribute(declaration, 'send'),
            sync: hasAttribute(declaration, 'sync'),
          },
        };
      }
      default:
        return { copy: false, send: false, sync: false, unknown: true };
    }
  }
}

class FunctionSafetyAnalyzer {
  constructor(program, compiler, declaration, report, traits, options = {}) {
    this.program = program;
    this.compiler = compiler;
    this.declaration = declaration;
    this.report = report;
    this.traits = traits;
    this.file = program.file;
    this.mode = report.mode;
    this.options = options;
    this.scopes = [];
    this.scopeId = 0;
    this.bindingId = 0;
    this.borrowId = 0;
    this.unsafeDepth = declaration.unsafe ? 1 : 0;
    this.currentUnsafeReason = attribute(declaration, 'unsafe_contract')?.args?.[0] ?? null;
    this.returnType = compiler.resolveType(declaration.returnType, declaration.token);
    this.returnBorrow = attribute(declaration, 'returns_borrow')?.args?.[0] ?? null;
    this.pushScope();
    for (const parameter of declaration.params) {
      this.define(parameter.name, compiler.resolveType(parameter.type, parameter.token), {
        mutable: true,
        parameter: true,
        token: parameter.token,
      });
    }
  }

  diagnostic(severity, code, message, token, options = {}) {
    const item = new NativeSafetyDiagnostic(severity, code, message, token, this.file, {
      function: this.declaration.name,
      ...options,
    });
    this.report.diagnostics.push(item);
    if (severity === 'error') this.report.errors.push(item);
    else this.report.warnings.push(item);
    return item;
  }

  error(code, message, token, options = {}) {
    return this.diagnostic(this.mode === 'strict' ? 'error' : 'warning', code, message, token, options);
  }

  warning(code, message, token, options = {}) {
    return this.diagnostic('warning', code, message, token, options);
  }

  pushScope() {
    this.scopes.push({ id: ++this.scopeId, bindings: new Map() });
    return this.scopes.at(-1);
  }

  popScope() {
    const scope = this.scopes.pop();
    for (const binding of [...scope.bindings.values()].reverse()) this.releaseBinding(binding);
  }

  define(name, type, options = {}) {
    const scope = this.scopes.at(-1);
    if (scope.bindings.has(name)) {
      this.error('KR-SAFE-OWN-0001', `Duplicate safety binding '${name}'.`, options.token, { variable: name });
      return scope.bindings.get(name);
    }
    const binding = {
      id: ++this.bindingId,
      name,
      type,
      mutable: Boolean(options.mutable),
      parameter: Boolean(options.parameter),
      global: Boolean(options.global),
      staticDeclaration: options.staticDeclaration ?? null,
      scopeId: scope.id,
      state: options.initialized === false ? 'uninitialized' : 'live',
      initialized: options.initialized !== false,
      sharedBorrows: 0,
      mutableBorrow: null,
      borrowTarget: options.borrowTarget ?? null,
      borrowMutable: Boolean(options.borrowMutable),
      borrowId: options.borrowId ?? null,
      token: options.token ?? {},
    };
    scope.bindings.set(name, binding);
    return binding;
  }

  releaseBinding(binding) {
    if (!binding.borrowTarget || !binding.borrowId) return;
    const target = binding.borrowTarget;
    if (binding.borrowMutable) {
      if (target.mutableBorrow === binding.borrowId) target.mutableBorrow = null;
    } else {
      target.sharedBorrows = Math.max(0, target.sharedBorrows - 1);
    }
    binding.borrowTarget = null;
    binding.borrowId = null;
  }

  lookup(name, token) {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const binding = this.scopes[index].bindings.get(name);
      if (binding) return binding;
    }
    const global = this.compiler.globals.get(name);
    if (global) {
      return {
        id: `global:${name}`,
        name,
        type: this.compiler.resolveType(global.type, global.token),
        mutable: global.mutable,
        global: true,
        staticDeclaration: global,
        scopeId: 0,
        state: 'live',
        initialized: true,
        sharedBorrows: 0,
        mutableBorrow: null,
        token: global.token,
      };
    }
    return null;
  }

  rootBinding(expression) {
    let current = expression;
    while (current?.kind === 'MemberExpression') current = current.object;
    if (current?.kind === 'Identifier') return this.lookup(current.name, current.token);
    if (current?.kind === 'UnaryExpression' && current.op === '*') return null;
    return null;
  }

  ensureUsable(binding, token, operation = 'use') {
    if (!binding) return;
    if (binding.state === 'moved') {
      this.error('KR-SAFE-OWN-0002', `Use of moved value '${binding.name}'.`, token, {
        variable: binding.name,
        operation,
        hint: 'Reinitialize the value, borrow it instead of moving it, or mark its type @copy when copying is valid.',
      });
    } else if (!binding.initialized || binding.state === 'uninitialized') {
      this.error('KR-SAFE-OWN-0003', `Use of uninitialized value '${binding.name}'.`, token, {
        variable: binding.name,
        operation,
      });
    }
  }

  ensureCanMutate(binding, token, operation = 'mutation') {
    if (!binding) return;
    this.ensureUsable(binding, token, operation);
    if (!binding.mutable) {
      this.error('KR-SAFE-BORROW-0001', `Cannot mutate immutable value '${binding.name}'.`, token, {
        variable: binding.name,
        operation,
      });
    }
    if (binding.mutableBorrow || binding.sharedBorrows) {
      this.error('KR-SAFE-BORROW-0002', `Cannot mutate '${binding.name}' while it is borrowed.`, token, {
        variable: binding.name,
        operation,
      });
    }
  }

  moveBinding(binding, token, operation = 'move') {
    if (!binding) return;
    this.ensureUsable(binding, token, operation);
    const traits = this.traits.traits(binding.type);
    if (traits.copy) return;
    if (binding.mutableBorrow || binding.sharedBorrows) {
      this.error('KR-SAFE-BORROW-0003', `Cannot move '${binding.name}' while it is borrowed.`, token, {
        variable: binding.name,
        operation,
      });
      return;
    }
    binding.state = 'moved';
    binding.initialized = false;
    this.report.moves.push({
      variable: binding.name,
      function: this.declaration.name,
      ...tokenLocation(token, this.file),
      operation,
    });
  }

  borrow(expression, mutable, token) {
    const target = this.rootBinding(expression);
    if (!target) {
      this.error('KR-SAFE-BORROW-0004', 'Borrowing currently requires a named local, parameter, static, or one of its fields.', token);
      return { type: parseSystemType(mutable ? '*mut u8' : '*const u8', { target: this.compiler.target.triple }), ephemeral: true };
    }
    this.ensureUsable(target, token, mutable ? 'mutable borrow' : 'shared borrow');
    if (mutable) {
      if (!target.mutable) {
        this.error('KR-SAFE-BORROW-0005', `Cannot mutably borrow immutable value '${target.name}'.`, token, { variable: target.name });
      }
      if (target.mutableBorrow || target.sharedBorrows) {
        this.error('KR-SAFE-BORROW-0006', `Mutable borrow of '${target.name}' conflicts with an active borrow.`, token, { variable: target.name });
      }
    } else if (target.mutableBorrow) {
      this.error('KR-SAFE-BORROW-0007', `Shared borrow of '${target.name}' conflicts with an active mutable borrow.`, token, { variable: target.name });
    }
    const id = ++this.borrowId;
    if (mutable) target.mutableBorrow = id;
    else target.sharedBorrows++;
    const type = {
      kind: 'pointer',
      mutable,
      pointee: target.type,
    };
    const borrow = { type, borrowTarget: target, borrowMutable: mutable, borrowId: id, ephemeral: true };
    this.report.borrows.push({
      id,
      variable: target.name,
      mutable,
      function: this.declaration.name,
      ...tokenLocation(token, this.file),
    });
    return borrow;
  }

  releaseEphemeral(value) {
    if (!value?.ephemeral || !value.borrowTarget || !value.borrowId) return;
    if (value.borrowMutable) {
      if (value.borrowTarget.mutableBorrow === value.borrowId) value.borrowTarget.mutableBorrow = null;
    } else {
      value.borrowTarget.sharedBorrows = Math.max(0, value.borrowTarget.sharedBorrows - 1);
    }
    value.ephemeral = false;
  }

  expressionType(expression) {
    if (!expression) return parseSystemType('void', { target: this.compiler.target.triple });
    switch (expression.kind) {
      case 'IntegerLiteral': return parseSystemType('usize', { target: this.compiler.target.triple });
      case 'BooleanLiteral': return parseSystemType('bool', { target: this.compiler.target.triple });
      case 'Identifier': {
        const binding = this.lookup(expression.name, expression.token);
        if (binding) return binding.type;
        const constant = this.compiler.constants.get(expression.name);
        if (constant) return this.compiler.resolveType(constant.type, constant.token);
        const fn = this.compiler.functions.get(expression.name);
        if (fn) return { kind: 'function', declaration: fn };
        return parseSystemType('usize', { target: this.compiler.target.triple });
      }
      case 'UnaryExpression': {
        if (expression.op === '&') {
          const target = this.rootBinding(expression.value);
          return { kind: 'pointer', mutable: expression.mutable, pointee: target?.type ?? parseSystemType('u8', { target: this.compiler.target.triple }) };
        }
        if (expression.op === '*') {
          const inner = this.expressionType(expression.value);
          return isPointer(inner) ? inner.pointee : parseSystemType('usize', { target: this.compiler.target.triple });
        }
        if (expression.op === '!') return parseSystemType('bool', { target: this.compiler.target.triple });
        return this.expressionType(expression.value);
      }
      case 'BinaryExpression':
        return ['==', '!=', '<', '>', '<=', '>=', '&&', '||'].includes(expression.op)
          ? parseSystemType('bool', { target: this.compiler.target.triple })
          : this.expressionType(expression.left);
      case 'CallExpression': {
        const path = pathName(expression.callee);
        if (path === 'ownership.move' || path === 'ownership.clone_copy') return this.expressionType(expression.args[0]);
        if (path === 'ownership.borrow' || path === 'ownership.borrow_mut') {
          const inner = this.expressionType(expression.args[0]);
          return { kind: 'pointer', mutable: path.endsWith('borrow_mut'), pointee: inner };
        }
        if (path === 'ownership.drop' || path === 'ownership.end_borrow') return parseSystemType('void', { target: this.compiler.target.triple });
        if (expression.callee.kind === 'Identifier') {
          const fn = this.compiler.functions.get(expression.callee.name);
          if (fn) return this.compiler.resolveType(fn.returnType, fn.token);
        }
        return parseSystemType('usize', { target: this.compiler.target.triple });
      }
      case 'MemberExpression': {
        const root = this.rootBinding(expression);
        if (!root) return parseSystemType('usize', { target: this.compiler.target.triple });
        let type = root.type;
        const parts = [];
        let current = expression;
        while (current.kind === 'MemberExpression') { parts.unshift(current.property); current = current.object; }
        for (const part of parts) {
          if (isPointer(type)) type = type.pointee;
          if (type.kind !== 'named') break;
          const declaration = this.compiler.structs.get(type.name);
          const field = declaration?.fields.find(item => item.name === part);
          if (!field) break;
          type = this.compiler.resolveType(field.type, field.token);
        }
        return type;
      }
      default:
        return parseSystemType('usize', { target: this.compiler.target.triple });
    }
  }

  analyzeExpression(expression, intent = 'read') {
    if (!expression) return { type: parseSystemType('void', { target: this.compiler.target.triple }) };
    switch (expression.kind) {
      case 'IntegerLiteral':
      case 'BooleanLiteral':
        return { type: this.expressionType(expression) };
      case 'Identifier': {
        const binding = this.lookup(expression.name, expression.token);
        if (!binding) return { type: this.expressionType(expression) };
        this.ensureUsable(binding, expression.token, intent);
        this.auditGlobal(binding, expression.token, intent);
        if (intent === 'move') this.moveBinding(binding, expression.token, intent);
        return { type: binding.type, binding };
      }
      case 'UnaryExpression': {
        if (expression.op === '&') return this.borrow(expression.value, Boolean(expression.mutable), expression.token);
        if (expression.op === '*') {
          this.auditUnsafe('raw-dereference', expression.token, 'Raw pointer dereference');
          const pointer = this.analyzeExpression(expression.value, 'read');
          return { type: isPointer(pointer.type) ? pointer.type.pointee : this.expressionType(expression) };
        }
        return this.analyzeExpression(expression.value, 'read');
      }
      case 'BinaryExpression': {
        const left = this.analyzeExpression(expression.left, 'read');
        const right = this.analyzeExpression(expression.right, 'read');
        this.releaseEphemeral(left);
        this.releaseEphemeral(right);
        return { type: this.expressionType(expression) };
      }
      case 'MemberExpression': {
        const root = this.rootBinding(expression);
        this.ensureUsable(root, expression.token, intent);
        if (intent === 'move') {
          const fieldType = this.expressionType(expression);
          if (!this.traits.traits(fieldType).copy) {
            this.error('KR-SAFE-OWN-0004', 'Partial moves from struct fields are not yet allowed in strict ownership mode.', expression.token, {
              variable: root?.name ?? null,
              hint: 'Move the whole struct, borrow the field, or make the field type @copy.',
            });
          }
        }
        return { type: this.expressionType(expression), binding: root };
      }
      case 'CallExpression': return this.analyzeCall(expression, intent);
      default:
        return { type: this.expressionType(expression) };
    }
  }

  analyzeCall(expression, intent) {
    const path = pathName(expression.callee);
    if (path === 'ownership.move') {
      if (expression.args.length !== 1) this.error('KR-SAFE-OWN-0010', 'ownership.move(value) requires exactly one value.', expression.token);
      const value = this.analyzeExpression(expression.args[0], 'move');
      return { type: value.type };
    }
    if (path === 'ownership.clone_copy') {
      if (expression.args.length !== 1) this.error('KR-SAFE-OWN-0011', 'ownership.clone_copy(value) requires exactly one value.', expression.token);
      const value = this.analyzeExpression(expression.args[0], 'read');
      if (!this.traits.traits(value.type).copy) {
        this.error('KR-SAFE-OWN-0012', `Type '${formatSystemType(value.type)}' is not Copy.`, expression.token);
      }
      return { type: value.type };
    }
    if (path === 'ownership.borrow' || path === 'ownership.borrow_mut') {
      if (expression.args.length !== 1) this.error('KR-SAFE-BORROW-0010', `${path}(value) requires exactly one value.`, expression.token);
      return this.borrow(expression.args[0], path === 'ownership.borrow_mut', expression.token);
    }
    if (path === 'ownership.drop') {
      if (expression.args.length !== 1) this.error('KR-SAFE-DROP-0001', 'ownership.drop(value) requires exactly one value.', expression.token);
      const value = expression.args[0];
      const binding = value.kind === 'Identifier' ? this.lookup(value.name, value.token) : this.rootBinding(value);
      if (!binding) this.error('KR-SAFE-DROP-0002', 'Only named owned values can be explicitly dropped.', expression.token);
      else this.moveBinding(binding, expression.token, 'drop');
      return { type: parseSystemType('void', { target: this.compiler.target.triple }) };
    }
    if (path === 'ownership.end_borrow') {
      const arg = expression.args[0];
      const binding = arg?.kind === 'Identifier' ? this.lookup(arg.name, arg.token) : null;
      if (!binding?.borrowTarget) this.error('KR-SAFE-BORROW-0011', 'ownership.end_borrow expects a named borrow binding.', expression.token);
      else this.releaseBinding(binding);
      return { type: parseSystemType('void', { target: this.compiler.target.triple }) };
    }

    this.auditCall(path, expression.token);
    const declaration = expression.callee.kind === 'Identifier' ? this.compiler.functions.get(expression.callee.name) : null;
    const values = [];
    if (declaration) {
      for (let index = 0; index < expression.args.length; index++) {
        const argument = expression.args[index];
        const parameter = declaration.params[index];
        if (!parameter) {
          values.push(this.analyzeExpression(argument, 'read'));
          continue;
        }
        const parameterType = this.compiler.resolveType(parameter.type, parameter.token);
        const argumentType = this.expressionType(argument);
        const argumentIntent = this.traits.traits(parameterType).copy || isPointer(parameterType) ? 'read' : 'move';
        const value = this.analyzeExpression(argument, argumentIntent);
        if (path === 'thread.spawn' || path === 'spawn_thread') this.requireSend(argumentType, argument.token);
        values.push(value);
      }
    } else {
      for (const argument of expression.args) values.push(this.analyzeExpression(argument, 'read'));
    }
    const result = { type: this.expressionType(expression) };
    if (declaration) {
      const borrowedParameter = attribute(declaration, 'returns_borrow')?.args?.[0] ?? null;
      const borrowedIndex = borrowedParameter
        ? declaration.params.findIndex(parameter => parameter.name === borrowedParameter)
        : -1;
      if (borrowedIndex >= 0 && values[borrowedIndex]?.borrowTarget) {
        const borrowed = values[borrowedIndex];
        result.borrowTarget = borrowed.borrowTarget;
        result.borrowMutable = borrowed.borrowMutable;
        result.borrowId = borrowed.borrowId;
        result.ephemeral = true;
        borrowed.ephemeral = false;
      }
    }
    for (const value of values) this.releaseEphemeral(value);
    if (intent === 'discard' && result.type.kind === 'named') {
      const declarationType = this.compiler.structs.get(result.type.name);
      if (hasAttribute(declarationType, 'must_use')) {
        this.error('KR-SAFE-MUSTUSE-0001', `Discarded @must_use value of type '${result.type.name}'.`, expression.token);
      }
    }
    return result;
  }

  requireSend(type, token) {
    if (!this.traits.traits(type).send) {
      this.error('KR-SAFE-SEND-0001', `Type '${formatSystemType(type)}' cannot cross a thread boundary because it is not Send.`, token, {
        hint: 'Remove raw pointers, wrap shared state in synchronization, or add a reviewed @send assertion with @unsafe_contract.',
      });
    }
  }

  auditCall(path, token) {
    if (!path) return;
    if (UNSAFE_PATH_PREFIXES.some(prefix => path.startsWith(prefix))) {
      this.auditUnsafe(path, token, `Unsafe intrinsic '${path}'`);
    }
  }

  auditGlobal(binding, token, operation) {
    if (!binding?.global || !binding.mutable) return;
    const declaration = binding.staticDeclaration;
    const threadLocal = hasAttribute(declaration, 'thread_local');
    const synchronized = hasAttribute(declaration, 'synchronized');
    if (!threadLocal && !synchronized) {
      this.warning('KR-SAFE-MEMORY-0001', `Access to shared mutable static '${binding.name}' is not annotated @thread_local or @synchronized.`, token, {
        variable: binding.name,
        operation,
      });
    }
    if (!this.unsafeDepth) {
      this.error('KR-SAFE-MEMORY-0002', `Access to mutable static '${binding.name}' requires an unsafe block.`, token, {
        variable: binding.name,
        operation,
      });
    }
  }

  auditUnsafe(operation, token, description) {
    this.report.unsafeOperations.push({
      operation,
      description,
      documented: Boolean(this.currentUnsafeReason),
      reason: this.currentUnsafeReason,
      function: this.declaration.name,
      ...tokenLocation(token, this.file),
    });
    if (!this.unsafeDepth) {
      this.error('KR-SAFE-UNSAFE-0001', `${description} requires an unsafe block.`, token, { operation });
    }
    if (this.report.denyUndocumentedUnsafe && !this.currentUnsafeReason) {
      this.error('KR-SAFE-UNSAFE-0002', `${description} is missing an unsafe safety justification.`, token, {
        operation,
        hint: 'Use unsafe("why invariants hold") { ... } or add @unsafe_contract("...") to an unsafe function.',
      });
    }
  }

  analyzeStatement(statement) {
    switch (statement.kind) {
      case 'UnsafeBlock': {
        const previousReason = this.currentUnsafeReason;
        this.unsafeDepth++;
        this.currentUnsafeReason = statement.reason ?? previousReason;
        this.report.unsafeBlocks.push({
          function: this.declaration.name,
          reason: statement.reason ?? null,
          documented: Boolean(statement.reason),
          ...tokenLocation(statement.token, this.file),
        });
        if (this.report.denyUndocumentedUnsafe && !statement.reason) {
          this.error('KR-SAFE-UNSAFE-0003', 'Unsafe block is missing a safety justification.', statement.token, {
            hint: 'Write unsafe("validated MMIO address and exclusive device access") { ... }.',
          });
        }
        this.analyzeBlock(statement.body);
        this.currentUnsafeReason = previousReason;
        this.unsafeDepth--;
        return;
      }
      case 'VariableDeclaration': {
        const declaredType = statement.type ? this.compiler.resolveType(statement.type, statement.token) : this.expressionType(statement.init);
        const borrowInit = statement.init.kind === 'UnaryExpression' && statement.init.op === '&'
          || statement.init.kind === 'CallExpression' && ['ownership.borrow', 'ownership.borrow_mut'].includes(pathName(statement.init.callee));
        const value = this.analyzeExpression(statement.init, borrowInit ? 'read' : (this.traits.traits(declaredType).copy ? 'read' : 'move'));
        const binding = this.define(statement.name, declaredType, {
          mutable: statement.mutable,
          token: statement.token,
          borrowTarget: value.borrowTarget,
          borrowMutable: value.borrowMutable,
          borrowId: value.borrowId,
        });
        if (value.borrowTarget) {
          value.ephemeral = false;
          if (value.borrowTarget.scopeId > binding.scopeId) {
            this.error('KR-SAFE-LIFETIME-0001', `Borrow '${binding.name}' would outlive '${value.borrowTarget.name}'.`, statement.token, {
              variable: binding.name,
            });
          }
        }
        return;
      }
      case 'AssignmentStatement': {
        const target = this.rootBinding(statement.target);
        this.ensureCanMutate(target, statement.token, 'assignment');
        if (target?.borrowTarget) this.releaseBinding(target);
        const borrowValue = statement.value.kind === 'UnaryExpression' && statement.value.op === '&'
          || statement.value.kind === 'CallExpression' && ['ownership.borrow', 'ownership.borrow_mut'].includes(pathName(statement.value.callee));
        const expected = target?.type ?? this.expressionType(statement.value);
        const value = this.analyzeExpression(statement.value, borrowValue ? 'read' : (this.traits.traits(expected).copy ? 'read' : 'move'));
        if (target) {
          target.state = 'live';
          target.initialized = true;
          if (value.borrowTarget) {
            if (value.borrowTarget.scopeId > target.scopeId) {
              this.error('KR-SAFE-LIFETIME-0002', `Assigned borrow in '${target.name}' would outlive '${value.borrowTarget.name}'.`, statement.token);
            }
            target.borrowTarget = value.borrowTarget;
            target.borrowMutable = value.borrowMutable;
            target.borrowId = value.borrowId;
            value.ephemeral = false;
          }
        }
        this.releaseEphemeral(value);
        return;
      }
      case 'CompoundAssignmentStatement': {
        const target = this.rootBinding(statement.target);
        this.ensureCanMutate(target, statement.token, 'compound assignment');
        const value = this.analyzeExpression(statement.value, 'read');
        this.releaseEphemeral(value);
        return;
      }
      case 'ReturnStatement': {
        if (!statement.value) return;
        const value = this.analyzeExpression(statement.value, this.traits.traits(this.returnType).copy || isPointer(this.returnType) ? 'read' : 'move');
        if (value.borrowTarget) {
          const target = value.borrowTarget;
          if (!target.parameter) {
            this.error('KR-SAFE-LIFETIME-0003', `Cannot return a borrow of local value '${target.name}'.`, statement.token, {
              variable: target.name,
            });
          } else if (!this.returnBorrow || this.returnBorrow !== target.name) {
            this.error('KR-SAFE-LIFETIME-0004', `Borrowed return must declare @returns_borrow("${target.name}").`, statement.token, {
              variable: target.name,
            });
          }
        } else if (isPointer(this.returnType) && statement.value.kind === 'Identifier') {
          const binding = this.lookup(statement.value.name, statement.value.token);
          if (binding?.parameter && isPointer(binding.type)) {
            if (!this.returnBorrow || this.returnBorrow !== binding.name) {
              this.error('KR-SAFE-LIFETIME-0005', `Returning pointer parameter '${binding.name}' requires @returns_borrow("${binding.name}").`, statement.token, {
                variable: binding.name,
              });
            }
          }
        }
        this.releaseEphemeral(value);
        return;
      }
      case 'ExpressionStatement': {
        const value = this.analyzeExpression(statement.expression, 'discard');
        this.releaseEphemeral(value);
        return;
      }
      case 'IfStatement': return this.analyzeIf(statement);
      case 'WhileStatement': return this.analyzeWhile(statement);
      default:
        return;
    }
  }

  visibleBindings() {
    const output = [];
    for (const scope of this.scopes) for (const binding of scope.bindings.values()) output.push(binding);
    return output;
  }

  snapshot() {
    return new Map(this.visibleBindings().map(binding => [binding.id, cloneRecord(binding)]));
  }

  restore(snapshot) {
    for (const binding of this.visibleBindings()) {
      const saved = snapshot.get(binding.id);
      if (saved) Object.assign(binding, saved);
    }
  }

  capture(snapshot) {
    const output = new Map();
    for (const binding of this.visibleBindings()) {
      if (snapshot.has(binding.id)) output.set(binding.id, cloneRecord(binding));
    }
    return output;
  }

  mergeStates(base, left, right) {
    for (const binding of this.visibleBindings()) {
      const before = base.get(binding.id);
      const a = left.get(binding.id) ?? before;
      const b = right.get(binding.id) ?? before;
      if (!before || !a || !b) continue;
      binding.state = a.state === 'moved' || b.state === 'moved' ? 'moved' : before.state;
      binding.initialized = a.initialized && b.initialized;
      binding.sharedBorrows = Math.max(a.sharedBorrows, b.sharedBorrows, before.sharedBorrows);
      binding.mutableBorrow = a.mutableBorrow ?? b.mutableBorrow ?? before.mutableBorrow;
    }
  }

  analyzeIf(statement) {
    const condition = this.analyzeExpression(statement.test, 'read');
    this.releaseEphemeral(condition);
    const base = this.snapshot();
    this.analyzeBlock(statement.consequent);
    const thenState = this.capture(base);
    this.restore(base);
    if (statement.alternate) this.analyzeBlock(statement.alternate);
    const elseState = this.capture(base);
    this.restore(base);
    this.mergeStates(base, thenState, statement.alternate ? elseState : base);
  }

  analyzeWhile(statement) {
    const condition = this.analyzeExpression(statement.test, 'read');
    this.releaseEphemeral(condition);
    const base = this.snapshot();
    this.analyzeBlock(statement.body);
    const after = this.capture(base);
    for (const binding of this.visibleBindings()) {
      const before = base.get(binding.id);
      const next = after.get(binding.id);
      if (before?.state === 'live' && next?.state === 'moved') {
        this.error('KR-SAFE-OWN-0020', `Loop may move '${binding.name}' more than once.`, statement.token, {
          variable: binding.name,
          hint: 'Borrow the value in the loop, reinitialize it on every iteration, or move it before entering the loop.',
        });
      }
    }
    this.restore(base);
  }

  analyzeBlock(block, scoped = true) {
    if (scoped) this.pushScope();
    for (const statement of block.body) this.analyzeStatement(statement);
    if (scoped) this.popScope();
  }

  run() {
    if (!this.declaration.body) return;
    if (this.declaration.unsafe) {
      this.report.unsafeFunctions.push({
        name: this.declaration.name,
        public: this.declaration.public,
        contract: this.currentUnsafeReason,
        documented: Boolean(this.currentUnsafeReason),
        ...tokenLocation(this.declaration.token, this.file),
      });
      if (this.report.denyUndocumentedUnsafe && !this.currentUnsafeReason) {
        this.error('KR-SAFE-UNSAFE-0010', `Unsafe function '${this.declaration.name}' is missing @unsafe_contract("...").`, this.declaration.token);
      }
    }
    this.analyzeBlock(this.declaration.body, false);
    while (this.scopes.length) this.popScope();
  }
}

function validateTraitAssertions(compiler, report, traits) {
  for (const declaration of compiler.structs.values()) {
    const type = { kind: 'named', name: declaration.name };
    const resolved = traits.traits(type);
    const contract = attribute(declaration, 'unsafe_contract')?.args?.[0] ?? null;
    for (const name of TRAIT_OVERRIDE_ATTRIBUTES) {
      if (!hasAttribute(declaration, name)) continue;
      if (['send', 'sync'].includes(name) && !contract) {
        const diagnostic = new NativeSafetyDiagnostic(
          report.mode === 'strict' ? 'error' : 'warning',
          'KR-SAFE-TRAIT-0001',
          `@${name} on '${declaration.name}' requires @unsafe_contract("why this assertion is valid").`,
          declaration.token,
          report.file,
        );
        report.diagnostics.push(diagnostic);
        (diagnostic.severity === 'error' ? report.errors : report.warnings).push(diagnostic);
      }
    }
    if (hasAttribute(declaration, 'copy')) {
      const invalid = resolved.fields?.filter(field => !field.traits.copy) ?? [];
      if (invalid.length) {
        const diagnostic = new NativeSafetyDiagnostic(
          report.mode === 'strict' ? 'error' : 'warning',
          'KR-SAFE-TRAIT-0002',
          `@copy struct '${declaration.name}' contains non-Copy fields: ${invalid.map(item => item.name).join(', ')}.`,
          declaration.token,
          report.file,
        );
        report.diagnostics.push(diagnostic);
        (diagnostic.severity === 'error' ? report.errors : report.warnings).push(diagnostic);
      }
    }
    report.traits[declaration.name] = {
      copy: resolved.copy,
      send: resolved.send,
      sync: resolved.sync,
      asserted: resolved.asserted ?? {},
      fields: resolved.fields ?? [],
    };
  }
}

export function analyzeNativeSafety(program, compiler, options = {}) {
  const mode = ownershipMode(program, options);
  const report = {
    file: program.file,
    mode,
    denyUndocumentedUnsafe: Boolean(
      options.denyUndocumentedUnsafe
      ?? program.directives.some(item => item.name === 'deny_undocumented_unsafe')
    ),
    errors: [],
    warnings: [],
    diagnostics: [],
    moves: [],
    borrows: [],
    unsafeBlocks: [],
    unsafeFunctions: [],
    unsafeOperations: [],
    traits: {},
    summary: null,
  };
  const traits = new TraitResolver(compiler, report);
  validateTraitAssertions(compiler, report, traits);
  for (const declaration of compiler.functions.values()) {
    new FunctionSafetyAnalyzer(program, compiler, declaration, report, traits, options).run();
  }
  report.summary = {
    mode,
    errors: report.errors.length,
    warnings: report.warnings.length,
    moves: report.moves.length,
    borrows: report.borrows.length,
    unsafeBlocks: report.unsafeBlocks.length,
    unsafeFunctions: report.unsafeFunctions.length,
    unsafeOperations: report.unsafeOperations.length,
    documentedUnsafeOperations: report.unsafeOperations.filter(item => item.documented).length,
  };
  return report;
}

export function assertNativeSafety(report, context) {
  if (!report || report.mode !== 'strict' || !report.errors.length) return report;
  const first = report.errors[0];
  fail(first.message, first, context, first.code, first.hint);
}

export function formatNativeSafetyReport(report, options = {}) {
  if (options.json) return JSON.stringify(report, null, 2);
  const lines = [
    `Kura Native Safety (${report.mode})`,
    `File: ${report.file}`,
    `Errors: ${report.summary.errors}`,
    `Warnings: ${report.summary.warnings}`,
    `Moves: ${report.summary.moves}`,
    `Borrows: ${report.summary.borrows}`,
    `Unsafe operations: ${report.summary.unsafeOperations}`,
  ];
  for (const item of report.diagnostics) {
    lines.push(`${item.file}:${item.line}:${item.column}: ${item.severity} ${item.code}: ${item.message}`);
    if (item.hint) lines.push(`  hint: ${item.hint}`);
  }
  return `${lines.join('\n')}\n`;
}

export const SAFETY_ERROR_EXPLANATIONS = Object.freeze({
  'KR-SAFE-OWN-0002': 'A non-Copy value was consumed by a move and then used again. Borrow it, clone an explicitly Copy type, or reinitialize it.',
  'KR-SAFE-BORROW-0003': 'Moving a value would invalidate an active reference. End the borrow before moving the owner.',
  'KR-SAFE-BORROW-0006': 'Only one mutable borrow may exist, and it may not overlap any shared borrow.',
  'KR-SAFE-LIFETIME-0003': 'A reference to a local stack value cannot escape the function that owns the stack slot.',
  'KR-SAFE-SEND-0001': 'The value contains data that cannot safely cross a thread boundary, commonly a raw pointer or unsynchronized shared state.',
  'KR-SAFE-UNSAFE-0002': 'Strict unsafe auditing requires a written safety justification for each unsafe operation.',
  'KR-SAFE-MEMORY-0001': 'Shared mutable globals need an explicit synchronization or thread-local contract.',
});
