// Draws the N₂ logo and writes the favicon and app icons from one source.
// Run: node scripts/icons.mjs
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

// Background: a subtle azure gradient, darker at the bottom, lighter at the top.
const TOP = '#2fabf5';
const BOTTOM = '#0a74c8';
// A little grain on the background (not the letters): how fine, and how strong.
const GRAIN_FREQ = 4;
const GRAIN_OPACITY = 0.17;

// N is 19.6 × 23. The 2 tucks over the N's lower-right corner, with a cut-out ring in the
// background colour so the two white shapes read as separate.
const N = 'M0 23V0h4.9l10 16V0h4.7v23h-4.9l-10-16v16z';
const TWO_DX = -4.2;
const TWO = `M${21.9 + TWO_DX} 20.4c0-1.8 1.4-3 3.3-3 1.9 0 3.3 1.2 3.3 2.9 0 1.2-.6 2.1-1.9 3.2l-4.8 4.1h7`;
// The 2 is drawn larger than its path, growing from its top-left corner (so the overlap holds).
const TWO_SCALE = 1.2;
const TWO_X = 21.9 + TWO_DX;
const TWO_Y = 17.4;
const W = TWO_X + 8.5 * TWO_SCALE; // glyph width
const H = TWO_Y + 10.1 * TWO_SCALE; // glyph height (the 2 hangs below the N)

/** @param {{ rounded: boolean, scale: number }} o */
function svg({ rounded, scale }) {
  const tx = 32 - (W / 2) * scale;
  const ty = 32 - (H / 2) * scale;
  const stops = `<stop offset="0" stop-color="${BOTTOM}"/><stop offset="1" stop-color="${TOP}"/>`;
  // The ring is drawn inside the scaled glyph group, so its gradient is in the group's units and
  // lines up with the background exactly.
  const inTwo = (y) => ((y - TWO_Y) / TWO_SCALE + TWO_Y).toFixed(2);
  const ringY1 = inTwo((64 - ty) / scale);
  const ringY2 = inTwo(-ty / scale);
  const line = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
  const glyph = (inner) =>
    `<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale})">${inner}</g>`;
  const two = (inner) =>
    `<g transform="translate(${TWO_X} ${TWO_Y}) scale(${TWO_SCALE}) translate(${-TWO_X} ${-TWO_Y})">${inner}</g>`;
  const rx = rounded ? ' rx="14.08"' : '';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
    '<defs>',
    `<linearGradient id="bg" x1="0" y1="64" x2="0" y2="0" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`,
    `<linearGradient id="ring" x1="0" y1="${ringY1}" x2="0" y2="${ringY2}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`,
    // Grain: fine grey noise at low opacity, spread around mid-grey so it lightens and darkens.
    `<filter id="grain" x="0" y="0" width="64" height="64" filterUnits="userSpaceOnUse">`,
    `<feTurbulence type="fractalNoise" baseFrequency="${GRAIN_FREQ}" numOctaves="1" stitchTiles="stitch"/>`,
    '<feColorMatrix type="saturate" values="0"/>',
    '<feComponentTransfer><feFuncR type="linear" slope="2.4" intercept="-0.7"/><feFuncG type="linear" slope="2.4" intercept="-0.7"/><feFuncB type="linear" slope="2.4" intercept="-0.7"/>',
    `<feFuncA type="linear" slope="0" intercept="${GRAIN_OPACITY}"/></feComponentTransfer>`,
    '<feComposite in2="SourceGraphic" operator="in"/>',
    '</filter>',
    // Everywhere but the white letters (the ring around the 2 is background, so it's grainy too).
    '<mask id="bg-only" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">',
    '<rect width="64" height="64" fill="#fff"/>',
    glyph(
      `<path d="${N}" fill="#000"/>` +
        two(
          `<path d="${TWO}" ${line} stroke="#fff" stroke-width="6"/>` +
            `<path d="${TWO}" ${line} stroke="#000" stroke-width="2.5"/>`,
        ),
    ),
    '</mask>',
    '</defs>',
    `<rect width="64" height="64"${rx} fill="url(#bg)"/>`,
    glyph(
      `<path d="${N}" fill="#fff"/>` +
        two(
          `<path d="${TWO}" ${line} stroke="url(#ring)" stroke-width="6"/>` +
            `<path d="${TWO}" ${line} stroke="#fff" stroke-width="2.5"/>`,
        ),
    ),
    `<rect width="64" height="64"${rx} fill="#000" filter="url(#grain)" mask="url(#bg-only)"/>`,
    '</svg>',
  ].join('');
}

// How big the N₂ is drawn (1 = its original size); the maskable icon keeps inside the safe zone.
const GLYPH = 1.2;
const favicon = svg({ rounded: true, scale: GLYPH });
writeFileSync('public/favicon.svg', favicon + '\n');

const png = (s, size, out) =>
  sharp(Buffer.from(s), { density: (72 * size) / 64 })
    .resize(size, size)
    .png()
    .toFile(out);

await png(favicon, 192, 'public/icons/icon-192.png');
await png(favicon, 512, 'public/icons/icon-512.png');
await png(svg({ rounded: false, scale: GLYPH }), 180, 'public/icons/apple-touch-icon.png');
await png(svg({ rounded: false, scale: GLYPH * 0.8 }), 512, 'public/icons/icon-maskable-512.png');
console.log('Wrote favicon.svg and icons/*.png');
