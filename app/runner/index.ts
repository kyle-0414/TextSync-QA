import { chromium, Locator, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

// ─── 설정 ─────────────────────────────────────────────────────────────────────
const VIEWER_URL        = 'https://192.168.128.144';
const PASSCODE          = '000000';
const SPEC_PATH         = path.resolve('data/spec/flag-spec.csv');
const OUT_DIR           = path.resolve('data/exports');
const SCREENSHOT_DIR    = path.resolve('data/screenshots');
const CACHE_PATH        = path.join(OUT_DIR, 'verification_cache.json');
const LIVE_RESULTS_PATH = path.join(OUT_DIR, 'live_results.json');

// ─── 타입 ─────────────────────────────────────────────────────────────────────
interface FlagSpec {
  FlagName: string; Category: string; UIDisplayName: string; ExpectedMeaning: string; ExpectedAction: string;
}
interface CacheItem {
  flagName: string; status: 'PASS' | 'FAIL' | 'WARNING'; firstTestId: string; verifiedAt: string;
  actualMeaning?: string; actualAction?: string; actualName?: string; screenshotPath?: string;
}
interface QAResult {
  timestamp: string; testId: string; flagName: string; category: string; status: 'PASS' | 'FAIL' | 'WARNING' | 'SKIP_VERIFIED' | 'ERROR';
  actualMeaning?: string; actualAction?: string; actualName?: string; screenshotPath?: string; note: string;
}

interface TestListRow {
  testId: string;
  text: string;
}

// ─── 유틸리티 ──────────────────────────────────────────────────────────────
const norm = (s: string) => (s || '').toLowerCase().replace(/['".,?]/g, '').replace(/[–—-]/g, '-').replace(/\s+/g,' ').trim();
const normNameMinor = (s: string) => (s || '').toLowerCase().replace(/['".,?!]/g, '').replace(/\s+/g, ' ').trim();
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const REPORT_LINK_SELECTOR = 'text=View Report';
const SUMMARY_TAB_SELECTOR = 'div:has-text("Summary"), button:has-text("Summary"), [role="tab"]:has-text("Summary")';
const FLAG_ITEM_SELECTOR = 'div:has(> span):has(svg), div:has(> span):has(i)';
const REPORT_ROW_SELECTOR = 'tr, div[role="row"], tr[role="row"], [class*="row"], [class*="Row"], [class*="list-item"], [class*="ListItem"], [class*="report"], [class*="Report"]';
const TEST_ID_PATTERN = /X\d{5}_\d{6}_\d{3}|[A-Z0-9]+(?:_[A-Z0-9]+){1,}|\d{12,}/i;

async function waitForLocatorCount(locator: Locator, minCount = 1, timeout = 10000, pollMs = 250) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const count = await locator.count().catch(() => 0);
    if (count >= minCount) return count;
    await locator.page().waitForTimeout(pollMs);
  }

  return 0;
}

async function waitForVisibleLocator(locator: Locator, timeout = 10000, pollMs = 250) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    if (await locator.isVisible().catch(() => false)) return true;
    await locator.page().waitForTimeout(pollMs);
  }

  return false;
}

async function waitForReportLinks(page: Page, timeout = 12000) {
  const reportLinks = page.locator(REPORT_LINK_SELECTOR).filter({ visible: true });
  await waitForLocatorCount(reportLinks, 1, timeout);
  return reportLinks;
}

async function findFirstVisibleEnabled(locator: Locator, limit = 10) {
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, limit); i++) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    const disabled = await candidate.evaluate((el) => {
      const node = el as HTMLElement;
      return node.getAttribute('aria-disabled') === 'true' || (node as HTMLButtonElement).disabled === true;
    }).catch(() => false);

    if (!disabled) return candidate;
  }

  return null;
}

function getReportTargetCandidates(page: Page) {
  return [
    page.getByRole('button', { name: /view report/i }),
    page.getByRole('link', { name: /view report/i }),
    page.locator('[role="button"]').filter({ hasText: /view report/i }),
    page.locator('button').filter({ hasText: /view report/i }),
    page.locator(REPORT_LINK_SELECTOR),
    page.locator('*').filter({ hasText: /^View Report$/ })
  ];
}

