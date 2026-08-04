// SPDX-License-Identifier: MIT OR Apache-2.0
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import {
  KuraSecurityError,
  atomicWriteFile,
  exists,
  parseJsonSecure,
  readTextFileSecure,
} from './security.mjs';
import { KuraCliError } from './diagnostics.mjs';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const LOCKFILE_VERSION = 1;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_FILES = 20_000;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;

export function parsePackageSpec(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw packageError('No package name was provided.', 'KR-PKG-0001', 'Kura needs a package name', 'Example: kr add kleur');
  if (raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('file:')) {
    return { type: 'directory', path: raw.startsWith('file:') ? raw.slice(5) : raw };
  }
  let name = raw;
  let range = 'latest';
  if (raw.startsWith('@')) {
    const slash = raw.indexOf('/');
    const at = raw.lastIndexOf('@');
    if (slash < 2) throw invalidPackageName(raw);
    if (at > slash) {
      name = raw.slice(0, at);
      range = raw.slice(at + 1) || 'latest';
    }
  } else {
    const at = raw.lastIndexOf('@');
    if (at > 0) {
      name = raw.slice(0, at);
      range = raw.slice(at + 1) || 'latest';
    }
  }
  name = name.toLowerCase();
  if (!SAFE_PACKAGE_NAME.test(name) || name.includes('..')) throw invalidPackageName(name);
  if (range.length > 128 || /[\0\r\n]/.test(range)) {
    throw packageError('The package version range is not valid.', 'KR-PKG-0003', 'Invalid package version', 'Use a version such as 1.2.3, ^1.2.0, ~1.2.0, or latest.');
  }
  return { type: 'registry', name, range };
}

function invalidPackageName(name) {
  return packageError(`'${name}' is not a valid package name.`, 'KR-PKG-0002', 'Invalid package name', 'Use lowercase URL-safe names such as kleur or @scope/tool.');
}

function packageError(message, code, title, hint, details = null) {
  return new KuraCliError(message, { code, title, hint, details });
}

export async function readProjectManifest(projectRoot) {
  const file = path.join(path.resolve(projectRoot), 'kura.json');
  if (!(await exists(file))) {
    throw packageError('No kura.json was found in this directory.', 'KR-PKG-0101', 'This is not a Kura package project', "Run 'kr new <name>' first, then enter the project directory.");
  }
  const text = await readTextFileSecure(file, { maxBytes: 1024 * 1024, allowSymlink: false });
  const manifest = parseJsonSecure(text, file);
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') {
    throw packageError('kura.json must contain a JSON object.', 'KR-PKG-0102', 'Invalid project manifest', 'Replace kura.json with a valid project configuration.');
  }
  manifest.dependencies = normalizeDependencyMap(manifest.dependencies, 'dependencies');
  manifest.devDependencies = normalizeDependencyMap(manifest.devDependencies, 'devDependencies');
  return { file, manifest };
}

function normalizeDependencyMap(value, label) {
  if (value === undefined) return {};
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw packageError(`${label} must be an object of package names and version ranges.`, 'KR-PKG-0103', 'Invalid dependency list', `Example: "${label}": { "kleur": "^4.1.5" }`);
  }
  const output = {};
  for (const [name, range] of Object.entries(value)) {
    const parsed = parsePackageSpec(`${name}@${range}`);
    if (parsed.type !== 'registry' || parsed.name !== name.toLowerCase()) throw invalidPackageName(name);
    output[parsed.name] = String(range);
  }
  return sortObject(output);
}

export async function saveProjectManifest(projectRoot, manifest) {
  const root = path.resolve(projectRoot);
  manifest.dependencies = sortObject(manifest.dependencies ?? {});
  manifest.devDependencies = sortObject(manifest.devDependencies ?? {});
  await atomicWriteFile(path.join(root, 'kura.json'), `${JSON.stringify(manifest, null, 2)}\n`, { root, mode: 0o600 });
}

