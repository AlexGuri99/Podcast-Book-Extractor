import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "screenshot-initial.png", fullPage: true });
console.log("1/3 Initial page captured");

await page.click("#extractBtn");
await page.waitForTimeout(4500);
await page.screenshot({ path: "screenshot-processing.png", fullPage: true });
console.log("2/3 Processing state captured");

for (let i = 0; i < 50; i++) {
  const results = await page.$("#results .rounded-xl");
  if (results) break;
  await page.waitForTimeout(500);
}
await page.waitForTimeout(500);
await page.screenshot({ path: "screenshot-results.png", fullPage: true });
console.log("3/3 Results captured");

await browser.close();