function getTestListNavCandidates(page: Page) {
  return [
    page.getByRole('tab', { name: /test list/i }),
    page.getByRole('button', { name: /test list/i }),
    page.locator('[role="button"]').filter({ hasText: /test list/i }),
    page.locator('button').filter({ hasText: /test list/i }),
    page.locator('div').filter({ hasText: /^Test List$/ })
  ];
}

async function waitForFirstReportTarget(page: Page, timeout = 8000, pollMs = 150) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    for (const candidateGroup of getReportTargetCandidates(page)) {
      const candidate = await findFirstVisibleEnabled(candidateGroup);
      if (candidate) return candidate;
    }

    await page.waitForTimeout(pollMs);
  }

  return null;
}

async function waitForAnyVisibleLocator(page: Page, locators: Locator[], timeout = 10000, pollMs = 250) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    for (const locator of locators) {
      if (await locator.isVisible().catch(() => false)) return true;
    }

    await page.waitForTimeout(pollMs);
  }

  return false;
}

async function getVisibleReportTargets(page: Page) {
  for (const candidateGroup of getReportTargetCandidates(page)) {
    const count = await candidateGroup.count().catch(() => 0);
    if (count > 0) return candidateGroup.filter({ visible: true });
  }

  return page.locator(REPORT_LINK_SELECTOR).filter({ visible: true });
}

async function waitForTestListReady(page: Page, timeout = 30000, pollMs = 250) {
  return waitForAnyVisibleLocator(
    page,
    [
      page.getByRole('tab', { name: /test list/i }).first(),
      page.getByRole('button', { name: /test list/i }).first(),
      page.locator('text=Test List').first(),
      page.locator(REPORT_LINK_SELECTOR).first()
    ],
    timeout,
    pollMs
  );
}

async function getVisibleTestListRows(page: Page): Promise<TestListRow[]> {
  return page.evaluate(({ testIdPatternSource }) => {
    const pattern = new RegExp(testIdPatternSource, 'i');
    const isVisible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const results: Array<{ testId: string; text: string }> = [];
    const seen = new Set<string>();
    const elements = Array.from(document.querySelectorAll('body *'));

    for (const el of elements) {
      if (!isVisible(el)) continue;

      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (text.length > 160) continue;

      const match = text.match(pattern);
      if (!match) continue;

      const testId = match[0].trim();
      if (seen.has(testId)) continue;
      if (text !== testId && !text.startsWith(testId)) continue;

      seen.add(testId);
      results.push({ testId, text });
    }

    return results;
  }, { testIdPatternSource: TEST_ID_PATTERN.source });
}

async function waitForVisibleTestListRows(page: Page, timeout = 12000, pollMs = 300) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const rows = await getVisibleTestListRows(page);
    if (rows.length > 0) return rows;
    await page.waitForTimeout(pollMs);
  }

  return [];
}

function getTestIdCellCandidates(page: Page, testId: string) {
  const escaped = escapeRegex(testId);

  return [
    page.getByText(new RegExp(`^\\s*${escaped}\\s*$`)),
    page.locator('td, div, span, a, button').filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }),
    page.locator(`text=/${escaped}/`)
  ];
}

async function findTestIdCell(page: Page, testId: string) {
  for (const candidates of getTestIdCellCandidates(page, testId)) {
    const candidate = await findFirstVisibleEnabled(candidates, 10);
    if (candidate) return candidate;
  }

  return null;
}

async function logTestListDiagnostics(page: Page) {
  const snapshot = await page.evaluate(({ testIdPatternSource }) => {
    const pattern = new RegExp(testIdPatternSource, 'i');
    const rows = Array.from(document.querySelectorAll('body *')).slice(0, 200);

    return rows.map((row, index) => {
      const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      const rect = row.getBoundingClientRect();
      const style = window.getComputedStyle(row as HTMLElement);
      const match = text.match(pattern);
      return {
        index,
        tag: row.tagName,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
        testId: match ? match[0] : null,
        text: text.slice(0, 180)
      };
    }).filter((item) => item.visible && item.text);
  }, { testIdPatternSource: TEST_ID_PATTERN.source });

    console.log(`   🧪 Test List diagnostics: ${JSON.stringify(snapshot, null, 2)}`);
}

