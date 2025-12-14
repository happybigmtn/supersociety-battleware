import { chromium } from 'playwright-core';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000/';
const GAME_QUERY = process.env.GAME_QUERY || 'blackjack';
const HEADLESS = process.env.HEADLESS ? process.env.HEADLESS !== '0' : true;
const TIMEOUT_MS = process.env.TIMEOUT_MS ? Number(process.env.TIMEOUT_MS) : 25_000;
const MOVE_KEY = process.env.MOVE_KEY || '';

function shouldLogConsole(message) {
  const text = message.text();
  return (
    text.includes('WAITING FOR CHAIN') ||
    text.includes('NO CHAIN RESPONSE') ||
    text.includes('Failed to decode update') ||
    text.includes('CasinoGameStarted') ||
    text.includes('CasinoGameMoved') ||
    text.includes('CasinoGameCompleted') ||
    text.includes('[NonceManager]') ||
    text.includes('[WebSocket]') ||
    text.includes('[useTerminalGame]') ||
    text.includes('[CasinoChainService]')
  );
}

async function main() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 420, height: 900 },
  });
  const page = await context.newPage();

  const consoleLines = [];
  const pageErrors = [];
  let sawStarted = false;
  let sawMoved = false;
  let sawCompleted = false;
  page.on('console', (msg) => {
    if (!shouldLogConsole(msg)) return;
    const line = `[console.${msg.type()}] ${msg.text()}`;
    consoleLines.push(line);
    if (line.includes('CasinoGameStarted')) sawStarted = true;
    if (line.includes('CasinoGameMoved')) sawMoved = true;
    if (line.includes('CasinoGameCompleted')) sawCompleted = true;
    // Keep stdout small but informative.
    process.stdout.write(`${line}\n`);
  });
  page.on('pageerror', (err) => {
    const line = `[pageerror] ${err?.message || String(err)}`;
    pageErrors.push(line);
    process.stdout.write(`${line}\n`);
  });

  page.on('requestfailed', (req) => {
    const failure = req.failure();
    const line = `[requestfailed] ${req.method()} ${req.url()} ${failure?.errorText || ''}`.trim();
    if (!line.includes('/api/')) return;
    process.stdout.write(`${line}\n`);
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/submit')) return;
    process.stdout.write(`[response] ${res.status()} ${res.request().method()} ${url}\n`);
  });

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /cash game/i }).click();

  await page.waitForTimeout(200);
  await page.keyboard.press('/');
  await page.getByPlaceholder('TYPE COMMAND OR GAME NAME...').fill(GAME_QUERY);
  await page.keyboard.press('Enter');

  // Wait until the UI acknowledges the command.
  await page.waitForFunction(
    () => document.body?.innerText?.includes('STARTING GAME') || document.body?.innerText?.includes('TRANSACTION FAILED'),
    { timeout: 10_000 }
  ).catch(() => {});

  const start = Date.now();
  let waitingSeen = false;
  let finalStatus = 'TIMEOUT';
  while (Date.now() - start < TIMEOUT_MS) {
    const bodyText = await page.locator('body').innerText();

    if (bodyText.includes('WAITING FOR CHAIN')) waitingSeen = true;

    if (bodyText.includes('NO CHAIN RESPONSE')) {
      finalStatus = 'NO_CHAIN_RESPONSE';
      break;
    }
    if (bodyText.includes('TRANSACTION FAILED')) {
      finalStatus = 'TRANSACTION_FAILED';
      break;
    }
    if (bodyText.includes('CHAIN OFFLINE')) {
      finalStatus = 'CHAIN_OFFLINE';
      break;
    }

    // Consider it "responded" once we've entered the WAITING state and then left it.
    if (waitingSeen && !bodyText.includes('WAITING FOR CHAIN')) {
      finalStatus = 'CHAIN_RESPONDED';
      break;
    }

    // Also consider it "responded" once we see a CasinoGameStarted event.
    if (sawStarted) {
      finalStatus = 'CHAIN_RESPONDED';
      break;
    }

    await page.waitForTimeout(250);
  }

  const finalText = await page.locator('body').innerText();
  if (finalStatus === 'TIMEOUT') {
    finalStatus = waitingSeen
      ? 'STILL_WAITING'
      : finalText.includes('STARTING GAME')
        ? 'STILL_STARTING'
        : 'UNKNOWN';
  }

  // Optional: exercise a single move (e.g., MOVE_KEY=h) to ensure we can submit and receive updates.
  if (finalStatus === 'CHAIN_RESPONDED' && MOVE_KEY) {
    process.stdout.write(`\n=== MOVE ===\n`);
    process.stdout.write(`key=${MOVE_KEY}\n`);

    sawMoved = false;
    sawCompleted = false;
    waitingSeen = false;
    // Give the UI a moment to transition into the post-start state (e.g., Blackjack PLAYING),
    // otherwise the key may be ignored by the keyboard handler.
    await page.mouse.click(10, 10).catch(() => {});
    // Ensure command palette/help overlays are closed so game keys route to gameplay.
    await page.keyboard.press('Escape').catch(() => {});
    if (GAME_QUERY.toLowerCase() === 'blackjack') {
      await page
        .waitForFunction(() => document.body?.innerText?.includes('HIT (H)'), { timeout: 10_000 })
        .catch(() => {});
    } else {
      await page.waitForTimeout(750);
    }
    await page.keyboard.press(MOVE_KEY);

    const moveStart = Date.now();
    let moveStatus = 'TIMEOUT';
    while (Date.now() - moveStart < TIMEOUT_MS) {
      const bodyText = await page.locator('body').innerText();
      if (bodyText.includes('WAITING FOR CHAIN')) waitingSeen = true;
      if (bodyText.includes('NO CHAIN RESPONSE')) {
        moveStatus = 'NO_CHAIN_RESPONSE';
        break;
      }
      if (bodyText.includes('TRANSACTION FAILED')) {
        moveStatus = 'TRANSACTION_FAILED';
        break;
      }
      if (bodyText.includes('CHAIN OFFLINE')) {
        moveStatus = 'CHAIN_OFFLINE';
        break;
      }

      if (sawMoved || sawCompleted) {
        moveStatus = 'MOVE_RESPONDED';
        break;
      }
      if (waitingSeen && !bodyText.includes('WAITING FOR CHAIN')) {
        moveStatus = 'MOVE_RESPONDED';
        break;
      }

      await page.waitForTimeout(250);
    }

    process.stdout.write(`moveStatus=${moveStatus}\n`);
    if (moveStatus !== 'MOVE_RESPONDED') {
      finalStatus = `MOVE_${moveStatus}`;
    }
  }

  const screenshotPath = `./playwright-debug-${Date.now()}-${GAME_QUERY}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });

  process.stdout.write(`\n=== RESULT ===\n`);
  process.stdout.write(`url=${BASE_URL}\n`);
  process.stdout.write(`game=${GAME_QUERY}\n`);
  process.stdout.write(`status=${finalStatus}\n`);
  process.stdout.write(`screenshot=${screenshotPath}\n`);
  process.stdout.write(`consoleLines=${consoleLines.length}\n`);
  process.stdout.write(`pageErrors=${pageErrors.length}\n`);

  await browser.close();

  if (finalStatus !== 'CHAIN_RESPONDED') {
    process.exitCode = 2;
  }
}

await main();
