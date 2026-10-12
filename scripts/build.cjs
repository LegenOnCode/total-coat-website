const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
fs.mkdirSync(output, { recursive: true });
for (const file of ['index.html', 'styles.css', 'app.js']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
console.log('Página preparada en public/.');
