// Timed-pause (break step) tests for walkpadspeed.html.
// A step at speed 0 is a motor cool-down break: the belt is paused with the
// FTMS Stop/Pause opcode, but the routine clock, timers and progress keep
// running (unlike a manual pause), and the next step's speed is sent after a
// START/RESUME. The step-jump list shows BREAK, and the global progress bar
// paints break segments blue without dragging the speed color normalization.
//
// Run: node test/break.test.cjs   (or via test/RUN-ALL-TESTS)

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8905;
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

(async () => {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

    try {
        await page.goto(`${BASE}/walkpadspeed.html?https=${FIXTURE}`);
        await page.waitForTimeout(500);

        console.log('\n[1] parsing: speed 0 is a break step, not floored to min-speed');
        const parsed = await page.evaluate(() => {
            const steps = buildRoutineSteps('3.0-8-Walk,0-12-CoolDown_break,3.0-8-Walk2');
            return steps.map(s => ({ speed: s.speed, isBreak: !!s.isBreak }));
        });
        check('break step keeps speed 0', parsed[1].speed === 0, JSON.stringify(parsed));
        check('break step flagged isBreak', parsed[1].isBreak === true);
        check('normal steps not flagged', !parsed[0].isBreak && !parsed[2].isBreak);
        const warn = await page.evaluate(() => {
            parseMetadata('#warn-at: 7\n#name: X\n');
            return metaWarnAt;
        });
        check('#warn-at parsed', warn === 7, String(warn));
        const warnDefault = await page.evaluate(() => {
            parseMetadata('#name: X\n');
            return metaWarnAt;
        });
        check('#warn-at defaults to 10', warnDefault === 10, String(warnDefault));

        // Test mode + the simulated pad, so a routine can actually run.
        await page.locator('#managerConnBtn').click();
        await page.waitForTimeout(200);
        await page.locator('#testModeCheckbox + .test-toggle-track').click();
        await page.waitForTimeout(300);
        await page.locator('#connectBtn').click();
        await page.waitForTimeout(300);
        await page.locator('#connBackBtn').click();
        await page.waitForTimeout(300);

        console.log('\n[2] step-jump list shows BREAK');
        const routineLinks = page.locator('#routineList a');
        const n = await routineLinks.count();
        let breakIdx = -1;
        for (let i = 0; i < n; i++) {
            if ((await routineLinks.nth(i).innerText()).includes('Break Test')) breakIdx = i;
        }
        check('Break Test routine rendered', breakIdx >= 0);
        await routineLinks.nth(breakIdx).click();
        await page.waitForTimeout(300);
        const stepMetas = await page.locator('#stepsList .step-meta').allInnerTexts();
        check('list shows BREAK not 0.0 km/h', stepMetas[1].includes('BREAK'), stepMetas[1]);

        console.log('\n[3] running through the break: belt pauses, clock keeps ticking');
        // Record every control-point write the app makes.
        await page.evaluate(() => {
            window.__cpWrites = [];
            const orig = ftmsControlCharacteristic.writeValue;
            ftmsControlCharacteristic.writeValue = async (buf) => {
                const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
                window.__cpWrites.push(Array.from(new Uint8Array(ab)));
                return orig(buf);
            };
        });
        await page.locator('#routineBtn').click();
        await page.waitForFunction(() => routineInterval !== null, null, { timeout: 20000 });

        // Wait until the routine is on the break step (step 2 of 3).
        await page.waitForFunction(() => currentStepIndex === 1, null, { timeout: 30000 });
        const atBreak = await page.evaluate(() => ({
            isBreak: !!currentRoutineSteps[currentStepIndex].isBreak,
            target: currentTargetSpeed,
            paused: isPaused,
            active: isRoutineActive,
            live: currentLiveSpeed
        }));
        check('on break step', atBreak.isBreak && !atBreak.paused && atBreak.active, JSON.stringify(atBreak));
        check('break target speed is 0', atBreak.target === 0);
        check('belt stopped for the break', atBreak.live === 0, String(atBreak.live));
        const writes = await page.evaluate(() => window.__cpWrites);
        check('pause opcode sent for the break',
              writes.some(w => w[0] === 0x08 && w[1] === 0x02), JSON.stringify(writes));

        // The clock must keep running through the break (unlike a manual pause).
        const e1 = await page.evaluate(() => actualElapsedSeconds);
        await page.waitForTimeout(2500);
        const e2 = await page.evaluate(() => actualElapsedSeconds);
        check('clock keeps ticking during break', e2 > e1, `${e1} -> ${e2}`);
        check('still on the break step', await page.evaluate(() => currentStepIndex === 1));
        check('still not paused', await page.evaluate(() => !isPaused));

        console.log('\n[4] after the break: START then the step speed');
        await page.waitForFunction(() => currentStepIndex === 2, null, { timeout: 30000 });
        // The break-end path awaits the spin-up before sending the speed.
        await page.waitForFunction(() => currentLiveSpeed > 0, null, { timeout: 20000 });
        const after = await page.evaluate(() => ({
            writes: window.__cpWrites,
            live: currentLiveSpeed,
            target: currentTargetSpeed
        }));
        const pauseAt = after.writes.findIndex(w => w[0] === 0x08 && w[1] === 0x02);
        const startAfter = after.writes.slice(pauseAt + 1).some(w => w[0] === 0x07);
        const speedAfter = after.writes.slice(pauseAt + 1).some(w => w[0] === 0x02);
        check('START/RESUME sent after the break', startAfter, JSON.stringify(after.writes));
        check('step speed sent after the break', speedAfter);
        check('belt running again', after.live === 3.0, String(after.live));

        await page.locator('.stop-btn').click();
        await page.waitForTimeout(600);
        check('stopped cleanly', !(await page.evaluate(() => isRoutineActive)));

        console.log('\n[5] global progress bar: blue break segment, ramp untouched');
        const bar = await page.evaluate(() => {
            const steps = buildRoutineSteps('3.0-8-Walk,0-12-CoolDown_break,3.0-8-Walk2');
            buildGlobalProgressBar(steps);
            const segs = Array.from(document.querySelectorAll('#globalProgressSegments .global-progress-segment'));
            return segs.map(s => s.style.backgroundColor);
        });
        check('break segment is blue', bar[1] === 'rgb(0, 122, 255)', bar[1]);
        check('speed segments colored by the non-break ramp', bar[0] === bar[2] && bar[0] !== bar[1],
              JSON.stringify(bar));
    } finally {
        await browser.close();
        server.close();
    }

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail ? 1 : 0);
})();