export async function addDependency(projectRoot, spec, options = {}) {
  const root = path.resolve(projectRoot);
  const { manifest } = await readProjectManifest(root);
  const parsed = parsePackageSpec(spec);
  if (parsed.type === 'directory') {
    const local = await inspectLocalPackage(root, parsed.path);
    const target = options.dev ? 'devDependencies' : 'dependencies';
    manifest[target][local.name] = `file:${path.relative(root, local.directory).replaceAll('\\', '/') || '.'}`;
    await saveProjectManifest(root, manifest);
    const report = await installDependencies(root, options);
    return { name: local.name, range: manifest[target][local.name], ...report };
  }
  const registry = registryUrl(manifest, options);
  const metadata = await fetchMetadata(parsed.name, registry, options);
  const version = selectVersion(metadata, parsed.range);
  const target = options.dev ? 'devDependencies' : 'dependencies';
  const other = options.dev ? 'dependencies' : 'devDependencies';
  delete manifest[other][parsed.name];
  manifest[target][parsed.name] = options.exact ? version : `^${version}`;
  await saveProjectManifest(root, manifest);
  const report = await installDependencies(root, options);
  return { name: parsed.name, range: manifest[target][parsed.name], ...report };
}

export async function removeDependency(projectRoot, name, options = {}) {
  const root = path.resolve(projectRoot);
  const { manifest } = await readProjectManifest(root);
  const parsed = parsePackageSpec(name);
  if (parsed.type !== 'registry') throw packageError('kr remove expects a package name.', 'KR-PKG-0004', 'Invalid remove target', 'Example: kr remove kleur');
  const removed = delete manifest.dependencies[parsed.name] || delete manifest.devDependencies[parsed.name];
  if (!removed) throw packageError(`'${parsed.name}' is not listed in kura.json.`, 'KR-PKG-0104', 'Package is not installed', 'Run kr list to view the project dependencies.');
  await saveProjectManifest(root, manifest);
  return installDependencies(root, options);
}

