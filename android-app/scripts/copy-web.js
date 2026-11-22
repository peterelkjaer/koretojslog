// Kopierer web-appen (roden af repository'et) ind i www/, som Android-appen pakker med.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const out = path.resolve(__dirname, '..', 'www');
const items = ['index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icons', 'lib'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const it of items) fs.cpSync(path.join(root, it), path.join(out, it), { recursive: true });
console.log('Web-filer kopieret til', out);
