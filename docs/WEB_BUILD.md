# Kura Browser Build Tool

`kr-web` is the dedicated workflow for browser and full-stack Kura projects.

## Create a project

```bash
kr-web new my-browser-app --type browser
cd my-browser-app
kr-web dev --open
```

Available project types:

- `browser` — browser Kura entry, public HTML, and `kura-web.json`
- `api` — Kura HTTP API using `std:web`
- `fullstack` — separate `server/main.kr` and `client/main.kr` entries

## Configuration

Browser projects may contain `kura-web.json`:

```json
{
  "entry": "src/main.kr",
  "publicDir": "public",
  "outDir": "dist",
  "title": "My Kura App"
}
```

Only these four settings are accepted. Paths are resolved beneath the project directory.

## Development

```bash
kr-web dev
kr-web dev --host 0.0.0.0 --port 5173
```

The command delegates to Kura's browser development server and supplies the configured entry and public directory. Source and asset changes rebuild and reload the page.

## Production build

```bash
kr-web build
```

The builder:

1. compiles the Kura entry for the browser target
2. optimizes and compacts generated ESM
3. rewrites browser-safe `std:` imports
4. rejects Node.js, file URL, executable URL, and unsupported bare-package imports
5. copies browser standard modules
6. copies public files while rejecting symlinks and oversized assets
7. creates a content-hashed application module
8. injects the module into `index.html`
9. emits `kura-web-manifest.json` with SHA-256 checksums and byte sizes

Typical output:

```text
dist/
  index.html
  kura-web-manifest.json
  assets/
    app-0123456789abcdef.mjs
  _kura/
    std/
      browser.mjs
```

Options:

```bash
kr-web build --out-dir build-web
kr-web build --public-dir static
kr-web build --no-clean
kr-web build --no-optimize
```

The default browser policy currently permits `std:browser`. Server-only modules such as `std:web`, `std:http`, `std:fs`, `std:env`, and Node built-ins are rejected from browser artifacts.

Bare npm imports are also rejected until the browser package-bundling adapter is enabled. This prevents a build from silently producing unresolved browser imports.

## Preview

```bash
kr-web preview
kr-web preview --host 0.0.0.0 --port 4173
```

The preview server serves the production directory with MIME types, asset limits, secure response headers, and optional SPA fallback to `index.html`.

## Deployment

The generated `dist` directory is static and can be deployed to:

- Cloudflare Pages
- GitHub Pages
- Netlify
- Render static sites
- object storage and a CDN
- any conventional static HTTP server

Deploy the complete output directory, including `_kura/std` and `kura-web-manifest.json`.

For a full-stack application, deploy the server entry as a Node service and the browser output as a static site, or serve the built directory through the Kura server's `staticFiles()` middleware.

## Security guarantees

The build pipeline enforces:

- entry and output containment beneath the project root
- no output directly over the project root
- no symbolic links in public assets
- finite file-count and per-asset limits
- no `node:` imports in browser artifacts
- no local `file:` URLs in published code
- no remote `http:`, `https:`, `data:`, or `javascript:` imports
- no unresolved bare-package imports
- content hashes for generated and copied output

The manifest is an integrity inventory, not a digital signature. A deployment pipeline should sign or attest release artifacts separately when supply-chain verification is required.