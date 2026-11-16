const fs = require('node:fs');
const path = require('node:path');

const output = path.join(__dirname, 'pages-dist');
fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'cloud.html'), path.join(output, 'index.html'));
fs.copyFileSync(path.join(__dirname, 'cloud-app.js'), path.join(output, 'cloud-app.js'));
fs.copyFileSync(path.join(__dirname, 'knockout-board.mjs'), path.join(output, 'knockout-board.mjs'));
fs.copyFileSync(path.join(__dirname, 'guide.html'), path.join(output, 'guide.html'));
