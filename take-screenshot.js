const puppeteer = require('puppeteer');

async function takeScreenshots() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    // Desktop screenshot
    const page1 = await browser.newPage();
    await page1.setViewport({ width: 1820, height: 1100 });
    await page1.goto('http://127.0.0.1:3847/', { waitUntil: 'networkidle2' });
    await page1.waitForTimeout(2000); // Wait for mock data
    await page1.screenshot({ path: '/opt/cursor/artifacts/screenshots/phone-control-main.png', fullPage: false });
    console.log('Desktop screenshot saved');

    // Mobile screenshot
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 390, height: 844 });
    await page2.goto('http://127.0.0.1:3847/', { waitUntil: 'networkidle2' });
    await page2.waitForTimeout(2000);
    await page2.screenshot({ path: '/opt/cursor/artifacts/screenshots/phone-control-mobile.png', fullPage: false });
    console.log('Mobile screenshot saved');

  } finally {
    await browser.close();
  }
}

takeScreenshots().catch(console.error);
