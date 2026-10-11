#!/usr/bin/env node
/**
 * Captures README screenshots (and an optional demo GIF) with headless Chromium.
 *
 *   pnpm build && pnpm screenshots
 *
 * Reads screenshots.json:
 *   {
 *     "shots": [
 *       { "name": "hero", "path": "/", "theme": "light", "viewport": "desktop",
 *         "actions": [{ "click": "text=Run" }, { "waitFor": "#result" }, { "wait": 400 }] }
 *     ],
 *     "gif": { "path": "/", "theme": "dark", "actions": [ ... ] }
 *   }
 * Actions: click, fill ([selector, text]), press, hover, waitFor (selector), wait (ms), scroll (px).
 * Output goes to docs/<name>.png and docs/demo.gif. The GIF needs ffmpeg on PATH.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const config = JSON.parse(readFileSync("screenshots.json", "utf8"));
const port = config.port ?? 3210;
const base = `http://localhost:${port}`;
const out = "docs";
mkdirSync(out, { recursive: true });

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};

const server = spawn("pnpm", ["exec", "next", "start", "-p", String(port)], {
  stdio: "ignore",
  detached: true,
});
const stop = () => {
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {}
};
process.on("exit", stop);

for (let i = 0; ; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    if (i > 80) throw new Error("Server did not start. Run `pnpm build` first.");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function perform(page, actions = []) {
  for (const action of actions) {
    if (action.click) await page.click(action.click);
    else if (action.fill) await page.fill(action.fill[0], action.fill[1]);
    else if (action.press) await page.keyboard.press(action.press);
    else if (action.hover) await page.hover(action.hover);
    else if (action.waitFor) await page.waitForSelector(action.waitFor, { timeout: 20_000 });
    else if (action.wait) await page.waitForTimeout(action.wait);
    else if (action.scroll) await page.mouse.wheel(0, action.scroll);
  }
}

async function open(browser, spec, extra = {}) {
  const viewport = VIEWPORTS[spec.viewport ?? "desktop"];
  const theme = spec.theme ?? "light";
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: theme,
    reducedMotion: spec.motion ? "no-preference" : "reduce",
    ...extra,
  });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem("theme", t);
    } catch {}
  }, theme);
  const page = await context.newPage();
  await page.goto(base + (spec.path ?? "/"), { waitUntil: "networkidle" });
  return { context, page, viewport };
}

const browser = await chromium.launch();
try {
  for (const shot of config.shots ?? []) {
    const { context, page } = await open(browser, shot);
    await perform(page, shot.actions);
    const file = path.join(out, `${shot.name}.png`);
    await page.screenshot({ path: file, fullPage: Boolean(shot.fullPage) });
    await context.close();
    console.log(`wrote ${file}`);
  }

  if (config.gif) {
    const videoDir = path.join(out, ".video");
    const size = VIEWPORTS[config.gif.viewport ?? "desktop"];
    const { context, page } = await open(
      browser,
      { ...config.gif, motion: true },
      { deviceScaleFactor: 1, recordVideo: { dir: videoDir, size } },
    );
    await perform(page, config.gif.actions);
    await page.waitForTimeout(600);
    const video = await page.video().path();
    await context.close();
    const gif = path.join(out, "demo.gif");
    try {
      execFileSync(
        "ffmpeg",
        ["-y", "-i", video, "-vf", "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", gif],
        { stdio: "ignore" },
      );
      console.log(`wrote ${gif}`);
    } catch {
      console.warn("ffmpeg not available: skipped docs/demo.gif (add it to the manual checklist).");
    }
    rmSync(videoDir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
  stop();
}
