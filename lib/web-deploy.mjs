// SPDX-License-Identifier: MIT OR Apache-2.0
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class DeploymentError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'DeploymentError';
    this.code = options.code ?? 'KR-DEPLOY-0001';
  }
}

export async function generateDeployment(options = {}) {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const target = options.target ?? 'docker';
  const name = safeName(options.name ?? path.basename(root));
  const port = validPort(options.port ?? 3000);
  const startCommand = options.startCommand ?? 'kr run --timeout-ms 0';
  const healthPath = normalizeHealthPath(options.healthPath ?? '/health');
  const files = deploymentFiles(target, { name, port, startCommand, healthPath, nodeVersion: options.nodeVersion ?? '22', region: options.region, runtime: options.runtime ?? 'node' });
  const written = [];
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.resolve(root, relative);
    ensureInside(destination, root);
    if (!options.force && await exists(destination)) throw new DeploymentError(`Refusing to overwrite existing file: ${relative}`, { code: 'KR-DEPLOY-0101' });
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    written.push({ file: relative, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
  }
  return Object.freeze({ target, root, files: Object.freeze(written) });
}

export async function deploymentDoctor(options = {}) {
  const root = path.resolve(options.projectRoot ?? process.cwd());
  const findings = [];
  const required = ['package.json'];
  for (const name of required) if (!(await exists(path.join(root, name)))) findings.push(finding('error', 'KR-DEPLOY-0201', `Missing ${name}.`));
  const packageFile = path.join(root, 'package.json');
  if (await exists(packageFile)) {
    try {
      const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
      if (packageJson.engines?.node && !/^>=?\s*(20|21|22|23|24|25|26)/.test(packageJson.engines.node)) findings.push(finding('warning', 'KR-DEPLOY-0202', `Node engine '${packageJson.engines.node}' may not support Kura v1.`));
      if (!packageJson.bin?.kr && packageJson.name === '@kura-lang/compiler') findings.push(finding('error', 'KR-DEPLOY-0203', 'Kura package is missing the kr binary.'));
    } catch (error) { findings.push(finding('error', 'KR-DEPLOY-0204', `package.json is invalid: ${error.message}`)); }
  }
  const configFiles = ['Dockerfile', 'render.yaml', 'fly.toml', 'railway.json', 'Procfile'];
  if (!(await anyExists(root, configFiles))) findings.push(finding('info', 'KR-DEPLOY-0205', 'No deployment configuration found. Run kr-web deploy docker or kr-web deploy render.'));
  const envExample = path.join(root, '.env.example');
  if (!(await exists(envExample))) findings.push(finding('warning', 'KR-DEPLOY-0206', '.env.example is missing. Document required secrets without including real values.'));
  for (const file of await listKnownEnvFiles(root)) {
    const info = await stat(file);
    if (info.size > 1024 * 1024) findings.push(finding('warning', 'KR-DEPLOY-0207', `${path.basename(file)} is unusually large.`));
    if (!options.allowEnvFiles) findings.push(finding('warning', 'KR-DEPLOY-0208', `${path.basename(file)} exists. Ensure it is ignored by Git and excluded from images.`));
  }
  for (const variable of options.requiredEnv ?? []) if (!process.env[variable]) findings.push(finding('error', 'KR-DEPLOY-0209', `Required environment variable '${variable}' is missing.`));
  const errors = findings.filter(item => item.severity === 'error').length;
  return Object.freeze({ ok: errors === 0, root, errors, warnings: findings.filter(item => item.severity === 'warning').length, findings: Object.freeze(findings) });
}

export function renderDeployment(options) {
  return `services:
  - type: web
    name: ${yaml(options.name)}
    runtime: node
    plan: free
    buildCommand: npm ci --ignore-scripts
    startCommand: ${yaml(options.startCommand)}
    healthCheckPath: ${yaml(options.healthPath)}
    autoDeploy: false
    envVars:
      - key: NODE_VERSION
        value: ${yaml(options.nodeVersion)}
      - key: NODE_ENV
        value: production
      - key: PORT
        value: ${options.port}
      - key: SESSION_SECRET
        generateValue: true
      - key: CSRF_SECRET
        generateValue: true
`;
}

export function dockerfile(options) {
  return `# syntax=docker/dockerfile:1.7
FROM node:${options.nodeVersion}-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force

FROM node:${options.nodeVersion}-bookworm-slim AS runtime
ENV NODE_ENV=production \\
    PORT=${options.port}
WORKDIR /app
RUN groupadd --system --gid 10001 kura && useradd --system --uid 10001 --gid kura --home-dir /app kura
COPY --from=dependencies --chown=kura:kura /app/node_modules ./node_modules
COPY --chown=kura:kura . .
USER kura
EXPOSE ${options.port}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:${options.port}${options.healthPath}').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-lc", ${JSON.stringify(options.startCommand)}]
`;
}

export function flyConfig(options) {
  return `app = ${toml(options.name)}
primary_region = ${toml(options.region ?? 'nrt')}

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "${options.port}"

[http_service]
  internal_port = ${options.port}
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = ${toml(options.healthPath)}
`;
}

export function railwayConfig(options) {
  return `${JSON.stringify({
    $schema: 'https://railway.app/railway.schema.json',
    build: { builder: 'NIXPACKS' },
    deploy: {
      startCommand: options.startCommand,
      healthcheckPath: options.healthPath,
      healthcheckTimeout: 100,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
    },
  }, null, 2)}\n`;
}

export function systemdUnit(options) {
  return `[Unit]
Description=Kura Web service ${options.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kura
Group=kura
WorkingDirectory=/srv/${options.name}
Environment=NODE_ENV=production
Environment=PORT=${options.port}
EnvironmentFile=-/etc/${options.name}.env
ExecStart=/usr/bin/env ${options.startCommand}
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/${options.name}/.kura
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;
}

export function nginxConfig(options) {
  return `server {
    listen 80;
    server_name ${options.domain ?? '_'};

    location / {
      proxy_pass http://127.0.0.1:${options.port};
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;
      proxy_read_timeout 65s;
      client_max_body_size 16m;
    }
  }
`;
}

function deploymentFiles(target, options) {
  const common = {
    '.dockerignore': `.git\n.github\n.kura\nnode_modules\nnpm-debug.log*\n.env\n.env.*\n!.env.example\ncoverage\nbuild\ndist\n*.zip\n`,
    '.env.example': `NODE_ENV=production\nPORT=${options.port}\nDATABASE_URL=\nSESSION_SECRET=replace-with-at-least-32-random-bytes\nCSRF_SECRET=replace-with-at-least-32-random-bytes\nLOG_LEVEL=info\n`,
  };
  if (target === 'docker') return { ...common, Dockerfile: dockerfile(options), 'compose.yaml': composeConfig(options) };
  if (target === 'render') return { ...common, 'render.yaml': renderDeployment(options) };
  if (target === 'fly') return { ...common, Dockerfile: dockerfile(options), 'fly.toml': flyConfig(options) };
  if (target === 'railway') return { ...common, 'railway.json': railwayConfig(options) };
  if (target === 'systemd') return { ...common, [`deploy/${options.name}.service`]: systemdUnit(options), [`deploy/${options.name}.nginx.conf`]: nginxConfig(options) };
  throw new DeploymentError(`Unsupported deployment target '${target}'.`, { code: 'KR-DEPLOY-0102' });
}

function composeConfig(options) {
  return `services:
  app:
    build: .
    init: true
    restart: unless-stopped
    ports:
      - "${options.port}:${options.port}"
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: ${options.port}
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
`;
}
function safeName(value) { const output = String(value).toLowerCase(); if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(output)) throw new DeploymentError(`Invalid deployment name '${value}'.`, { code: 'KR-DEPLOY-0103' }); return output; }
function validPort(value) { const port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeploymentError(`Invalid deployment port '${value}'.`, { code: 'KR-DEPLOY-0104' }); return port; }
function normalizeHealthPath(value) { const output = String(value); if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(output) || output.includes('..')) throw new DeploymentError('Health path is invalid.', { code: 'KR-DEPLOY-0105' }); return output; }
function ensureInside(candidate, root) { const relative = path.relative(root, candidate); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new DeploymentError('Deployment file escaped project root.', { code: 'KR-DEPLOY-0106' }); }
function finding(severity, code, message) { return Object.freeze({ severity, code, message }); }
function yaml(value) { return JSON.stringify(String(value)); }
function toml(value) { return JSON.stringify(String(value)); }
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function anyExists(root, names) { for (const name of names) if (await exists(path.join(root, name))) return true; return false; }
async function listKnownEnvFiles(root) { const output=[]; for (const name of ['.env','.env.local','.env.production','.env.development']) { const file=path.join(root,name); if (await exists(file)) output.push(file); } return output; }