export async function installDependencies(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const { manifest } = await readProjectManifest(root);
  const registry = registryUrl(manifest, options);
  const requested = sortObject({
    ...(manifest.dependencies ?? {}),
    ...(options.production ? {} : manifest.devDependencies ?? {}),
  });
  const lockPath = path.join(root, 'kura.lock');
  const existingLock = await readLockfile(lockPath);
  let lock;
  if (options.frozen) {
    if (!existingLock) throw packageError('kura.lock is required for --frozen.', 'KR-PKG-0201', 'Frozen installation has no lockfile', 'Run kr install once without --frozen to create kura.lock.');
    assertLockMatches(existingLock, requested);
    lock = existingLock;
  } else {
    const resolver = new Resolver({ root, registry, offline: options.offline, cacheDir: options.cacheDir });
    lock = await resolver.resolveRoot(requested);
  }

  const kuraDir = path.join(root, '.kura');
  const finalNodeModules = path.join(root, 'node_modules');
  const staging = path.join(kuraDir, `.install-${process.pid}-${Date.now().toString(36)}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, 'node_modules'), { recursive: true, mode: 0o700 });
  try {
    for (const [packagePath, record] of Object.entries(lock.packages)) {
      const destination = path.join(staging, packagePath);
      if (record.source?.startsWith('file:')) {
        await copyLocalPackage(path.resolve(root, record.source.slice(5)), destination, root);
      } else {
        const archive = await acquireTarball(record, { offline: options.offline, cacheDir: options.cacheDir });
        await extractTarGz(archive, destination);
      }
    }
    if (await exists(finalNodeModules)) {
      const marker = path.join(finalNodeModules, '.kura-package-store.json');
      if (!(await exists(marker)) && !options.force) {
        throw new KuraSecurityError('Kura will not replace an existing node_modules directory it does not own.', {
          code: 'KR-SEC-1311',
          hint: 'Move the existing node_modules directory, or rerun with --force after confirming it may be replaced.',
        });
      }
    }
    await atomicWriteFile(path.join(staging, 'node_modules', '.kura-package-store.json'), `${JSON.stringify({ managedBy: 'Kura v1.0.0', lockfileVersion: LOCKFILE_VERSION })}\n`, { root: staging, mode: 0o600 });
    await rm(finalNodeModules, { recursive: true, force: true });
    await rename(path.join(staging, 'node_modules'), finalNodeModules);
    if (process.platform !== 'win32') await chmod(finalNodeModules, 0o700).catch(() => {});
    await atomicWriteFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { root, mode: 0o600 });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return {
    installed: Object.keys(lock.packages).length,
    direct: Object.keys(requested).length,
    lockfile: lockPath,
    registry,
  };
}

export async function listDependencies(projectRoot) {
  const root = path.resolve(projectRoot);
  const { manifest } = await readProjectManifest(root);
  const lock = await readLockfile(path.join(root, 'kura.lock'));
  const rows = [];
  for (const [kind, deps] of [['dependency', manifest.dependencies], ['devDependency', manifest.devDependencies]]) {
    for (const [name, range] of Object.entries(deps ?? {})) {
      const record = lock?.packages?.[packageInstallKey(name)] ?? null;
      rows.push({ name, range, version: record?.version ?? null, kind, installed: Boolean(record) });
    }
  }
  return rows;
}

export async function cleanPackageCache(options = {}) {
  const directory = packageCacheDir(options.cacheDir);
  await rm(directory, { recursive: true, force: true });
  return directory;
}

class Resolver {
  constructor(options) {
    this.root = options.root;
    this.registry = options.registry;
    this.offline = Boolean(options.offline);
    this.cacheDir = options.cacheDir;
    this.packages = {};
    this.metadata = new Map();
  }

  async resolveRoot(requested) {
    for (const [name, range] of Object.entries(requested)) {
      if (range.startsWith('file:')) {
        await this.resolveLocal(name, range.slice(5), packageInstallKey(name), []);
      } else {
        await this.resolveRegistry(name, range, packageInstallKey(name), []);
      }
    }
    return {
      lockfileVersion: LOCKFILE_VERSION,
      generatedBy: 'Kura v1.0.0',
      registry: this.registry,
      dependencies: requested,
      packages: sortObject(this.packages),
    };
  }

  async resolveRegistry(name, range, installKey, ancestry) {
    const metadata = await this.getMetadata(name);
    const version = selectVersion(metadata, range);
    const identity = `${name}@${version}`;
    if (ancestry.includes(identity)) return;
    const versionData = metadata.versions?.[version];
    if (!versionData?.dist?.tarball) throw packageError(`${identity} has no downloadable tarball.`, 'KR-PKG-0301', 'Package cannot be downloaded', 'Choose another package version.');
    const dependencies = normalizeRemoteDependencies(versionData.dependencies);
    const record = {
      name,
      version,
      resolved: versionData.dist.tarball,
      integrity: versionData.dist.integrity ?? (versionData.dist.shasum ? `sha1-${Buffer.from(versionData.dist.shasum, 'hex').toString('base64')}` : null),
      dependencies,
    };
    if (!record.integrity) throw packageError(`${identity} does not publish an integrity hash.`, 'KR-PKG-0302', 'Package integrity metadata is missing', 'Use a package version that publishes dist.integrity or dist.shasum.');
    this.packages[installKey] = record;
    for (const [dependency, dependencyRange] of Object.entries(dependencies)) {
      await this.resolveRegistry(dependency, dependencyRange, nestedInstallKey(installKey, dependency), [...ancestry, identity]);
    }
  }

  async resolveLocal(expectedName, relative, installKey, ancestry) {
    const local = await inspectLocalPackage(this.root, relative);
    if (local.name !== expectedName) throw packageError(`Local package is named '${local.name}', not '${expectedName}'.`, 'KR-PKG-0303', 'Local package name mismatch', 'Update kura.json so the dependency key matches the local package name.');
    const identity = `${local.name}@${local.version}`;
    if (ancestry.includes(identity)) return;
    this.packages[installKey] = {
      name: local.name,
      version: local.version,
      source: `file:${path.relative(this.root, local.directory).replaceAll('\\', '/') || '.'}`,
      integrity: local.integrity,
      dependencies: local.dependencies,
    };
    for (const [dependency, range] of Object.entries(local.dependencies)) {
      if (range.startsWith('file:')) await this.resolveLocal(dependency, path.resolve(local.directory, range.slice(5)), nestedInstallKey(installKey, dependency), [...ancestry, identity]);
      else await this.resolveRegistry(dependency, range, nestedInstallKey(installKey, dependency), [...ancestry, identity]);
    }
  }

  async getMetadata(name) {
    if (this.metadata.has(name)) return this.metadata.get(name);
    const value = await fetchMetadata(name, this.registry, { offline: this.offline, cacheDir: this.cacheDir });
    this.metadata.set(name, value);
    return value;
  }
}

function normalizeRemoteDependencies(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return {};
  const output = {};
  for (const [name, range] of Object.entries(value)) {
    if (!SAFE_PACKAGE_NAME.test(name) || typeof range !== 'string' || range.length > 128) continue;
    output[name] = range;
  }
  return sortObject(output);
}

function registryUrl(manifest, options) {
  const configured = options.registry ?? process.env.KURA_REGISTRY ?? manifest.packageManager?.registry ?? DEFAULT_REGISTRY;
  let url;
  try { url = new URL(configured); } catch { throw packageError(`Invalid registry URL: ${configured}`, 'KR-PKG-0401', 'Invalid package registry', 'Use an HTTPS URL such as https://registry.npmjs.org'); }
  if (url.protocol !== 'https:' && !(options.allowHttpRegistry && url.protocol === 'http:')) {
    throw new KuraSecurityError('Package registries must use HTTPS.', { code: 'KR-SEC-1301', hint: 'Use an HTTPS registry. HTTP is allowed only for explicit local testing.' });
  }
  return url.href.replace(/\/$/, '');
}

async function fetchMetadata(name, registry, options = {}) {
  const cacheRoot = path.join(packageCacheDir(options.cacheDir), 'metadata');
  const cacheFile = path.join(cacheRoot, `${createHash('sha256').update(`${registry}\0${name}`).digest('hex')}.json`);
  if (options.offline) {
    if (!(await exists(cacheFile))) throw packageError(`No cached metadata is available for '${name}'.`, 'KR-PKG-0402', 'Offline package metadata is missing', 'Run kr install once while online, then retry with --offline.');
    return parseJsonSecure(await readTextFileSecure(cacheFile, { maxBytes: MAX_METADATA_BYTES, allowSymlink: false }), cacheFile);
  }
  const url = `${registry}/${encodeURIComponent(name).replace('%40', '@')}`;
  const response = await fetchWithLimits(url, { maxBytes: MAX_METADATA_BYTES, accept: 'application/vnd.npm.install-v1+json, application/json' });
  const text = response.toString('utf8');
  const metadata = parseJsonSecure(text, url);
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await atomicWriteFile(cacheFile, text, { root: packageCacheDir(options.cacheDir), mode: 0o600 });
  return metadata;
}

function selectVersion(metadata, range) {
  if (!metadata || typeof metadata !== 'object') throw packageError('The package registry returned invalid metadata.', 'KR-PKG-0403', 'Invalid registry response', 'Retry later or choose another registry.');
  const tagVersion = metadata['dist-tags']?.[range];
  if (tagVersion && metadata.versions?.[tagVersion]) return tagVersion;
  if (range === 'latest' && metadata['dist-tags']?.latest) return metadata['dist-tags'].latest;
  const versions = Object.keys(metadata.versions ?? {}).filter(version => parseSemver(version)).sort(compareVersions).reverse();
  const selected = versions.find(version => satisfies(version, range));
  if (!selected) throw packageError(`No published version satisfies '${range}'.`, 'KR-PKG-0404', 'No matching package version', `Available latest version: ${metadata['dist-tags']?.latest ?? versions[0] ?? 'unknown'}`);
  return selected;
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version));
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null } : null;
}

function compareVersions(left, right) {
  const a = parseSemver(left); const b = parseSemver(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] - b[key];
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

function satisfies(version, range) {
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease) return false;
  const value = String(range ?? '*').trim();
  if (!value || value === '*' || value.toLowerCase() === 'latest') return true;
  if (value.includes('||')) return value.split('||').some(part => satisfies(version, part.trim()));
  const hyphen = /^(\d+(?:\.\d+){0,2})\s+-\s+(\d+(?:\.\d+){0,2})$/.exec(value);
  if (hyphen) return compareVersions(version, normalizePartial(hyphen[1], false)) >= 0 && compareVersions(version, normalizePartial(hyphen[2], true)) <= 0;
  if (value.startsWith('^')) return caretSatisfied(parsed, value.slice(1));
  if (value.startsWith('~')) return tildeSatisfied(parsed, value.slice(1));
  if (/^[<>=]/.test(value)) return value.split(/\s+/).every(part => comparatorSatisfied(version, part));
  if (/^[v]?\d+(?:\.\d+)?(?:\.x|\.\*)?$/.test(value) || /^[v]?\d+(?:\.x|\.\*)$/.test(value)) return partialSatisfied(parsed, value.replace(/^v/, ''));
  return version === value.replace(/^v/, '');
}

function partialSatisfied(version, range) {
  const parts = range.split('.');
  if (parts[0] !== undefined && !['x', '*'].includes(parts[0]) && version.major !== Number(parts[0])) return false;
  if (parts[1] !== undefined && !['x', '*'].includes(parts[1]) && version.minor !== Number(parts[1])) return false;
  if (parts[2] !== undefined && !['x', '*'].includes(parts[2]) && version.patch !== Number(parts[2])) return false;
  return true;
}

function caretSatisfied(version, baseText) {
  const base = parseSemver(normalizePartial(baseText, false)); if (!base) return false;
  if (compareVersions(`${version.major}.${version.minor}.${version.patch}`, `${base.major}.${base.minor}.${base.patch}`) < 0) return false;
  if (base.major > 0) return version.major === base.major;
  if (base.minor > 0) return version.major === 0 && version.minor === base.minor;
  return version.major === 0 && version.minor === 0 && version.patch === base.patch;
}

function tildeSatisfied(version, baseText) {
  const base = parseSemver(normalizePartial(baseText, false)); if (!base) return false;
  return version.major === base.major && version.minor === base.minor && compareVersions(`${version.major}.${version.minor}.${version.patch}`, `${base.major}.${base.minor}.${base.patch}`) >= 0;
}

function normalizePartial(text, upper) {
  const parts = String(text).replace(/^v/, '').split('.').map(Number);
  if (parts.length === 1) return upper ? `${parts[0]}.999999.999999` : `${parts[0]}.0.0`;
  if (parts.length === 2) return upper ? `${parts[0]}.${parts[1]}.999999` : `${parts[0]}.${parts[1]}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function comparatorSatisfied(version, comparator) {
  const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(comparator);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const target = normalizePartial(match[2], operator === '<' || operator === '<=');
  const comparison = compareVersions(version, target);
  return operator === '>' ? comparison > 0 : operator === '>=' ? comparison >= 0 : operator === '<' ? comparison < 0 : operator === '<=' ? comparison <= 0 : comparison === 0;
}

async function fetchWithLimits(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  timer.unref?.();
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: options.accept ?? 'application/octet-stream', 'user-agent': 'Kura/1.0.0 package-manager' },
    });
  } catch (error) {
    throw packageError(`Could not download ${url}.`, 'KR-PKG-0501', 'Package download failed', 'Check the network, registry URL, proxy, and firewall.', error.message);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw packageError(`Registry returned HTTP ${response.status} for ${url}.`, 'KR-PKG-0502', 'Package download failed', 'Check the package name and version, then retry.');
  const declared = Number(response.headers.get('content-length') ?? 0);
  const maximum = options.maxBytes ?? MAX_TARBALL_BYTES;
  if (declared > maximum) throw new KuraSecurityError(`Download exceeds the safe ${formatBytes(maximum)} limit.`, { code: 'KR-SEC-1302' });
  const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maximum) throw new KuraSecurityError(`Download exceeds the safe ${formatBytes(maximum)} limit.`, { code: 'KR-SEC-1302' });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

