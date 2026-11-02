// One source of truth for the logo: the N2 tile. Renders favicon.svg and PNG icons with the
// preinstalled Chromium (Playwright). Run: pnpm --filter @nitrogen/web icons
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_MODULE ?? '@playwright/test');

const ACCENT = '#2b6e55';
export function tile(size, { maskable = false } = {}) {
  const pad = maskable ? size * 0.1 : 0;
  const inner = size - pad * 2;
  const r = maskable ? 0 : size * 0.22;
  const fs = inner * 0.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" rx="${r}" fill="${ACCENT}"/>
<text x="${size / 2 - inner * 0.06}" y="${size / 2 + fs * 0.36}" text-anchor="middle" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" font-weight="700" font-size="${fs}" fill="#fff">N<tspan font-size="${fs * 0.5}" dy="${fs * 0.18}">2</tspan></text>
</svg>`;
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/favicon.svg', tile(64));
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, opts] of [['icon-192.png', 192, {}], ['icon-512.png', 512, {}], ['icon-maskable-512.png', 512, { maskable: true }], ['apple-touch-icon.png', 180, { maskable: true }]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${tile(size, opts)}</body></html>`);
  writeFileSync(`public/icons/${name}`, await page.screenshot({ omitBackground: !opts.maskable, clip: { x: 0, y: 0, width: size, height: size } }));
}
await browser.close();
console.log('Icons written to public/.');
