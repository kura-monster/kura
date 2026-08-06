// SPDX-License-Identifier: MIT OR Apache-2.0
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export class WebE2EError extends Error {
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'WebE2EError';
    this.code = options.code ?? 'KR-WEB-E2E-0001';
    this.hint = options.hint ?? null;
    this.details = options.details ?? null;
  }
}

export async function runBrowserChecks(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const playwright = await loadPlaywright(projectRoot);
  const browserName = options.browser ?? 'chromium';
  if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new WebE2EError(`Unsupported browser '${browserName}'.`, { code: 'KR-WEB-E2E-0101' });
  const checks = options.checks ?? [];
  const browser = await playwright[browserName].launch({ headless: options.headless !== false, ...(options.launch ?? {}) });
  const context = await browser.newContext({ baseURL: options.baseUrl, ignoreHTTPSErrors: Boolean(options.ignoreHTTPSErrors), ...(options.context ?? {}) });
  const results = [];
  try {
    for (const check of checks) {
      const page = await context.newPage();
      const started = performance.now();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)));
      try {
        const response = await page.goto(check.path ?? '/', { waitUntil: check.waitUntil ?? 'networkidle', timeout: check.timeoutMs ?? options.timeoutMs ?? 30_000 });
        const status = response?.status() ?? null;
        if (check.status !== undefined && status !== check.status) throw new WebE2EError(`Expected HTTP ${check.status}, received ${status}.`, { code: 'KR-WEB-E2E-0201' });
        if (check.title !== undefined) {
          const actual = await page.title();
          assertMatch(actual, check.title, 'page title');
        }
        if (check.text !== undefined) {
          const body = await page.locator('body').innerText();
          assertMatch(body, check.text, 'page text');
        }
        if (check.selector) {
          const locator = page.locator(check.selector);
          await locator.waitFor({ state: check.state ?? 'visible', timeout: check.timeoutMs ?? options.timeoutMs ?? 30_000 });
          if (check.selectorText !== undefined) assertMatch(await locator.innerText(), check.selectorText, `selector ${check.selector}`);
        }
        for (const action of check.actions ?? []) await performAction(page, action);
        if (check.noConsoleErrors !== false && consoleErrors.length) throw new WebE2EError('Browser console errors were recorded.', { code: 'KR-WEB-E2E-0202', details: consoleErrors });
        if (pageErrors.length) throw new WebE2EError('Unhandled browser page errors were recorded.', { code: 'KR-WEB-E2E-0203', details: pageErrors });
        results.push({ name: check.name ?? check.path ?? '/', status: 'passed', durationMs: performance.now() - started, httpStatus: status });
      } catch (error) {
        if (options.screenshotDir) {
          const file = path.join(options.screenshotDir, `${safeFileName(check.name ?? check.path ?? 'failed')}.png`);
          await page.screenshot({ path: file, fullPage: true }).catch(() => {});
        }
        results.push({ name: check.name ?? check.path ?? '/', status: 'failed', durationMs: performance.now() - started, error: String(error?.message ?? error), code: error?.code ?? null, details: error?.details ?? null });
        if (options.failFast) break;
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  const failed = results.filter(result => result.status === 'failed').length;
  return Object.freeze({ ok: failed === 0, browser: browserName, passed: results.length - failed, failed, results: Object.freeze(results) });
}

export async function loadE2EConfig(file = 'kura-e2e.json') {
  const resolved = path.resolve(file);
  let value;
  try { value = JSON.parse(await readFile(resolved, 'utf8')); }
  catch (error) { throw new WebE2EError(`Could not read E2E configuration: ${resolved}`, { code: 'KR-WEB-E2E-0301', cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.checks)) throw new WebE2EError('E2E configuration must contain a checks array.', { code: 'KR-WEB-E2E-0302' });
  return value;
}

async function performAction(page, action) {
  const type = action.type ?? 'click';
  const locator = action.selector ? page.locator(action.selector) : null;
  if (type === 'click') await locator.click(action.options ?? {});
  else if (type === 'fill') await locator.fill(String(action.value ?? ''));
  else if (type === 'press') await locator.press(String(action.key));
  else if (type === 'check') await locator.check();
  else if (type === 'uncheck') await locator.uncheck();
  else if (type === 'select') await locator.selectOption(action.value);
  else if (type === 'wait') await page.waitForTimeout(Number(action.ms ?? 100));
  else if (type === 'url') await page.waitForURL(action.value, { timeout: action.timeoutMs ?? 30_000 });
  else if (type === 'text') assertMatch(await locator.innerText(), action.value, `selector ${action.selector}`);
  else throw new WebE2EError(`Unknown E2E action '${type}'.`, { code: 'KR-WEB-E2E-0204' });
}

function assertMatch(actual, expected, label) { if (expected && typeof expected === 'object' && expected.pattern) { const regex=new RegExp(expected.pattern,expected.flags??''); if(!regex.test(actual))throw new WebE2EError(`${label} did not match /${expected.pattern}/.`,{code:'KR-WEB-E2E-0205',details:{actual}}); } else if (!String(actual).includes(String(expected))) throw new WebE2EError(`${label} did not contain '${expected}'.`, { code:'KR-WEB-E2E-0206', details:{actual} }); }
async function loadPlaywright(projectRoot) { const packageFile=path.join(projectRoot,'package.json'); if(!(await exists(packageFile)))throw new WebE2EError('package.json is required to resolve Playwright.',{code:'KR-WEB-E2E-0102'}); const require=createRequire(packageFile); let resolved; try{resolved=require.resolve('playwright');}catch(error){throw new WebE2EError('Playwright is not installed.',{code:'KR-WEB-E2E-0103',cause:error,hint:'Run kr add playwright --dev, then npx playwright install.'});} return import(pathToFileURL(resolved).href); }
function safeFileName(value){return String(value).replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,100)||'failed'}
async function exists(file){try{await access(file);return true}catch{return false}}
