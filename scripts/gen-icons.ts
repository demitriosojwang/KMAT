/**
 * Generates /public/icon-192.png and /public/icon-512.png for the PWA
 * manifest. Uses sharp to composite a Kenyan-matatu-blue background
 * with a yellow "M" badge (MatatuLink brand mark).
 */
import sharp from 'sharp'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

const OUT_192 = '/home/z/my-project/public/icon-192.png'
const OUT_512 = '/home/z/my-project/public/icon-512.png'

// SVG brand mark — blue rounded square + yellow "M" cutout
function svg(size: number) {
  return Buffer.from(`
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e3a8a"/>
      <stop offset="100%" stop-color="#1e40af"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.18}" fill="url(#bg)"/>
  <!-- Yellow bus silhouette (simplified) -->
  <g transform="translate(${size * 0.18}, ${size * 0.30}) scale(${size / 512})">
    <rect x="0" y="0" width="340" height="180" rx="32" fill="#facc15"/>
    <rect x="32" y="32" width="80" height="56" rx="8" fill="#1e3a8a"/>
    <rect x="130" y="32" width="80" height="56" rx="8" fill="#1e3a8a"/>
    <rect x="228" y="32" width="80" height="56" rx="8" fill="#1e3a8a"/>
    <circle cx="80" cy="200" r="32" fill="#0f172a"/>
    <circle cx="260" cy="200" r="32" fill="#0f172a"/>
    <circle cx="80" cy="200" r="14" fill="#94a3b8"/>
    <circle cx="260" cy="200" r="14" fill="#94a3b8"/>
  </g>
</svg>
  `)
}

async function main() {
  for (const path of [OUT_192, OUT_512]) {
    mkdirSync(dirname(path), { recursive: true })
  }
  await sharp(svg(512)).resize(512, 512).png().toFile(OUT_512)
  await sharp(svg(192)).resize(192, 192).png().toFile(OUT_192)
  console.log('Icons generated:', OUT_192, OUT_512)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
