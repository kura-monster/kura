// SPDX-License-Identifier: MIT OR Apache-2.0
import { BrowserError } from './browser.mjs';

export const Fragment = Symbol.for('kura.ui.fragment');
const TEXT = Symbol.for('kura.ui.text');
let currentInstance = null;
let currentHook = 0;
const contextStack = [];

export function h(type, properties = null, ...children) {
  const props = properties && typeof properties === 'object' && !Array.isArray(properties) ? { ...properties } : {};
  const key = props.key ?? null;
  delete props.key;
  return Object.freeze({ type, props: Object.freeze(props), key, children: Object.freeze(flatten(children).map(normalizeVNode)) });
}

export function text(value) { return Object.freeze({ type: TEXT, value: String(value ?? ''), key: null, props: Object.freeze({}), children: Object.freeze([]) }); }
export function fragment(...children) { return h(Fragment, null, ...children); }

export function createComponent(renderer, options = {}) {
  if (typeof renderer !== 'function') throw new BrowserError('Component renderer must be a function.', { code: 'KR-UI-0001' });
  function Component(properties) { return renderer(properties); }
  Object.defineProperty(Component, 'displayName', { value: options.name ?? renderer.name ?? 'Component' });
  Object.defineProperty(Component, '__kuraComponent', { value: true });
  return Component;
}

export function mountApp(target, component, properties = {}) {
  const root = resolveTarget(target);
  const instance = createInstance(component, properties, null);
  let vnode = null;
  let node = null;
  let destroyed = false;
  const update = () => {
    if (destroyed) return;
    const next = renderComponent(instance);
    if (!node) {
      node = createDom(next, instance);
      root.replaceChildren(node);
    } else node = patch(root, node, vnode, next, instance);
    vnode = next;
    flushEffects(instance);
  };
  instance.schedule = scheduleMicrotask(update);
  update();
  return Object.freeze({
    update(nextProperties = instance.props) { instance.props = Object.freeze({ ...nextProperties }); instance.schedule(); },
    unmount() { if (destroyed) return; destroyed = true; cleanupInstance(instance); root.replaceChildren(); },
    instance,
    root,
  });
}

export function renderTo(target, vnode) {
  const root = resolveTarget(target);
  const normalized = normalizeVNode(vnode);
  const node = createDom(normalized, null);
  root.replaceChildren(node);
  return node;
}

export function useState(initialValue) {
  const instance = requireInstance('useState');
  const index = currentHook++;
  if (!instance.hooks[index]) {
    const value = typeof initialValue === 'function' ? initialValue() : initialValue;
    const record = { value };
    record.set = next => {
      const value = typeof next === 'function' ? next(record.value) : next;
      if (Object.is(value, record.value)) return record.value;
      record.value = value;
      instance.schedule();
      return value;
    };
    instance.hooks[index] = record;
  }
  const record = instance.hooks[index];
  return Object.freeze([record.value, record.set]);
}

export function useReducer(reducer, initialState, initializer = value => value) {
  const [state, setState] = useState(() => initializer(initialState));
  return Object.freeze([state, action => setState(current => reducer(current, action))]);
}

export function useRef(initialValue = null) {
  const instance = requireInstance('useRef');
  const index = currentHook++;
  instance.hooks[index] ??= { current: initialValue };
  return instance.hooks[index];
}

export function useMemo(factory, dependencies) {
  const instance = requireInstance('useMemo');
  const index = currentHook++;
  const previous = instance.hooks[index];
  if (!previous || !sameDependencies(previous.dependencies, dependencies)) instance.hooks[index] = { value: factory(), dependencies: [...(dependencies ?? [])] };
  return instance.hooks[index].value;
}

export function useCallback(callback, dependencies) { return useMemo(() => callback, dependencies); }

export function useEffect(effect, dependencies = undefined) {
  const instance = requireInstance('useEffect');
  const index = currentHook++;
  const previous = instance.hooks[index];
  const changed = dependencies === undefined || !previous || !sameDependencies(previous.dependencies, dependencies);
  instance.hooks[index] = { type: 'effect', effect, dependencies: dependencies ? [...dependencies] : undefined, cleanup: previous?.cleanup ?? null, changed };
}

export function useLayoutEffect(effect, dependencies = undefined) {
  const instance = requireInstance('useLayoutEffect');
  const index = currentHook++;
  const previous = instance.hooks[index];
  const changed = dependencies === undefined || !previous || !sameDependencies(previous.dependencies, dependencies);
  instance.hooks[index] = { type: 'layout', effect, dependencies: dependencies ? [...dependencies] : undefined, cleanup: previous?.cleanup ?? null, changed };
}

export function createContext(defaultValue) {
  const id = Symbol('KuraContext');
  const Provider = createComponent(properties => {
    contextStack.push({ id, value: properties.value });
    try { return properties.children ?? null; } finally { contextStack.pop(); }
  }, { name: 'ContextProvider' });
  return Object.freeze({ id, defaultValue, Provider });
}

export function useContext(context) {
  requireInstance('useContext');
  currentHook++;
  for (let index = contextStack.length - 1; index >= 0; index--) if (contextStack[index].id === context.id) return contextStack[index].value;
  return context.defaultValue;
}

