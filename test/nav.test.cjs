// Navigation / URL-persistence tests for walkpadspeed.html
// Drives the real app in headless Chromium over a local static server,
// covering the manager <-> driver <-> connections view matrix and the
// bookmarkable-URL invariants: the routines source (gist/https) and the
// flag params (t=, dbg=) must survive every view switch so that
// reloading the URL shown in the bar restores the same state.
//
// Run: node test/test-nav.cjs   (or via test/RUN-ALL-TESTS)

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8901;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = 'test/fixtures/routines.txt';

// ---- tiny static server serving the repo root ----------------------------
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

// ---- check helper (tewiba-style) ------------------------------------------
let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  PASS: ${name}`); }
    else { fail++; console.log(`  FAIL: ${name}${extra ? ' -> ' + extra : ''}`); }
}

const status = (page) => page.locator('#managerStatus').innerText().then((t) => t.trim());
const param = (url, key) => new URL(url).searchParams.has(key);

(async () => {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

    try {
        // ---- 1. ?https= bookmark loads routines --------------------------
        console.log('\n[1] ?https= bookmark loads routines');
        await page.goto(`${BASE}/walkpadspeed.html?https=${FIXTURE}`);
        await page.waitForTimeout(500);
        check('https bookmark loads routines', /Loaded routines/.test(await status(page)), await status(page));
        check('routine buttons rendered', (await page.locator('#routineList a').count()) >= 2);

        // ---- 2. routine -> driver keeps the source param -----------------
        console.log('\n[2] driver URL keeps the routines source');
        await page.locator('#routineList a').first().click();
        await page.waitForTimeout(400);
        check('driver URL has r=', param(page.url(), 'r'));
        check('driver URL keeps https=', param(page.url(), 'https'));

        // ---- 3. back to manager keeps the source param -------------------
        console.log('\n[3] back to manager keeps the source param');
        await page.locator('#navBackBtn').click();
        await page.waitForTimeout(300);
        check('manager URL keeps https=', param(page.url(), 'https'));

        // ---- 3b. THE regression: reload that URL with cleared cache ------
        console.log('\n[3b] reload of the shown URL restores routines (cleared cache)');
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.waitForTimeout(600);
        check('reload restores routines from URL', /Loaded routines/.test(await status(page)), await status(page));

        // ---- 4. connections round-trip keeps the source ------------------
        console.log('\n[4] connections round-trip keeps the source param');
        await page.locator('#managerConnBtn').click();
        await page.waitForTimeout(300);
        check('connections view visible', await page.locator('#connectionsView').isVisible());
        check('connections URL keeps https=', param(page.url(), 'https'));
        await page.locator('#connBackBtn').click();
        await page.waitForTimeout(300);
        check('back from connections keeps https=', param(page.url(), 'https'));

        // ---- 5. test-mode flag survives view switches + reload -----------
        console.log('\n[5] test-mode flag survives switches and reload');
        await page.locator('#managerConnBtn').click();
        await page.waitForTimeout(200);
        await page.locator('#testModeCheckbox + .test-toggle-track').click();
        await page.waitForTimeout(300);
        check('t=1 in connections URL', param(page.url(), 't'));
        check('test mode on', await page.evaluate(() => isTestMode));
        await page.locator('#connBackBtn').click();
        await page.waitForTimeout(300);
        check('manager URL keeps t=1', param(page.url(), 't'));
        await page.reload();
        await page.waitForTimeout(600);
        check('test mode survives reload', await page.evaluate(() => isTestMode));
        check('reload still loads routines', /Loaded routines/.test(await status(page)), await status(page));
        await page.locator('#managerConnBtn').click();
        await page.waitForTimeout(200);
        await page.locator('#testModeCheckbox + .test-toggle-track').click();
        await page.waitForTimeout(300);
        check('test mode off', !(await page.evaluate(() => isTestMode)));

        // ---- 6. dbg flag persists across reload --------------------------
        console.log('\n[6] dbg flag persists across reload');
        await page.goto(`${BASE}/walkpadspeed.html?dbg=1`);
        await page.waitForTimeout(400);
        check('dbg flag read', await page.evaluate(() => debugEnabled));
        await page.reload();
        await page.waitForTimeout(400);
        check('dbg survives reload', await page.evaluate(() => debugEnabled));

        // ---- 7. no params + cache restores routines ----------------------
        console.log('\n[7] no params + localStorage cache restores routines');
        await page.goto(`${BASE}/walkpadspeed.html`);
        await page.waitForTimeout(300);
        await page.evaluate(async (f) => {
            const txt = await (await fetch('/' + 'test/fixtures/routines.txt')).text();
            localStorage.setItem('wpss_cached_routines', txt);
        });
        await page.reload();
        await page.waitForTimeout(500);
        check('cache restores routines', (await page.locator('#routineList a').count()) >= 2, await status(page));

        // ---- 7b. https param wins over stale cache -----------------------
        console.log('\n[7b] https param refetches over stale cache');
        await page.goto(`${BASE}/walkpadspeed.html?https=${FIXTURE}`);
        await page.waitForTimeout(600);
        check('https refetches', /Loaded routines/.test(await status(page)), await status(page));

        // ---- 7. browser back/forward across views ------------------------
        console.log('\n[7b] browser back/forward across views');
        await page.goto(`${BASE}/walkpadspeed.html?https=${FIXTURE}`);
        await page.waitForTimeout(500);
        await page.locator('#routineList a').first().click();
        await page.waitForTimeout(400);
        check('driver visible', await page.locator('#driverView').isVisible());
        await page.goBack();
        await page.waitForTimeout(400);
        check('back shows manager', await page.locator('#managerView').isVisible());
        check('back URL keeps https=', param(page.url(), 'https'));
        await page.goForward();
        await page.waitForTimeout(400);
        check('forward shows driver', await page.locator('#driverView').isVisible());

        // ---- 8. ?gist= bookmark shows a result (network) -----------------
        console.log('\n[8] gist bookmark shows a result (network)');
        await page.goto(`${BASE}/walkpadspeed.html?gist=1`);
        await page.waitForTimeout(2500);
        const st = await status(page);
        check('gist shows loaded or error (never stuck)', /Loaded routines|Gist load failed/.test(st), st);

        // ---- 9. a failed connect shows a visible message on Connections --
        // Regression: connect errors went only to the hidden player status,
        // so the Connections view looked silent when a connect failed.
        console.log('\n[9] failed connect shows a message on the Connections view');
        const ctx2 = await browser.newContext();
        await ctx2.addInitScript(() => {
            navigator.bluetooth = {
                requestDevice: async () => { throw new Error('GATT operation already in progress'); },
                getAvailability: async () => true,
            };
        });
        const page2 = await ctx2.newPage();
        await page2.goto(`${BASE}/walkpadspeed.html?view=connections`);
        await page2.waitForTimeout(400);
        await page2.locator('#connectHrmBtn').click();
        await page2.waitForTimeout(500);
        const connStatus = (await page2.locator('#connStatus').innerText()).trim();
        check('HRM connect failure is visible', /fail/i.test(connStatus), connStatus);
        await ctx2.close();

    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail ? 1 : 0);
})();
