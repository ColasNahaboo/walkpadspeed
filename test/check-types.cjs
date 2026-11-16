// Type-check gate for the inline <script> of walkpadspeed.html.
// Extracts the app script block and runs tsc --checkJs on it, so the
// zero-build single-file app gains a machine-checked type surface without
// any build step.
//
// The existing code carries a known error baseline (Web Bluetooth types
// are not in lib.dom, querySelector returns Element, etc.). The gate only
// fails when the error count RISES above the recorded baseline; lower the
// baseline as errors are fixed.
//
// Run: node test/check-types.cjs   (or via test/RUN-ALL-TESTS)

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASELINE = 36; // known pre-existing errors; lower as they are fixed

const html = fs.readFileSync(path.join(ROOT, 'walkpadspeed.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if (!m) { console.error('***ERROR: could not extract the app <script> block'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wps-types-'));
const appjs = path.join(tmp, 'app.js');
fs.writeFileSync(appjs, m[1]);

let output = '';
try {
    execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'),
        ['--allowJs', '--checkJs', '--noEmit', '--target', 'es2022',
         '--lib', 'es2022,dom', '--noImplicitAny', 'false',
         '--strictNullChecks', 'false',
         '--useUnknownInCatchVariables', 'false', appjs],
        { encoding: 'utf8' });
} catch (e) {
    output = (e.stdout || '') + (e.stderr || '');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

const errors = (output.match(/error TS\d+/g) || []).length;
if (errors > BASELINE) {
    console.error(`type check: FAIL — ${errors} errors (baseline ${BASELINE})`);
    console.error(output);
    process.exit(1);
}
console.log(`type check: OK (${errors} errors, baseline ${BASELINE})`);
