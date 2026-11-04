const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dirs = ['', 'dev', 'legacy', 'tests'];
const files = [];

dirs.forEach(dir => {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return;
  fs.readdirSync(full)
    .filter(f => f.endsWith('.js') || f.endsWith('.gs'))
    .forEach(f => files.push(path.join(full, f)));
});

let failed = 0;
files.forEach(file => {
  try {
    if (file.endsWith('.gs')) {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    } else {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  } catch (err) {
    failed++;
    console.error('SYNTAX FAIL: ' + path.relative(root, file));
    console.error(String(err.stderr || err.message));
  }
});

if (failed) process.exit(1);
console.log('syntax check: PASS (' + files.length + ' files)');

const rootJs = fs.readdirSync(root).filter(f => f.endsWith('.js') || f.endsWith('.gs'));
const fnMap = {};
let duplicates = 0;
rootJs.forEach(file => {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (!fnMap[name]) fnMap[name] = [];
    fnMap[name].push(file);
  }
});
Object.keys(fnMap).forEach(name => {
  const files = Array.from(new Set(fnMap[name]));
  if (files.length > 1) {
    duplicates++;
    console.error('DUPLICATE FUNCTION: ' + name + ' -> ' + files.join(', '));
  }
});
if (duplicates) process.exit(1);
console.log('duplicate function check: PASS (' + Object.keys(fnMap).length + ' root functions)');