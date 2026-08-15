const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const RES = 'android/app/src/main/res';
const MARK = 'www/assets/img/fuse-symbol.png';
const LOCKUP = 'www/assets/img/fuse-logo.png';
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

const SPLASH_PORT = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
const SPLASH_LAND = { mdpi: [480, 320], hdpi: [800, 480], xhdpi: [1280, 720], xxhdpi: [1600, 960], xxxhdpi: [1920, 1280] };

async function canvas(w, h, bg, overlay, overlayW) {
  const fitted = await sharp(overlay)
    .resize({ width: overlayW, fit: 'inside', kernel: sharp.kernel.lanczos3, background: CLEAR })
    .toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: bg } })
    .composite([{ input: fitted, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function circleMasked(size, buf) {
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
  );
  return sharp(buf)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function write(dir, name, buf) {
  const d = path.join(RES, dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), buf);
  return `${dir}/${name} (${(buf.length / 1024).toFixed(1)} KB)`;
}

(async () => {
  const out = [];

  for (const [dpi, size] of Object.entries(FOREGROUND)) {
    const buf = await canvas(size, size, CLEAR, MARK, Math.round(size * 0.52));
    out.push(write(`mipmap-${dpi}`, 'ic_launcher_foreground.png', buf));
  }

  for (const [dpi, size] of Object.entries(LEGACY)) {
    const sq = await canvas(size, size, WHITE, MARK, Math.round(size * 0.62));
    out.push(write(`mipmap-${dpi}`, 'ic_launcher.png', sq));
    out.push(write(`mipmap-${dpi}`, 'ic_launcher_round.png', await circleMasked(size, sq)));
  }

  for (const [dpi, [w, h]] of Object.entries(SPLASH_PORT)) {
    out.push(write(`drawable-port-${dpi}`, 'splash.png', await canvas(w, h, WHITE, LOCKUP, Math.round(w * 0.46))));
  }
  for (const [dpi, [w, h]] of Object.entries(SPLASH_LAND)) {
    out.push(write(`drawable-land-${dpi}`, 'splash.png', await canvas(w, h, WHITE, LOCKUP, Math.round(w * 0.24))));
  }
  out.push(write('drawable', 'splash.png', await canvas(480, 320, WHITE, LOCKUP, Math.round(480 * 0.24))));

  console.log(out.join('\n'));
  console.log(`\n${out.length} files written`);
})().catch((e) => { console.error(e); process.exit(1); });