async function openReportByTestId(page: Page, testId: string) {
  const candidate = await findTestIdCell(page, testId);
  if (candidate) {
    await candidate.click({ force: true, timeout: 10000 }).catch(() => {});
    return;
  }

  throw new Error(`Could not find clickable Test ID cell for ${testId}`);
}

async function getTestListRowTextByTestId(page: Page, testId: string) {
  const cell = await findTestIdCell(page, testId);
  if (cell) {
    return cell.evaluate((el, testIdValue) => {
      const testIdPattern = /X\d{5}_\d{6}_\d{3}|[A-Z0-9]+(?:_[A-Z0-9]+){1,}|\d{12,}/gi;
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const getDistinctIds = (value: string) => Array.from(new Set((value.match(testIdPattern) || []).map((item) => item.trim())));

      let current: HTMLElement | null = el as HTMLElement;

      while (current) {
        const text = normalize(current.innerText || current.textContent || '');
        const ids = getDistinctIds(text);
        const onlyCurrentRow = ids.length > 0 && ids.every((id) => id === testIdValue);
        const rowLike = current.querySelector('button') !== null || /abnormal|no image|download|view report/i.test(text);

        if (text.includes(testIdValue) && onlyCurrentRow && rowLike) return text;
        current = current.parentElement;
      }

      current = (el as HTMLElement).parentElement;
      while (current) {
        const text = normalize(current.innerText || current.textContent || '');
        const ids = getDistinctIds(text);
        const onlyCurrentRow = ids.length > 0 && ids.every((id) => id === testIdValue);
        if (text.includes(testIdValue) && onlyCurrentRow) return text;
        current = current.parentElement;
      }

      return normalize(el.textContent || '');
    }, testId).catch(() => '');
  }

  return '';
}

async function getReportRowFromTarget(target: Locator) {
  const row = target.locator(`xpath=./ancestor::*[self::tr or @role="row" or contains(@class, "row") or contains(@class, "Row") or contains(@class, "list-item") or contains(@class, "ListItem") or contains(@class, "report") or contains(@class, "Report")][1]`);
  if ((await row.count().catch(() => 0)) > 0) return row.first();
  return target.locator('xpath=..').first();
}

async function clickIfVisible(locator: Locator) {
  if (await locator.isVisible().catch(() => false)) {
    await locator.click().catch(() => {});
    return true;
  }

  return false;
}

async function waitForLoginReady(page: Page, timeout = 20000, pollMs = 250) {
  const startedAt = Date.now();
  const passInput = page.locator('input[type="password"], input[placeholder*="pass" i], input[name*="pass" i]').first();
  const loginButton = page.getByRole('button', { name: /log in|login|sign in|확인|enter/i }).first();
  const bcmIcon = page.locator("div.app-icon:has-text('BCM')").first();

  while (Date.now() - startedAt < timeout) {
    if (await bcmIcon.isVisible().catch(() => false)) return { passInput, loginButton, bcmIcon };
    if (await passInput.isVisible().catch(() => false)) return { passInput, loginButton, bcmIcon };
    await page.waitForTimeout(pollMs);
  }

  throw new Error('Login screen did not become ready in time');
}

function getBcmCandidates(page: Page) {
  return [
    page.locator("div.app-icon:has-text('BCM')"),
    page.locator("[role='button']:has-text('BCM')"),
    page.locator("button:has-text('BCM')"),
    page.locator("div[role='button']:has-text('BCM')"),
  ];
}

async function clickBcmApp(page: Page) {
  for (const candidates of getBcmCandidates(page)) {
    const candidate = await findFirstVisibleEnabled(candidates, 5);
    if (!candidate) continue;

    await candidate.click({ force: true }).catch(() => {});

    const navigated = await waitForTestListReady(page, 4000, 200);
    if (navigated) return true;
  }

  return false;
}

async function returnToTestList(page: Page) {
  for (const candidates of getTestListNavCandidates(page)) {
    const candidate = await findFirstVisibleEnabled(candidates, 5);
    if (!candidate) continue;

    await candidate.click({ force: true }).catch(() => {});
    if (await waitForTestListReady(page, 5000, 200)) return true;
  }

  const bcmHome = page.locator('header button:has-text("BCM"), header div:has-text("BCM")').first();

  if (await bcmHome.isVisible().catch(() => false)) {
    await bcmHome.click().catch(() => {});
    if (await waitForTestListReady(page, 5000, 200)) return true;
  }

  for (let i = 0; i < 3; i++) {
    await page.goBack().catch(() => {});
    if (await waitForTestListReady(page, 4000, 200)) return true;
  }

  return false;
}