async function acquireTarball(record, options = {}) {
  const cacheRoot = path.join(packageCacheDir(options.cacheDir), 'tarballs');
  const cacheName = createHash('sha256').update(`${record.resolved}\0${record.integrity}`).digest('hex') + '.tgz';
  const cacheFile = path.join(cacheRoot, cacheName);
  let data;
  if (await exists(cacheFile)) data = await readFile(cacheFile);
  else {
    if (options.offline) throw packageError(`Package archive for ${record.name}@${record.version} is not cached.`, 'KR-PKG-0503', 'Offline package archive is missing', 'Run kr install once while online.');
    data = await fetchWithLimits(record.resolved, { maxBytes: MAX_TARBALL_BYTES });
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    await atomicWriteFile(cacheFile, data, { root: packageCacheDir(options.cacheDir), mode: 0o600, encoding: null });
  }
  verifyIntegrity(data, record.integrity, `${record.name}@${record.version}`);
  return data;
}

function verifyIntegrity(data, integrity, label) {
  const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(String(integrity));
  if (!match) throw new KuraSecurityError(`Unsupported integrity format for ${label}.`, { code: 'KR-SEC-1303' });
  const actual = createHash(match[1]).update(data).digest('base64');
  if (actual !== match[2]) throw new KuraSecurityError(`Integrity verification failed for ${label}.`, {
    code: 'KR-SEC-1304',
    hint: 'Clear the package cache and retry. Do not use the downloaded archive.',
  });
}

