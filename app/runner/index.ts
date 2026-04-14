import { chromium, Page } from 'playwright';
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

// ─── 유틸리티 ──────────────────────────────────────────────────────────────
const norm = (s: string) => (s || '').toLowerCase().replace(/['".,?]/g, '').replace(/[–—-]/g, '-').replace(/\s+/g,' ').trim();
const normNameMinor = (s: string) => (s || '').toLowerCase().replace(/['".,?!]/g, '').replace(/\s+/g, ' ').trim();

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
    if (await adv.isVisible({ timeout: 5000 })) { await adv.click(); await page.locator('a#proceed-link').click(); }
  }
  const passInput = page.locator('input[type="password"]');
  const bcmIcon   = page.locator("div.app-icon:has-text('BCM')");
  
  if (await bcmIcon.isVisible({ timeout: 10000 })) { await bcmIcon.click(); }
  else if (await passInput.isVisible({ timeout: 5000 })) {
    await passInput.fill(PASSCODE); await page.getByRole('button', { name: /LOG IN/i }).click();
    await bcmIcon.waitFor({ state: 'visible', timeout: 15000 }); await bcmIcon.click();
  }
}

async function clickInfoAndGetPopup(page: Page, item: any, shotName: string) {
  const icon = item.locator('svg, i, .icon').first();
  if (!(await icon.isVisible())) return null;
  
  await icon.click({ force: true });
  try {
    const dialog = page.locator('div[role="dialog"], div:has-text("Meaning")').last();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(1000);
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

  try { await page.mouse.click(10, 10); await page.waitForTimeout(500); } catch {}
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
    console.log('📑 [System] Waiting for Test List header...');
    await page.locator('text=Test List').first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('✅ Test List detected.');

    let rowIndex = 0;
    let pageNum = 1;

    while (true) {
      const cache = loadCache();
      
      const reportLinks = page.locator('text=View Report').filter({ visible: true });
      let rowCount = await reportLinks.count();
      
      if (rowCount === 0) {
        await page.waitForTimeout(3000);
        rowCount = await reportLinks.count();
      }

      if (rowCount > 0 && rowIndex >= rowCount) {
        const nextPageNum = pageNum + 1;
        const nextBtn = page.locator(`button:has-text("${nextPageNum}")`).filter({ hasText: new RegExp(`^\\s*${nextPageNum}\\s*$`) });
        
        if (await nextBtn.count() > 0 && await nextBtn.first().isVisible() && await nextBtn.first().isEnabled()) {
            console.log(`⏭ [Pagination] Moving to page ${nextPageNum}...`);
            await nextBtn.first().click();
            await page.waitForTimeout(4000);
            rowIndex = 0; pageNum++; continue;
        } else { break; }
      } else if (rowCount === 0) {
        break;
      }

      const currentLink = reportLinks.nth(rowIndex);
      await currentLink.scrollIntoViewIfNeeded();

      const currentRow = currentLink.locator('xpath=./ancestor::*[contains(@role, "row") or contains(@class, "row") or self::tr][1]');
      const rowText = await currentRow.innerText().catch(() => '');
      const slideIdMatch = rowText.match(/X\d{5}_\d{6}_\d{3}|[A-Z0-9_]{8,}/i);
      const slideIdText = slideIdMatch ? slideIdMatch[0] : `ROW_${rowIndex + 1}`;

      console.log(`\n▶ [Scan] Page ${pageNum}, Row #${rowIndex + 1} [${slideIdText}]...`);

      if (rowText.toLowerCase().includes('no image')) {
        console.log(`   ⏭ Row #${rowIndex + 1} skipped (No Image)`);
        rowIndex++; continue;
      }

      try {
        console.log(`   🖱 Clicking "View Report" for [${slideIdText}]...`);
        await currentLink.click({ force: true, timeout: 15000 });
        
        console.log('   ⏳ Entering Summary...');
        const summaryTab = page.locator('div:has-text("Summary"), button:has-text("Summary"), [role="tab"]:has-text("Summary")').filter({ visible: true }).last();
        await summaryTab.waitFor({ state: 'visible', timeout: 10000 });
        await summaryTab.click().catch(() => {});
        await page.waitForTimeout(2000);
      } catch (e: any) {
        console.log(`   ⚠️ Failed to reach Summary view for ${slideIdText}: ${e.message}`);
        try { 
          const bcmHome = page.locator('header div:has-text("BCM"), header button:has-text("BCM")').first();
          if (await bcmHome.isVisible()) await bcmHome.click();
          else await page.goBack(); 
        } catch {}
        rowIndex++; continue;
      }

      const slideId = (await page.innerText('body')).match(/Slide\s+#([\w_]+)/)?.[1] ?? slideIdText;
      console.log(`   📌 Final Slide ID: ${slideId}`);


      const flagItems = page.locator('div:has(> span):has(svg), div:has(> span):has(i)');
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

      const backBtn = page.locator('header button:has-text("BCM"), header div:has-text("BCM")').first();
      if (await backBtn.isVisible()) await backBtn.click(); else await page.goBack();
      await page.waitForTimeout(2000);
      rowIndex++;
      
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
