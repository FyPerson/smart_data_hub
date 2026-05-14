const { chromium } = require('playwright');
const path = require('path');

const url = process.argv[2];
const outPath = process.argv[3] || path.join(process.cwd(), 'screenshot.png');

if (!url) {
  console.error('Usage: node screenshot_url.js <url> [output.png]');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('[+] Opening:', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  console.log('[+] Saving screenshot to:', outPath);
  await page.screenshot({ path: outPath, fullPage: true });

  const title = await page.title();
  const textPath = outPath.replace(/\.png$/, '.txt');
  const bodyText = await page.evaluate(() => document.body.innerText);
  require('fs').writeFileSync(textPath, `TITLE: ${title}\n\n${bodyText}`, 'utf8');
  console.log('[+] Saved text to:', textPath);

  await browser.close();
})().catch((e) => {
  console.error('[x] Error:', e.message);
  process.exit(1);
});