async function extractTarGz(archive, destination) {
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES }); }
  catch (error) { throw packageError('The package archive is not a valid gzip tarball.', 'KR-PKG-0601', 'Corrupt package archive', 'Clear the cache and retry.', error.message); }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let offset = 0; let files = 0; let total = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const full = [prefix, name].filter(Boolean).join('/').replace(/^package\//, '');
    const size = parseTarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) throw packageError('The package tar header is invalid.', 'KR-PKG-0602', 'Corrupt package archive', 'Clear the cache and retry.');
    if (full && full !== 'package') {
      validateArchivePath(full);
      const output = path.join(destination, ...full.split('/'));
      if (type === '0' || type === '\0') {
        files++; total += size;
        if (files > MAX_PACKAGE_FILES || total > MAX_EXTRACTED_BYTES) throw new KuraSecurityError('Package extraction exceeded safe limits.', { code: 'KR-SEC-1305' });
        await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
        await atomicWriteFile(output, tar.subarray(offset, offset + size), { root: destination, mode: 0o600, encoding: null });
      } else if (type === '5') {
        await mkdir(output, { recursive: true, mode: 0o700 });
      } else if (!['x', 'g'].includes(type)) {
        throw new KuraSecurityError(`Package archive entry type '${type}' is not allowed.`, { code: 'KR-SEC-1306', details: full });
      }
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!(await exists(path.join(destination, 'package.json')))) {
    throw packageError('The package archive does not contain package.json.', 'KR-PKG-0603', 'Invalid package archive', 'Choose a valid npm-compatible package.');
  }
}

