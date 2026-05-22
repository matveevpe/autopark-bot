const fs = require('fs'), path = require('path');
const envFile = path.join(__dirname, '.env');
if (!fs.existsSync(envFile)) return;
fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
  const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
});