async function goToNextTestListPage(page: Page, currentPage: number) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);

  const moved = await page.evaluate(({ currentPageValue }) => {
    const isVisible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el as HTMLElement);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const controls = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter((el) => isVisible(el))
      .map((el) => ({
        el: el as HTMLElement,
        text: ((el as HTMLElement).innerText || '').trim(),
        rect: el.getBoundingClientRect(),
        disabled: (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
      }));

    const nextPageText = String(currentPageValue + 1);
    const exactNextPage = controls.find((item) => {
      const bottomArea = item.rect.top > window.innerHeight * 0.6;
      return !item.disabled && item.text === nextPageText && bottomArea;
    });

    if (exactNextPage) {
      exactNextPage.el.click();
      return true;
    }

    const currentPageButton = controls.find((item) => item.text === String(currentPageValue));
    if (!currentPageButton) return false;

    const nearbyControls = controls.filter((item) => {
      const sameRow = Math.abs(item.rect.top - currentPageButton.rect.top) < 40;
      const nearX = item.rect.left >= currentPageButton.rect.left - 40 && item.rect.left <= currentPageButton.rect.left + 240;
      const bottomArea = item.rect.top > window.innerHeight * 0.6;
      return sameRow && nearX && bottomArea;
    });

    const nextArrow = nearbyControls.find((item) => !item.disabled && /^(>|›|→|next)$/i.test(item.text));
    if (!nextArrow) return false;

    nextArrow.el.click();
    return true;
  }, { currentPageValue: currentPage });

  if (!moved) return false;

  await waitForTestListReady(page, 5000);
  return true;
}

async function waitForResultView(page: Page, timeout = 10000) {
  const summaryTab = page.locator(SUMMARY_TAB_SELECTOR).filter({ visible: true }).last();
  const flagItems = page.locator(FLAG_ITEM_SELECTOR);

  const summaryVisible = await waitForVisibleLocator(summaryTab, Math.min(timeout, 4000));
  if (summaryVisible) {
    await summaryTab.click().catch(() => {});
  }

  const flagsReady = await waitForLocatorCount(flagItems, 1, timeout);
  if (flagsReady > 0) return true;

  return waitForVisibleLocator(summaryTab, 1500);
}

function loadFlagSpec() {
  const content = fs.readFileSync(SPEC_PATH, 'utf-8');
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true }) as FlagSpec[];
  return {
    specNames: records.map(s => s.UIDisplayName || s.FlagName),
    specMap:   new Map(records.map(s => [s.FlagName, s])),
    uiNameMap: new Map(records.map(s => [s.UIDisplayName, s])),
    uiNameMapNorm: new Map(records.map(s => [norm(s.UIDisplayName), s])),
    specMapNorm:   new Map(records.map(s => [norm(s.FlagName), s])),
  };
}

function loadCache(): Map<string, CacheItem> {
  if (fs.existsSync(CACHE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
      return new Map(Object.entries(data));
    } catch { return new Map(); }
  }
  return new Map();
}

function saveCache(cache: Map<string, CacheItem>) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const obj = Object.fromEntries(cache);
  fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2), 'utf-8');
}

let liveResults: QAResult[] = [];
function logLiveResult(res: QAResult) {
  liveResults.push(res);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LIVE_RESULTS_PATH, JSON.stringify({ results: liveResults, lastUpdate: new Date().toISOString() }, null, 2), 'utf-8');
}