function validateArchivePath(value) {
  if (!value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) throw new KuraSecurityError('Unsafe path in package archive.', { code: 'KR-SEC-1307' });
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new KuraSecurityError('Package archive attempted path traversal.', { code: 'KR-SEC-1308', details: value });
}

function readTarString(buffer, start, length) { return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '').trim(); }
function parseTarOctal(buffer, start, length) { const value = readTarString(buffer, start, length).replace(/\s/g, ''); return value ? Number.parseInt(value, 8) : 0; }

async function inspectLocalPackage(projectRoot, input) {
  const directory = path.resolve(projectRoot, input);
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw packageError(`Local package directory not found: ${directory}`, 'KR-PKG-0701', 'Local package is unavailable', 'Use a regular directory containing package.json.');
  const manifestFile = path.join(directory, 'package.json');
  const text = await readTextFileSecure(manifestFile, { maxBytes: 1024 * 1024, allowSymlink: false });
  const manifest = parseJsonSecure(text, manifestFile);
  if (!SAFE_PACKAGE_NAME.test(String(manifest.name ?? ''))) throw invalidPackageName(manifest.name ?? '');
  if (!parseSemver(manifest.version)) throw packageError('Local package version must use x.y.z.', 'KR-PKG-0702', 'Invalid local package version', 'Set package.json version to a semantic version such as 1.0.0.');
  const integrity = `sha256-${(await hashDirectory(directory)).toString('base64')}`;
  return { directory, name: manifest.name, version: manifest.version, dependencies: normalizeRemoteDependencies(manifest.dependencies), integrity };
}

