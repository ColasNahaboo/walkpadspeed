// Routines-persistence tests for walkpadspeed.html
// Invariants: once routines are loaded (file, URL or gist), they persist in
// localStorage and render on every later load — cache-first — until the user
// explicitly clears them. A failed fetch or a failed parse must never wipe
// or hide the stored copy, and an import must render immediately without
// needing a reload (a reload would drop the Bluetooth links).
//
// Run: node test/routines.test.cjs   (or via test/RUN-ALL-TESTS)

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = 'test/fixtures/routines.txt';

const MIME = { '.html': 'text/html', '.txt': 'text/plain', '.js': 'text/javascript' };
const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
});

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  PASS: ${name}`); }
    else { fail++; console.log(`  FAIL: ${name}` + (extra ? ` -> ${extra}` : '')); }
}

const status = (page) => page.locator('#managerStatus').innerText().then((t) => t.trim());
const cache = (page) => page.evaluate(() => localStorage.getItem('wpss_cached_routines'));
const linkCount = (page) => page.locator('#routineList a').count();

(async () => {
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

    try {
        // ---- 1. local file import renders immediately (no reload) --------
        console.log('\n[1] file import renders immediately');
        await page.goto(`${BASE}/walkpadspeed.html`);
        await page.waitForTimeout(300);
        await page.setInputFiles('#fileInput', path.join(ROOT, FIXTURE));
        await page.waitForTimeout(500);
        check('file import renders routines', (await linkCount(page)) >= 2, await status(page));
        check('file import persists to cache', (await cache(page) || '').includes('Warmup'));

        // ---- 2. cold load with cache restores routines -------------------
        console.log('\n[2] cold load restores from cache');
        await page.goto(`${BASE}/walkpadspeed.html`);
        await page.waitForTimeout(400);
        check('cache restores routines', (await linkCount(page)) >= 2, await status(page));

        // ---- 3. a garbage file must NOT wipe the stored routines ---------
        console.log('\n[3] garbage import keeps the stored cache');
        const garbage = path.join(path.dirname(path.join(ROOT, FIXTURE)), 'garbage.txt');
        fs.writeFileSync(garbage, 'garbage file\nfoo bar\nbaz\n');
        await page.setInputFiles('#fileInput', garbage);
        await page.waitForTimeout(500);
        check('garbage shows a parse message', /No valid routines|Parser|bogus/i.test(await status(page)), await status(page));
        check('garbage did not wipe cache', (await cache(page) || '').includes('Warmup'));
        fs.unlinkSync(garbage);

        // ---- 4. https source: cache-first render when fetch fails --------
        console.log('\n[4] failed refetch keeps showing the cached routines');
        await page.goto(`${BASE}/walkpadspeed.html?https=${FIXTURE}`);
        await page.waitForTimeout(600);
        check('https load renders', (await linkCount(page)) >= 2, await status(page));
        await page.route(`**/${FIXTURE}`, (r) => r.abort());
        await page.reload();
        await page.waitForTimeout(800);
        check('offline reload still shows routines', (await linkCount(page)) >= 2, await status(page));
        check('offline reload warns about refresh', /saved copy|offline|could not refresh|stale/i.test(await status(page)), await status(page));
        await page.unroute(`**/${FIXTURE}`);

        // ---- 5. successful refetch updates silently ----------------------
        console.log('\n[5] online reload refetches');
        await page.reload();
        await page.waitForTimeout(800);
        check('online reload shows routines', (await linkCount(page)) >= 2, await status(page));

        // ---- 6. bare URL after an https load still restores --------------
        console.log('\n[6] bare URL restores cached routines');
        await page.goto(`${BASE}/walkpadspeed.html`);
        await page.waitForTimeout(500);
        check('bare URL restores routines', (await linkCount(page)) >= 2, await status(page));

        // ---- 7. explicit clear is the only thing that wipes --------------
        console.log('\n[7] explicit clear wipes cache');
        await page.locator('#routinesClear').click();
        await page.locator('#routinesClearConfirm button:has-text("Delete")').click();
        await page.waitForTimeout(300);
        check('cache cleared', (await cache(page)) === null);
        await page.reload();
        await page.waitForTimeout(400);
        check('cleared stays cleared', (await linkCount(page)) === 0, await status(page));

        // ---- 8. gist param with failing fetch + cache -> cache shown -----
        console.log('\n[8] gist fetch failure falls back to cache');
        await page.goto(`${BASE}/walkpadspeed.html`);
        await page.waitForTimeout(200);
        await page.setInputFiles('#fileInput', path.join(ROOT, FIXTURE));
        await page.waitForTimeout(400);
        await page.route('**://api.github.com/**', (r) => r.abort());
        await page.goto(`${BASE}/walkpadspeed.html?gist=deadbeefdeadbeef`);
        await page.waitForTimeout(1500);
        check('gist failure shows cached routines', (await linkCount(page)) >= 2, await status(page));
        await page.unroute('**://api.github.com/**');

    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail ? 1 : 0);
})();
