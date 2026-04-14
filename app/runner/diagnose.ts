import { chromium, Page } from 'playwright';

const VIEWER_URL = 'https://192.168.128.144';
const PASSCODE   = '000000';

async function loginAndEnterBCM(page: Page) {
  try {
    await page.goto(VIEWER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e: any) {
    if (!e.message.includes('ERR_CERT')) throw e;
    const adv = page.getByRole('button', { name: /고급/i });
    if (await adv.isVisible({ timeout: 5000 })) {
      await adv.click();
      await page.locator('a#proceed-link').click();
    }
  }

  const passInput = page.locator('input[type="password"]');
  const bcmIcon   = page.locator("div.app-icon:has-text('BCM')");

  if (await bcmIcon.isVisible({ timeout: 5000 })) {
    await bcmIcon.click();
  } else if (await passInput.isVisible({ timeout: 5000 })) {
    await passInput.fill(PASSCODE);
    await page.getByRole('button', { name: /LOG IN/i }).click();
    await bcmIcon.waitFor({ state: 'visible', timeout: 15000 });
    await bcmIcon.click();
  }
}

async function diagnose() {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    await loginAndEnterBCM(page);

    // 리포트 목록이 뜰 때까지 대기
    console.log('\n⏳ 리포트 목록 로딩 대기 중...');
    await page.waitForTimeout(4000);

    // ─── 1) 리포트 행(row)로 사용될 후보 요소 파악 ───────────────────────────
    console.log('\n\n====== 📋 리포트 목록 행(Row) 후보 분석 ======');
    const rowSelectors = [
      'tr',
      'div[role="row"]',
      'tr[role="row"]',
      '[class*="row"]',
      '[class*="Row"]',
      '[class*="list-item"]',
      '[class*="ListItem"]',
      '[class*="report"]',
      '[class*="Report"]',
      'tbody tr',
    ];
    for (const sel of rowSelectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) console.log(`  ✅ "${sel}" → ${count}개 발견`);
      } catch {}
    }

    // ─── 2) 실제 리포트 목록 첫 번째 행의 HTML 출력 ─────────────────────────
    console.log('\n\n====== 🔬 페이지 내 "View Report" 텍스트를 포함한 요소의 부모 구조 ======');
    const outerHTMLSnippet = await page.evaluate(() => {
      // "View Report" 링크를 기준으로 가장 가까운 행(tr 또는 div[role=row]) 탐색
      const links = Array.from(document.querySelectorAll('*'))
        .filter(el => el.textContent?.includes('View Report'));
      if (!links.length) return '⚠️ "View Report" 텍스트를 찾을 수 없음';
      const target = links[0];
      const row = target.closest('tr') ?? target.closest('[role="row"]') ?? target.parentElement;
      return row?.outerHTML?.substring(0, 2000) ?? '부모 요소 없음';
    });
    console.log(outerHTMLSnippet);

    // ─── 3) 페이지 전체 body 구조 (태그+클래스만) ───────────────────────────
    console.log('\n\n====== 🗺️ body 태그 구조 스냅샷 (첫 60개) ======');
    const structure = await page.evaluate(() => {
      const result: string[] = [];
      const walk = (el: Element, depth: number) => {
        if (depth > 6 || result.length > 60) return;
        const cls = el.className && typeof el.className === 'string'
          ? el.className.split(' ').slice(0,3).join(' ')
          : '';
        result.push('  '.repeat(depth) + `<${el.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ''}>`);
        Array.from(el.children).forEach(c => walk(c, depth + 1));
      };
      walk(document.body, 0);
      return result.join('\n');
    });
    console.log(structure);

    // ─── 4) "View Report" 버튼이 있는 첫 행을 클릭해서 상세 화면의 구조 확인 ─
    console.log('\n\n====== 🖱️ 첫 번째 리포트 클릭 후 상세 페이지 구조 확인 ======');
    const viewReportLinks = page.locator('text=View Report');
    const linkCount = await viewReportLinks.count();
    console.log(`  "View Report" 링크 수: ${linkCount}`);

    if (linkCount > 0) {
      // 부모 행 클릭 (링크가 아닌 행 자체)
      const firstLink = viewReportLinks.first();
      const parentRow = firstLink.locator('xpath=ancestor::tr[1]');
      const parentRowCount = await parentRow.count();
      if (parentRowCount > 0) {
        console.log('  → tr 부모 발견! tr 클릭 시도...');
        await parentRow.first().click();
      } else {
        console.log('  → tr 부모 없음. 링크 부모 div 클릭 시도...');
        await firstLink.locator('xpath=..').click();
      }

      await page.waitForTimeout(3000);
      console.log(`  현재 URL: ${page.url()}`);
      console.log(`  페이지 타이틀: ${await page.title()}`);

      // 상세화면에서 플래그 아이템 후보 선택자
      console.log('\n  === 상세화면 플래그 아이템 후보 ===');
      const flagSelectors = [
        'div.sc-jxOSlx',   // 기존 선택자
        '[class*="flag"]',
        '[class*="Flag"]',
        '[class*="item"]',
        'div[class*="sc-"]',  // styled-component 범용
        'li',
        '[role="listitem"]',
      ];
      for (const sel of flagSelectors) {
        try {
          const count = await page.locator(sel).count();
          if (count > 0 && count < 200) console.log(`    ✅ "${sel}" → ${count}개`);
        } catch {}
      }

      // ⓘ 아이콘 후보
      console.log('\n  === ⓘ 정보 아이콘 후보 ===');
      const infoSelectors = [
        'div.fTwsx',    // 기존 선택자
        'button[aria-label*="info" i]',
        '[class*="info"]',
        '[class*="Info"]',
        '[title*="info" i]',
        'svg[data-icon*="info"]',
        '[class*="icon"]',
      ];
      for (const sel of infoSelectors) {
        try {
          const count = await page.locator(sel).count();
          if (count > 0 && count < 200) console.log(`    ✅ "${sel}" → ${count}개`);
        } catch {}
      }
    }

    console.log('\n\n====== ✅ 진단 완료. 30초 후 브라우저 종료됩니다. ======');
    await page.waitForTimeout(30000);
  } finally {
    await browser.close();
  }
}

diagnose().catch(console.error);