async function hashDirectory(directory) {
  const hash = createHash('sha256');
  async function walk(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (['node_modules', '.git', '.kura'].includes(entry.name)) continue;
      const rel = path.posix.join(relative, entry.name);
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new KuraSecurityError('Local packages may not contain symbolic links.', { code: 'KR-SEC-1309', details: full });
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) { hash.update(rel); hash.update('\0'); hash.update(await readFile(full)); hash.update('\0'); }
    }
  }
  await walk(directory);
  return hash.digest();
}

async function copyLocalPackage(source, destination, projectRoot) {
  const sourceRoot = path.resolve(source);
  if (sourceRoot === path.resolve(projectRoot) || sourceRoot.startsWith(`${path.resolve(projectRoot, '.kura')}${path.sep}`)) {
    throw new KuraSecurityError('A local package may not point at the project root or .kura directory.', { code: 'KR-SEC-1310' });
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  async function copy(current, target) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (['node_modules', '.git', '.kura'].includes(entry.name)) continue;
      const from = path.join(current, entry.name); const to = path.join(target, entry.name);
      if (entry.isSymbolicLink()) throw new KuraSecurityError('Local packages may not contain symbolic links.', { code: 'KR-SEC-1309', details: from });
      if (entry.isDirectory()) { await mkdir(to, { recursive: true, mode: 0o700 }); await copy(from, to); }
      else if (entry.isFile()) await atomicWriteFile(to, await readFile(from), { root: destination, mode: 0o600, encoding: null });
    }
  }
  await copy(sourceRoot, destination);
}

async function readLockfile(file) {
  if (!(await exists(file))) return null;
  const text = await readTextFileSecure(file, { maxBytes: 16 * 1024 * 1024, allowSymlink: false });
  const lock = parseJsonSecure(text, file);
  if (lock.lockfileVersion !== LOCKFILE_VERSION || !lock.packages || typeof lock.packages !== 'object') {
    throw packageError('kura.lock uses an unsupported format.', 'KR-PKG-0801', 'Lockfile cannot be read', 'Delete kura.lock and run kr install to regenerate it.');
  }
  return lock;
}

function assertLockMatches(lock, requested) {
  if (JSON.stringify(sortObject(lock.dependencies ?? {})) !== JSON.stringify(sortObject(requested))) {
    throw packageError('kura.json and kura.lock do not describe the same dependencies.', 'KR-PKG-0802', 'Frozen lockfile is out of date', 'Run kr install without --frozen and commit the updated kura.lock.');
  }
}

function packageInstallKey(name) { return `node_modules/${name}`; }
function nestedInstallKey(parent, name) { return `${parent}/node_modules/${name}`; }
function packageCacheDir(override) { return path.resolve(override ?? process.env.KURA_CACHE_DIR ?? path.join(homedir(), '.kura', 'cache', 'packages')); }
function sortObject(value) { return Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))); }
function formatBytes(bytes) { const units = ['B', 'KiB', 'MiB', 'GiB']; let value = bytes; let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; } return `${value.toFixed(index ? 1 : 0)} ${units[index]}`; }