// ─── 핵심 로직 ─────────────────────────────────────────────────────────────
async function loginAndEnterBCM(page: Page) {
  console.log('🔑 [Login] Accessing viewer...');
  try {
    await page.goto(VIEWER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e: any) {
    if (!e.message.includes('ERR_CERT')) throw e;
    const adv = page.getByRole('button', { name: /고급/i });
    if (await adv.isVisible().catch(() => false)) {
      await adv.click();
      await page.locator('a#proceed-link, a:has-text("Proceed"), a:has-text("unsafe")').first().click().catch(() => {});
    }
  }

  const { passInput, loginButton, bcmIcon } = await waitForLoginReady(page);

  if (await bcmIcon.isVisible().catch(() => false)) {
    const entered = await clickBcmApp(page);
    if (!entered) throw new Error('BCM app did not open from app selection screen');
    return;
  }

  if (await passInput.isVisible().catch(() => false)) {
    await passInput.fill(PASSCODE);
    const clickedLogin = await clickIfVisible(loginButton);
    if (!clickedLogin) {
      await passInput.press('Enter').catch(() => {});
    }

    const bcmReady = await waitForVisibleLocator(bcmIcon, 20000);
    if (!bcmReady) throw new Error('BCM icon did not appear after login');
    const entered = await clickBcmApp(page);
    if (!entered) throw new Error('BCM app did not open after login');
  }
}

async function clickInfoAndGetPopup(page: Page, item: any, shotName: string) {
  const icon = item.locator('svg, i, .icon').first();
  if (!(await icon.isVisible())) return null;
  
  await icon.click({ force: true });
  try {
    const dialog = page.locator('div[role="dialog"], div:has-text("Meaning")').last();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
  } catch { return null; }

  const shotPath = `shot_${shotName}_${Date.now()}.png`;
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, shotPath) });

  const popupText = await page.evaluate(() => {
    const divs = Array.from(document.querySelectorAll('div'));
    const candidates = divs.filter(d => {
      const rect = d.getBoundingClientRect();
      return (d.innerText || '').includes('Meaning') && rect.width > 50 && rect.width < 700;
    });
    candidates.sort((a,b) => (a.innerText?.length || 0) - (b.innerText?.length || 0));
    return candidates.length > 0 ? candidates[0].innerText : '';
  });

  const lines = popupText.split('\n').map(l => l.trim()).filter(Boolean);
  const actionIdx = lines.findIndex(l => /action|suggested/i.test(l));
  
  let meaning = '';
  if (actionIdx > 0) meaning = lines.slice(0, actionIdx).join(' ').replace(/^.*?Meaning\s*/i, '').trim();
  else meaning = popupText.replace(/^.*?Meaning\s*/i, '').replace(/✕/g, '').split('\n')[0].trim();
  
  let action = '';
  if (actionIdx >= 0) action = lines.slice(actionIdx + 1).join(' ').replace(/✕/g, '').trim();

  try { await page.mouse.click(10, 10); } catch {}
  return { meaning, action, shotPath };
}