export function lazy(loader, options = {}) {
  let promise = null;
  let resolved = null;
  let error = null;
  return createComponent(properties => {
    const [, force] = useState(0);
    if (resolved) return h(resolved, properties);
    if (error) {
      if (options.error) return h(options.error, { error });
      throw error;
    }
    promise ??= Promise.resolve(loader()).then(module => {
      resolved = module.default ?? module.Component ?? module;
      force(value => value + 1);
    }).catch(reason => { error = reason; force(value => value + 1); });
    return options.fallback ?? null;
  }, { name: options.name ?? 'LazyComponent' });
}

export function keyed(items, renderItem, key = item => item?.id) {
  return [...items].map((item, index) => {
    const vnode = normalizeVNode(renderItem(item, index));
    return Object.freeze({ ...vnode, key: key(item, index) });
  });
}

export function css(source, options = {}) {
  const document = requireDocument();
  const id = options.id ?? `kura-css-${hashString(source)}`;
  let style = document.getElementById(id);
  if (!style) {
    style = document.createElement('style');
    style.id = id;
    if (options.nonce) style.nonce = options.nonce;
    style.textContent = String(source);
    document.head.append(style);
  }
  return Object.freeze({ id, element: style, remove() { style.remove(); } });
}

export function classNames(...values) {
  const output = [];
  for (const value of values.flat(Infinity)) {
    if (!value) continue;
    if (typeof value === 'string' || typeof value === 'number') output.push(String(value));
    else if (typeof value === 'object') for (const [name, enabled] of Object.entries(value)) if (enabled) output.push(name);
  }
  return output.join(' ');
}

export function portal(vnode, target) {
  const destination = resolveTarget(target);
  const node = createDom(normalizeVNode(vnode), currentInstance);
  destination.append(node);
  return Object.freeze({ type: TEXT, value: '', portal: node, key: null, props: Object.freeze({}), children: Object.freeze([]) });
}

function createInstance(component, props, parent) {
  return { component, props: Object.freeze({ ...props }), parent, hooks: [], children: new Set(), schedule: () => {}, mounted: false, effectQueue: [] };
}

function renderComponent(instance) {
  const previousInstance = currentInstance;
  const previousHook = currentHook;
  currentInstance = instance;
  currentHook = 0;
  try {
    const output = typeof instance.component === 'function' ? instance.component({ ...instance.props, children: instance.props.children }) : instance.component;
    instance.mounted = true;
    return normalizeVNode(output);
  } finally {
    runLayoutEffects(instance);
    currentInstance = previousInstance;
    currentHook = previousHook;
  }
}

function createDom(vnode, owner) {
  const document = requireDocument();
  if (vnode.type === TEXT) return document.createTextNode(vnode.value);
  if (vnode.type === Fragment) {
    const fragment = document.createDocumentFragment();
    for (const child of vnode.children) fragment.append(createDom(child, owner));
    return fragment;
  }
  if (typeof vnode.type === 'function') {
    const instance = createInstance(vnode.type, { ...vnode.props, children: vnode.children }, owner);
    owner?.children.add(instance);
    const rendered = renderComponent(instance);
    const node = createDom(rendered, instance);
    node.__kuraInstance = instance;
    node.__kuraVNode = rendered;
    flushEffects(instance);
    return node;
  }
  const node = document.createElement(vnode.type);
  applyProperties(node, {}, vnode.props);
  for (const child of vnode.children) node.append(createDom(child, owner));
  node.__kuraVNode = vnode;
  return node;
}

function patch(parent, node, previous, next, owner) {
  if (!previous) return node;
  if (previous.type !== next.type || previous.key !== next.key) {
    const replacement = createDom(next, owner);
    parent.replaceChild(replacement, node);
    disposeNode(node);
    return replacement;
  }
  if (next.type === TEXT) { if (node.nodeValue !== next.value) node.nodeValue = next.value; return node; }
  if (typeof next.type === 'function') {
    const instance = node.__kuraInstance;
    instance.props = Object.freeze({ ...next.props, children: next.children });
    const previousRendered = node.__kuraVNode;
    const nextRendered = renderComponent(instance);
    const updated = patch(parent, node, previousRendered, nextRendered, instance);
    updated.__kuraInstance = instance;
    updated.__kuraVNode = nextRendered;
    flushEffects(instance);
    return updated;
  }
  if (next.type === Fragment) {
    const replacement = createDom(next, owner);
    parent.replaceChild(replacement, node);
    return replacement;
  }
  applyProperties(node, previous.props, next.props);
  patchChildren(node, previous.children, next.children, owner);
  node.__kuraVNode = next;
  return node;
}

