const { execSync } = require('child_process');
try {
  const out = execSync('"C:/Users/Administrator/AppData/Roaming/npm/clasp.cmd" run runSmoke', { cwd: 'C:/Users/Administrator/PI', encoding: 'utf8', timeout: 900000, shell: true });
  console.log(out);
} catch(e) {
  console.log(e.stdout || e.stderr || '');
}
