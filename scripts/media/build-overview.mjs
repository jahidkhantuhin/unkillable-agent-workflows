/* global console */
import { Buffer } from 'node:buffer';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const appRequire = createRequire(resolve('apps/web/package.json'));
const sharp = createRequire(appRequire.resolve('next/package.json'))('sharp');
const { GIFEncoder, quantize, applyPalette } = createRequire(
  resolve('.local/media-tools/package.json'),
)('gifenc');
const input = resolve('screenshots/pages'),
  manifest = JSON.parse(
    await readFile(resolve(input, 'manifest.json'), 'utf8'),
  );
const width = 1280,
  viewHeight = 889,
  header = 64,
  height = viewHeight + header;
const gif = GIFEncoder(),
  frameLog = [];
const xml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
for (let chapter = 0; chapter < manifest.entries.length; chapter++) {
  const entry = manifest.entries[chapter],
    file = resolve(input, entry.file),
    meta = await sharp(file).metadata();
  if (meta.width !== entry.width || meta.height < entry.height)
    throw new Error(`Incomplete full-page capture: ${entry.file}`);
  const maxTop = Math.max(0, meta.height - 1000),
    positions = [
      ...new Set(
        (
          entry.focus ??
          (maxTop > 1800 ? [0, 0.5, 1] : maxTop > 150 ? [0, 1] : [0])
        ).map((f) => Math.round(f * maxTop)),
      ),
    ];
  for (let position = 0; position < positions.length; position++) {
    const top = positions[position],
      cropHeight = Math.min(1000, meta.height);
    const viewport = await sharp(file)
      .extract({ left: 0, top, width: meta.width, height: cropHeight })
      .resize(width, viewHeight, { fit: 'contain', background: '#0c100f' })
      .png()
      .toBuffer();
    const title = Buffer.from(
      `<svg width="${width}" height="${header}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0c100f"/><text x="24" y="20" fill="#34d399" font-family="Arial" font-size="11" font-weight="bold" letter-spacing="2">UNKILLABLE · PRODUCT OVERVIEW</text><text x="24" y="47" fill="#edf3ee" font-family="Arial" font-size="20" font-weight="bold">${xml(entry.title)}</text><text x="1256" y="39" text-anchor="end" fill="#8f9d94" font-family="Arial" font-size="14">${chapter + 1} / ${manifest.entries.length}</text></svg>`,
    );
    const progress = Buffer.from(
      `<svg width="${width}" height="3" xmlns="http://www.w3.org/2000/svg"><rect width="${Math.round((width * (chapter + (position + 1) / positions.length)) / manifest.entries.length)}" height="3" fill="#34d399"/></svg>`,
    );
    const rgba = await sharp({
      create: { width, height, channels: 4, background: '#0c100f' },
    })
      .composite([
        { input: title, top: 0, left: 0 },
        { input: viewport, top: header, left: 0 },
        { input: progress, top: height - 3, left: 0 },
      ])
      .ensureAlpha()
      .raw()
      .toBuffer();
    const palette = quantize(rgba, 256),
      index = applyPalette(rgba, palette),
      delay = positions.length === 1 ? 1800 : position === 0 ? 1600 : 1200;
    gif.writeFrame(index, width, height, {
      palette,
      delay,
      repeat: 0,
      dispose: 1,
    });
    frameLog.push({ chapter: chapter + 1, file: entry.file, top, delay });
  }
}
gif.finish();
const output = resolve('screenshots/unkillable-overview.gif');
await writeFile(output, gif.bytes());
const check = await sharp(output, { animated: true }).metadata();
if (
  check.pages !== frameLog.length ||
  check.width !== width ||
  check.pageHeight !== height
)
  throw new Error('GIF validation failed');
await mkdir(resolve('.local/media-tools/previews'), { recursive: true });
for (const index of [0, Math.floor(frameLog.length / 2), frameLog.length - 1])
  await sharp(output, { page: index, pages: 1 })
    .png()
    .toFile(resolve(`.local/media-tools/previews/frame-${index}.png`));
await writeFile(
  resolve(input, 'overview.json'),
  JSON.stringify(
    {
      file: 'screenshots/unkillable-overview.gif',
      width,
      height,
      frames: frameLog.length,
      durationMs: frameLog.reduce((n, f) => n + f.delay, 0),
      bytes: gif.bytes().length,
      pages: manifest.entries.length,
      scenes: frameLog,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    output,
    pages: manifest.entries.length,
    frames: frameLog.length,
    durationMs: frameLog.reduce((n, f) => n + f.delay, 0),
    bytes: gif.bytes().length,
  }),
);