async function main() {
  console.log('====== TextSync QA Runner (Improved Robustness) ======');
  const { specNames, specMap, uiNameMap, uiNameMapNorm, specMapNorm } = loadFlagSpec();
  if (fs.existsSync(LIVE_RESULTS_PATH)) fs.unlinkSync(LIVE_RESULTS_PATH);
  liveResults = [];

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page = await context.newPage();

  try {
    await loginAndEnterBCM(page);
    console.log('📑 [System] Waiting for Test List data...');
    const testListReady = await waitForTestListReady(page, 30000);
    if (!testListReady) throw new Error('Test List did not become ready in time');
    console.log('✅ Test List ready.');

    const processedTestIds = new Set<string>();
    let pageNum = 1;

    while (true) {
      const cache = loadCache();

      const visibleRows = await waitForVisibleTestListRows(page, processedTestIds.size === 0 ? 15000 : 8000);
      console.log(`   📋 Visible Test List rows: ${visibleRows.length}`);
      const nextRow = visibleRows.find((row) => !processedTestIds.has(row.testId));

      if (!nextRow) {
        if (visibleRows.length === 0) {
          await logTestListDiagnostics(page);
          throw new Error('No visible Test List rows were detected after waiting');
        }

        const nextPageNum = pageNum + 1;
        const moved = await goToNextTestListPage(page, pageNum);

        if (moved) {
          console.log(`⏭ [Pagination] Moving to page ${nextPageNum}...`);
          pageNum++;
          continue;
        } else {
          console.log('✅ No unprocessed Test IDs remain on the visible pages.');
          break;
        }
      }

      const slideIdText = nextRow.testId;
      const rowText = nextRow.text;
      const fullRowText = await getTestListRowTextByTestId(page, slideIdText);

      console.log(`\n▶ [Scan] Page ${pageNum} [${slideIdText}]...`);

      if (fullRowText.toLowerCase().includes('no image') || rowText.toLowerCase().includes('no image')) {
        console.log(`   ⏭ [${slideIdText}] skipped (No Image)`);
        processedTestIds.add(slideIdText);
        continue;
      }

      try {
        console.log(`   🖱 Opening detail from Test ID cell [${slideIdText}]...`);
        await openReportByTestId(page, slideIdText);
        
        console.log('   ⏳ Waiting for result view...');
        const entered = await waitForResultView(page, 10000);
        if (!entered) throw new Error('Result view did not become ready in time');
      } catch (e: any) {
        console.log(`   ⚠️ Failed to reach Summary view for ${slideIdText}: ${e.message}`);
        try { 
          await returnToTestList(page);
        } catch {}
        processedTestIds.add(slideIdText);
        continue;
      }

      const slideId = (await page.innerText('body')).match(/Slide\s+#([\w_]+)/)?.[1] ?? slideIdText;
      console.log(`   📌 Final Slide ID: ${slideId}`);

      const flagItems = page.locator(FLAG_ITEM_SELECTOR);
      const itemCount = await flagItems.count();
      
      for (let j = 0; j < itemCount; j++) {
        const item = flagItems.nth(j);
        let flagName = await item.locator('span').first().innerText().catch(() => '');
        flagName = flagName.trim();
        if (!flagName) continue;

        let spec = uiNameMap.get(flagName) || specMap.get(flagName);
        if (!spec) {
          const nFlag = norm(flagName);
          spec = uiNameMapNorm.get(nFlag) ?? specMapNorm.get(nFlag);
        }
        if (!spec) continue;

        const specName = spec.UIDisplayName || spec.FlagName;
        if (cache.has(specName)) {
          const cached = cache.get(specName)!;
          logLiveResult({ timestamp: new Date().toISOString(), testId: slideId, flagName: specName, category: spec.Category, status: 'SKIP_VERIFIED', note: '이미 완료됨', actualName: cached.actualName, screenshotPath: cached.screenshotPath });
          continue;
        }

        console.log(` > Testing: ${flagName}`);
        const popup = await clickInfoAndGetPopup(page, item, flagName.replace(/\W/g,'_'));
        if (!popup) continue;

        const nMeaningSpec = norm(spec.ExpectedMeaning), nMeaningAct = norm(popup.meaning);
        const nActionSpec = norm(spec.ExpectedAction), nActionAct = norm(popup.action);
        const exactM = popup.meaning === spec.ExpectedMeaning, exactA = popup.action === spec.ExpectedAction;
        const okM = nMeaningAct === nMeaningSpec, okA = nActionAct === nActionSpec;

        const nameMatch = flagName === specName;
        const nameMinor = !nameMatch && normNameMinor(flagName) === normNameMinor(specName);

        let status: 'PASS' | 'WARNING' | 'FAIL' = 'FAIL';
        if (okM && okA) {
          if (!nameMatch && !nameMinor) status = 'FAIL';
          else if (exactM && exactA && nameMatch) status = 'PASS';
          else status = 'WARNING';
        }

        logLiveResult({ 
          timestamp: new Date().toISOString(), testId: slideId, flagName: specName, category: spec.Category, status, 
          actualMeaning: popup.meaning, actualAction: popup.action, actualName: nameMatch ? undefined : flagName,
          screenshotPath: popup.shotPath, note: status === 'PASS' ? 'Success' : status 
        });

        cache.set(specName, { flagName: specName, status, firstTestId: slideId, verifiedAt: new Date().toISOString(), actualMeaning: popup.meaning, actualAction: popup.action, actualName: nameMatch ? undefined : flagName, screenshotPath: popup.shotPath });
        saveCache(cache);
      }

      const returnedToList = await returnToTestList(page);
      if (!returnedToList) throw new Error('Failed to return to Test List after scanning report');
      processedTestIds.add(slideIdText);
      
      if (Array.from(cache.values()).filter((c: any) => c.status === 'PASS' || c.status === 'WARNING').length >= specNames.length) {
        console.log('✅ All specs verified!');
        break;
      }
    }
  } catch (err) {
    console.error(`❌ Runner Error: ${err}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
