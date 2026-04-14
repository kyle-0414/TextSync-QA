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
  if (await bcmIcon.isVisible({ timeout: 10000 })) { await bcmIcon.click(); }
  else if (await passInput.isVisible({ timeout: 5000 })) {
    await passInput.fill(PASSCODE);
    await page.getByRole('button', { name: /LOG IN/i }).click();
    await bcmIcon.waitFor({ state: 'visible', timeout: 15000 });
    await bcmIcon.click();
  }
}

async function findPagination() {
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    await loginAndEnterBCM(page);
    await page.locator('text=View Report').first().waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2000);

    console.log('\n====== 페이지네이션 구조 분석 ======');

    // 페이지 하단 전체 HTML 추출
    const paginationHTML = await page.evaluate(() => {
      // 숫자 버튼들이 있는 영역 찾기
      const allElements = Array.from(document.querySelectorAll('*'));
      
      // "1", "2", "3" 같은 페이지 숫자를 포함하는 컨테이너 찾기
      const candidates = allElements.filter(el => {
        const text = el.innerText || '';
        return text.includes('1') && text.includes('2') && text.includes('3') && 
               el.children.length >= 3 && el.children.length <= 20 &&
               (el.tagName === 'DIV' || el.tagName === 'NAV' || el.tagName === 'UL');
      });
      
      if (candidates.length === 0) return '페이지네이션 컨테이너를 찾을 수 없음';
      
      // 가장 작은 컨테이너 선택 (가장 구체적)
      candidates.sort((a, b) => (a.innerHTML?.length || 0) - (b.innerHTML?.length || 0));
      
      return candidates.slice(0, 3).map(c => ({
        tag: c.tagName,
        class: c.className,
        childCount: c.children.length,
        html: c.outerHTML.substring(0, 1000)
      }));
    });
    
    console.log('페이지네이션 후보:', JSON.stringify(paginationHTML, null, 2));

    // 클릭 가능한 모든 요소 중 숫자가 있는 것들 확인
    console.log('\n====== 클릭 가능한 페이지 버튼 목록 ======');
    const clickableItems = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('button, [role="button"], li[class*="page"], span[class*="page"]'));
      return items
        .filter(el => {
          const txt = (el as HTMLElement).innerText?.trim();
          return txt && (txt === '>' || txt === '>>' || txt === '<' || txt === '<<' || /^\d+$/.test(txt));
        })
        .map(el => ({
          tag: el.tagName,
          class: el.className,
          text: (el as HTMLElement).innerText?.trim(),
          disabled: (el as HTMLButtonElement).disabled,
          role: el.getAttribute('role'),
        }));
    });
    console.log(JSON.stringify(clickableItems, null, 2));

    // 스크롤해서 하단으로 이동 후 다시 확인
    console.log('\n====== 스크롤 후 하단 영역 분석 ======');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    
    const bottomHTML = await page.evaluate(() => {
      const body = document.body;
      const allDivs = Array.from(body.querySelectorAll('div'));
      // 화면 하단 영역의 div들 (y좌표가 높은 것들)
      const bottomDivs = allDivs.filter(d => {
        const rect = d.getBoundingClientRect();
        return rect.top > window.innerHeight * 0.7 && rect.width > 100;
      });
      return bottomDivs.slice(0, 5).map(d => ({
        class: d.className,
        text: d.innerText?.substring(0, 100),
        html: d.outerHTML.substring(0, 500)
      }));
    });
    console.log('하단 요소들:', JSON.stringify(bottomHTML, null, 2));

    console.log('\n30초 후 종료됩니다. 브라우저에서 페이지네이션 영역을 확인하세요.');
    await page.waitForTimeout(30000);

  } finally {
    await browser.close();
  }
}

findPagination().catch(console.error);
