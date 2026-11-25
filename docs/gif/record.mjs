// Records a scene (docs/gif/<name>.html, which defines render(t)) frame by frame into media/readme/<name>.gif.
// Usage: node docs/gif/record.mjs <name> <seconds> [fps]
// Needs: playwright-core (any copy, path in PLAYWRIGHT_CORE or the npx cache), Google Chrome, ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , name, secs, fpsArg] = process.argv;
const fps = Number(fpsArg ?? 15);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const pwPath = process.env.PLAYWRIGHT_CORE ?? join(process.env.HOME, '.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pwPath);

const frames = join(here, 'build', `${name}-frames`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
await page.goto('file://' + join(here, `${name}.html`), { waitUntil: 'load' });
await page.waitForTimeout(500);
const total = Math.round(Number(secs) * fps);
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.render(t), i / fps);
  await page.screenshot({ path: join(frames, `${String(i).padStart(5, '0')}.png`) });
}
await browser.close();

const outDir = join(root, 'media', 'readme');
mkdirSync(outDir, { recursive: true });
const gif = join(outDir, `${name}.gif`);
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, '%05d.png'),
  '-vf', 'scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  gif,
]);
rmSync(frames, { recursive: true, force: true });
console.log(gif, (statSync(gif).size / 1024).toFixed(0) + ' KB', existsSync(gif) ? '' : 'missing');