function patchChildren(parent, previousChildren, nextChildren, owner) {
  const keyedNodes = new Map();
  for (let index = 0; index < previousChildren.length; index++) {
    const child = previousChildren[index];
    if (child.key !== null) keyedNodes.set(child.key, { child, node: parent.childNodes[index] });
  }
  let cursor = 0;
  for (let index = 0; index < nextChildren.length; index++) {
    const next = nextChildren[index];
    let node = parent.childNodes[cursor] ?? null;
    let previous = previousChildren[cursor] ?? null;
    if (next.key !== null && keyedNodes.has(next.key)) {
      const matched = keyedNodes.get(next.key);
      node = matched.node;
      previous = matched.child;
      if (node !== parent.childNodes[cursor]) parent.insertBefore(node, parent.childNodes[cursor] ?? null);
      keyedNodes.delete(next.key);
    }
    if (!node) parent.append(createDom(next, owner));
    else patch(parent, node, previous, next, owner);
    cursor++;
  }
  while (parent.childNodes.length > nextChildren.length) {
    const child = parent.lastChild;
    disposeNode(child);
    child.remove();
  }
  for (const { node } of keyedNodes.values()) { disposeNode(node); node.remove(); }
}

function applyProperties(node, previous, next) {
  for (const name of Object.keys(previous)) if (!(name in next)) setProperty(node, name, null, previous[name]);
  for (const [name, value] of Object.entries(next)) if (!Object.is(value, previous[name])) setProperty(node, name, value, previous[name]);
}

function setProperty(node, name, value, previous) {
  if (name === 'children' || name === 'key') return;
  if (name === 'ref') { if (typeof value === 'function') value(node); else if (value && typeof value === 'object') value.current = node; return; }
  if (name === 'className' || name === 'class') { node.className = classNames(value); return; }
  if (name === 'style' && value && typeof value === 'object') {
    for (const key of Object.keys(previous ?? {})) if (!(key in value)) node.style.removeProperty(toKebabCase(key));
    for (const [key, styleValue] of Object.entries(value)) node.style.setProperty(toKebabCase(key), styleValue == null ? '' : String(styleValue));
    return;
  }
  if (/^on[A-Z]/.test(name)) {
    const event = name.slice(2).toLowerCase();
    if (previous) node.removeEventListener(event, previous);
    if (value) node.addEventListener(event, value);
    return;
  }
  if (name === 'dangerouslySetInnerHTML') {
    if (value?.__html !== undefined) node.innerHTML = String(value.__html);
    return;
  }
  if (value === false || value === null || value === undefined) { node.removeAttribute(name); if (name in node && typeof node[name] === 'boolean') node[name] = false; return; }
  if (name in node && !['list','form','type'].includes(name)) {
    try { node[name] = value; return; } catch { }
  }
  if (value === true) node.setAttribute(name, '');
  else node.setAttribute(name, String(value));
}

function runLayoutEffects(instance) {
  for (const hook of instance.hooks) {
    if (hook?.type !== 'layout' || !hook.changed) continue;
    hook.cleanup?.();
    hook.cleanup = hook.effect?.() ?? null;
    hook.changed = false;
  }
}

function flushEffects(instance) {
  queueMicrotask(() => {
    for (const hook of instance.hooks) {
      if (hook?.type !== 'effect' || !hook.changed) continue;
      hook.cleanup?.();
      hook.cleanup = hook.effect?.() ?? null;
      hook.changed = false;
    }
  });
}

function cleanupInstance(instance) {
  for (const hook of instance.hooks) if ((hook?.type === 'effect' || hook?.type === 'layout') && hook.cleanup) { try { hook.cleanup(); } catch { } }
  for (const child of instance.children) cleanupInstance(child);
  instance.children.clear();
}

function disposeNode(node) { if (node?.__kuraInstance) cleanupInstance(node.__kuraInstance); for (const child of node?.childNodes ?? []) disposeNode(child); }
function normalizeVNode(value) { if (value && typeof value === 'object' && value.type !== undefined) return value; if (value === null || value === undefined || value === false || value === true) return text(''); if (Array.isArray(value)) return h(Fragment, null, ...value); return text(value); }
function flatten(values, output = []) { for (const value of values) Array.isArray(value) ? flatten(value, output) : output.push(value); return output; }
function requireInstance(name) { if (!currentInstance) throw new BrowserError(`${name} must be called while rendering a Kura component.`, { code: 'KR-UI-0002' }); return currentInstance; }
function sameDependencies(left, right) { if (!left || !right || left.length !== right.length) return false; return left.every((value,index)=>Object.is(value,right[index])); }
function scheduleMicrotask(callback) { let queued=false; return () => { if (queued) return; queued=true; queueMicrotask(()=>{ queued=false; callback(); }); }; }
function resolveTarget(target) { const document = requireDocument(); if (typeof target === 'string') { const node=document.querySelector(target); if (!node) throw new BrowserError(`Target not found: ${target}`, { code: 'KR-UI-0003' }); return node; } if (target?.nodeType) return target; throw new BrowserError('Invalid mount target.', { code: 'KR-UI-0004' }); }
function requireDocument() { if (!globalThis.document) throw new BrowserError('Kura UI requires a browser document.', { code: 'KR-UI-0005' }); return globalThis.document; }
function toKebabCase(value) { return String(value).replace(/[A-Z]/g, character => `-${character.toLowerCase()}`); }
function hashString(value) { let hash=2166136261; for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash,16777619); } return (hash>>>0).toString(36); }
