// Builds the signed over-the-air content update for the Android app: dist/ota.json (+ .sig).
// Usage: node scripts/ota.mjs <minApp>   e.g. 1.1.3 = needs at least that APK; set it to the new
// version when a release also changes the native app, so older apps fall back to the APK dialog.
// First run creates the signing key at ~/.android/dashwell-ota.pem and prints the public key
// to paste into MainActivity.OTA_KEY. Losing that key means OTA stops until an APK ships a new one.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILES = ['feed.js', 'content.js', 'content.css', 'cosmetic.css']; // keep in sync with MainActivity.OTA_FILES
const keyPath = join(homedir(), '.android', 'dashwell-ota.pem');
if (!existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
}
const key = createPrivateKey(readFileSync(keyPath));
const pub = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');

const minApp = process.argv[2];
if (!minApp) {
  console.log('OTA_KEY =', pub);
  process.exit(minApp === undefined ? 0 : 1);
}
const { version } = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const files = Object.fromEntries(FILES.map((f) => [f, readFileSync(`extension/${f}`, 'utf8')]));
const body = Buffer.from(JSON.stringify({ version, minApp, files }));
mkdirSync('dist', { recursive: true });
writeFileSync('dist/ota.json', body);
writeFileSync('dist/ota.json.sig', sign('sha256', body, { key, dsaEncoding: 'der' }));
console.log(`dist/ota.json for ${version} (needs app >= ${minApp})`);
