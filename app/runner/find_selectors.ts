import { chromium, Page } from 'playwright';

const VIEWER_URL = 'https://192.168.128.144';
const PASSCODE   = '000000';

async function loginAndEnterBCM(page: Page) {
  try {
    await page.goto(VIEWER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e: any) {
    if (!e.message.includes('ERR_CERT')) throw e;
    const adv = page.getByRole('button', { name: /고급/i });
    if (await adv.isVisible({ timeout: 5000 })) { await adv.click(); await page.locator('a#proceed-link').click(); }
  }
  const passInput = page.locator('input[type="password"]');
  const bcmIcon   = page.locator("div.app-icon:has-text('BCM')");
  if (await bcmIcon.isVisible({ timeout: 5000 })) { await bcmIcon.click(); }
  else if (await passInput.isVisible({ timeout: 5000 })) {
    await passInput.fill(PASSCODE); await page.getByRole('button', { name: /LOG IN/i }).click();
    await bcmIcon.waitFor({ state: 'visible', timeout: 15000 }); await bcmIcon.click();
  }
}

async function findSelectors() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    await loginAndEnterBCM(page);
    await page.waitForTimeout(5000);
    
    console.log('\n--- 리스트 행(Row) 분석 ---');
    const rowInfo = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('*')).filter(el => el.textContent === 'View Report');
      if (links.length === 0) return 'View Report를 찾을 수 없음';
      
      const link = links[0];
      // "View Report"를 감싸고 있는 가장 바깥쪽 리스트 아이템 형태의 div를 찾음
      let current = link.parentElement;
      let path = [];
      for(let i=0; i<10; i++) {
        if(!current) break;
        path.push({ tag: current.tagName, class: current.className, role: current.getAttribute('role') });
        current = current.parentElement;
      }
      return path;
    });
    console.log(JSON.stringify(rowInfo, null, 2));

    console.log('\n--- 상세화면 진입 시도 ---');
    await page.locator('text=View Report').first().click({ force: true });
    await page.waitForTimeout(3000);
    
    console.log('현재 URL:', page.url());
    
    console.log('\n--- 상세화면 플래그 아이템 분석 ---');
    const flagInfo = await page.evaluate(() => {
        // "Meaning" 이라는 텍스트를 포함한 팝업을 띄우기 전, 대기 화면에서 플래그 리스트 분석
        const items = Array.from(document.querySelectorAll('div')).filter(d => d.innerText && d.innerText.length < 50 && d.querySelector('span'));
        return items.slice(0, 5).map(i => ({ tag: i.tagName, class: i.className, text: i.innerText.substring(0, 20) }));
    });
    console.log(JSON.stringify(flagInfo, null, 2));

  } finally {
    await browser.close();
  }
}

findSelectors().catch(console.error);
