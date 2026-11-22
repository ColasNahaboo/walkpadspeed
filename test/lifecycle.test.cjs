// Page-lifecycle tests for walkpadspeed.html.
// A routine must pause itself when the tab becomes hidden: Android throttles
// or freezes the 1 s clock of a background tab while the belt keeps running,
// so the elapsed time, step transitions and session log would silently
// desync. Going visible again must not auto-resume — the user taps RESUME.
//
// Run: node test/lifecycle.test.cjs   (or via test/RUN-ALL-TESTS)

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8904;
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
    else { fail++; console.log(`  FAIL: ${name}${extra ? ' -> ' + extra : ''}`); }
}

// document.visibilityState is read-only; override it and fire the event the
// app listens to (the same thing Chrome does on an app switch / screen lock).
const setHidden = (page, hidden) => page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', {
        value: h ? 'hidden' : 'visible', configurable: true
    });
    document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

(async () => {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

    try {
        await page.goto(`${BASE}/walkpadspeed.html?https=${FIXTURE}`);
        await page.waitForTimeout(500);

        // Test mode + the simulated pad, so a routine can actually run.
        await page.locator('#managerConnBtn').click();
        await page.waitForTimeout(200);
        await page.locator('#testModeCheckbox + .test-toggle-track').click();
        await page.waitForTimeout(300);
        await page.locator('#connectBtn').click();
        await page.waitForTimeout(300);
        await page.locator('#connBackBtn').click();
        await page.waitForTimeout(300);

        console.log('\n[1] hidden tab while idle: nothing changes');
        await setHidden(page, true);
        await page.waitForTimeout(300);
        check('idle stays unpaused', !(await page.evaluate(() => isPaused)));
        await setHidden(page, false);
        await page.waitForTimeout(300);
        check('still idle after coming back', !(await page.evaluate(() => isPaused)));

        console.log('\n[2] hidden tab mid-routine pauses the belt and the clock');
        await page.locator('#routineList a').first().click();
        await page.waitForTimeout(300);
        await page.locator('#routineBtn').click();
        // The start path awaits the belt spin-up before the 1 s clock begins.
        await page.waitForFunction(() => routineInterval !== null, null, { timeout: 20000 });
        await page.waitForTimeout(2500);
        check('routine running', await page.evaluate(() => isRoutineActive && !isPaused));
        const elapsedBefore = await page.evaluate(() => actualElapsedSeconds);
        check('clock advanced', elapsedBefore >= 2, String(elapsedBefore));

        await setHidden(page, true);
        await page.waitForTimeout(500);
        check('paused on hide', await page.evaluate(() => isRoutineActive && isPaused));
        check('button offers RESUME', (await page.locator('#pauseToggleBtn').innerText()).trim() === 'RESUME');
        const frozenAt = await page.evaluate(() => actualElapsedSeconds);
        await page.waitForTimeout(1600);
        check('clock frozen while hidden', (await page.evaluate(() => actualElapsedSeconds)) === frozenAt,
              `${frozenAt} -> ${await page.evaluate(() => actualElapsedSeconds)}`);

        console.log('\n[3] coming back does not auto-resume');
        await setHidden(page, false);
        await page.waitForTimeout(400);
        check('still paused after returning', await page.evaluate(() => isRoutineActive && isPaused));

        console.log('\n[4] RESUME continues the routine');
        await page.locator('#pauseToggleBtn').click();
        await page.waitForFunction(() => routineInterval !== null, null, { timeout: 20000 });
        await page.waitForTimeout(1600);
        check('resumed', await page.evaluate(() => isRoutineActive && !isPaused));
        check('clock running again', (await page.evaluate(() => actualElapsedSeconds)) > frozenAt);

        console.log('\n[5] STOP still works after the hide/show cycle');
        await page.locator('.stop-btn').click();
        await page.waitForTimeout(600);
        check('stopped', !(await page.evaluate(() => isRoutineActive)));
        check('not paused', !(await page.evaluate(() => isPaused)));
    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail ? 1 : 0);
})();
