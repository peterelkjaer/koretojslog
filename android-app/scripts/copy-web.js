// Kopierer web-appen (roden af repository'et) ind i www/, som Android-appen pakker med.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const out = path.resolve(__dirname, '..', 'www');
const items = ['index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icons', 'lib'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const it of items) fs.cpSync(path.join(root, it), path.join(out, it), { recursive: true });
// Capacitors JavaScript-del (giver bl.a. registerPlugin) skal indlæses før app.js i Android-appen
fs.copyFileSync(require.resolve('@capacitor/core/dist/capacitor.js'), path.join(out, 'capacitor.js'));
const idx = path.join(out, 'index.html');
const html = fs.readFileSync(idx, 'utf8');
if (!html.includes('capacitor.js')) fs.writeFileSync(idx, html.replace('<script src="config.js"></script>', '<script src="capacitor.js"></script>\n<script src="config.js"></script>'));
console.log('Web-filer kopieret til', out);
