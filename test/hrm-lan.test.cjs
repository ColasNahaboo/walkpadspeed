// LAN heart-rate client tests: the app polls an hr-relay /api/v1/hr snapshot
// over HTTP instead of Web Bluetooth. A mock relay is served from the same
// static server; fetch is intercepted in the page so no real LAN is needed.
//
// Run: node test/hrm-lan.test.cjs   (or via test/RUN-ALL-TESTS)

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;

const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
});

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  PASS: ${name}`); }
    else { fail++; console.log(`  FAIL: ${name}${extra ? ' -> ' + extra : ''}`); }
}

// Mock relay state, mutated per scenario from the test.
let mock = { status: 200, body: {}, delayMs: 0 };
let fetchCount = 0;

(async () => {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));

    await page.addInitScript(() => {
        window.__bluetoothTouched = false;
        Object.defineProperty(navigator, 'bluetooth', {
            get: () => ({ requestDevice: () => { window.__bluetoothTouched = true; return Promise.reject(new Error('no picker in test')); } }),
        });
        window.__fetchCount = 0;
        const realFetch = window.fetch.bind(window);
        window.fetch = (url, init) => {
            if (String(url).includes('/api/v1/hr')) {
                window.__fetchCount++;
                window.__lastInit = init;
                return new Promise((resolve, reject) => {
                    setTimeout(() => {
                        if (window.__mockFail) { reject(new TypeError('Failed to fetch')); return; }
                        resolve(new Response(JSON.stringify(window.__mockBody || {}), {
                            status: window.__mockStatus || 200,
                            headers: { 'Content-Type': 'application/json' },
                        }));
                    }, 10);
                });
            }
            return realFetch(url, init);
        };
    });

    const setMock = (body, status = 200, fail = false) => page.evaluate(([b, s, f]) => {
        window.__mockBody = b; window.__mockStatus = s; window.__mockFail = f;
    }, [body, status, fail]);

    const fresh = (seq, bpm = 97) => ({ relayId: 'aaaa1111', version: 'test', sensorConnected: true, bpm, sampleSeq: seq, sampleAgeMs: 120, forwardErrors: 0, lastForwardOkMs: 120 });

    try {
        await page.goto(`${BASE}/walkpadspeed.html?view=connections`);
        await page.waitForTimeout(400);

        console.log('\n[1] Wi-Fi card exists, BLE card untouched');
        check('Wi-Fi card visible', await page.locator('#connectLanHrmBtn').isVisible());
        check('BLE HR button still there', await page.locator('#connectHrmBtn').isVisible());

        console.log('\n[2] connect over Wi-Fi processes fresh samples once per sampleSeq');
        await setMock(fresh(1));
        await page.fill('#lanHrmUrl', `${BASE}/api/v1/hr`);
        await page.fill('#lanHrmToken', 'sekret');
        await page.click('#connectLanHrmBtn');
        await page.waitForTimeout(1500);
        const st = await page.evaluate(() => ({
            hr: currentHeartRate, hist: hrHistory.length, seq: lanSampleSeq,
            transport: hrTransport, init: window.__lastInit,
        }));
        check('BPM from LAN applied', st.hr === 97, JSON.stringify(st));
        check('transport is lan', st.transport === 'lan');
        check('history fed once per poll of a new seq', st.hist >= 1);
        check('token sent as bearer', st.init && st.init.headers.Authorization === 'Bearer sekret');
        check('address space declared', st.init && (st.init.targetAddressSpace === 'loopback' || st.init.targetAddressSpace === 'local'), JSON.stringify(st.init));
        check('no BLE picker used', !(await page.evaluate(() => window.__bluetoothTouched)));

        const histBefore = await page.evaluate(() => hrHistory.length);
        await page.waitForTimeout(1200); // same sampleSeq served again
        const histAfter = await page.evaluate(() => hrHistory.length);
        const seqAfter = await page.evaluate(() => lanSampleSeq);
        check('repeated sampleSeq not re-processed', histAfter === histBefore && seqAfter === 1, `${histBefore}->${histAfter}`);

        console.log('\n[3] new sampleSeq is processed');
        await setMock(fresh(2, 101));
        await page.waitForTimeout(1500);
        check('new seq updates BPM', (await page.evaluate(() => currentHeartRate)) === 101);

        console.log('\n[4] stale data clears HR and stops control');
        await setMock({ ...fresh(3), sensorConnected: false, bpm: null });
        await page.waitForTimeout(1500);
        check('stale clears BPM', (await page.evaluate(() => currentHeartRate)) === 0);
        check('stale flag set', await page.evaluate(() => lanStale));

        console.log('\n[5] recovery with fresh data');
        await setMock(fresh(4, 88));
        await page.waitForTimeout(1500);
        check('recovers', (await page.evaluate(() => currentHeartRate)) === 88);

        console.log('\n[6] relayId change resets the dedupe');
        await setMock({ ...fresh(1, 90), relayId: 'bbbb2222' }); // seq restarts after a relay restart
        await page.waitForTimeout(1500);
        check('restarted relay accepted', (await page.evaluate(() => currentHeartRate)) === 90);

        console.log('\n[7] network errors are soft and recover');
        await setMock({}, 200, true);
        await page.waitForTimeout(1600);
        const fails = await page.evaluate(() => hrmFailCount);
        check('network error does not bump hrmFailCount', fails === 0, String(fails));
        await setMock(fresh(2, 92));
        await page.waitForTimeout(6500); // poll backs off to 5 s after an error
        check('recovers after network error', (await page.evaluate(() => currentHeartRate)) === 92);

        console.log('\n[8] 401 stops polling with a visible message');
        await setMock({}, 401);
        await page.waitForTimeout(1500);
        const conn = await page.locator('#connStatus').innerText();
        check('token rejection visible', /token rejected/.test(conn), conn);
        const c1 = await page.evaluate(() => window.__fetchCount);
        await page.waitForTimeout(2500);
        const c2 = await page.evaluate(() => window.__fetchCount);
        check('polling stopped after 401', c2 === c1, `${c1}->${c2}`);

        console.log('\n[9] disconnect stops polling');
        await setMock(fresh(5, 95));
        await page.click('#connectLanHrmBtn'); // 401 stopped the poll; reconnect
        await page.waitForTimeout(1200);
        check('reconnected', (await page.evaluate(() => hrTransport)) === 'lan');
        await page.click('#connectLanHrmBtn'); // now connected -> disconnect
        const d1 = await page.evaluate(() => window.__fetchCount);
        await page.waitForTimeout(2500);
        const d2 = await page.evaluate(() => window.__fetchCount);
        check('no polls after disconnect', d2 === d1, `${d1}->${d2}`);
        check('transport cleared', (await page.evaluate(() => hrTransport)) === null);

        console.log('\n[10] endpoint persisted, token in sessionStorage only');
        check('endpoint persisted', (await page.evaluate(() => localStorage.getItem('wpss_lan_hr_url') || '')).includes('/api/v1/hr'));
        check('token in sessionStorage', (await page.evaluate(() => sessionStorage.getItem('wpss_lan_hr_token'))) === 'sekret');
        check('token not in localStorage', (await page.evaluate(() => localStorage.getItem('wpss_lan_hr_token'))) === null);

        console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    } finally {
        await browser.close();
        server.close();
    }
    process.exit(fail ? 1 : 0);
})();
