const { execFileSync } = require('child_process');
try {
  const out = execFileSync('node', ['C:/Users/ADMINI~1/AppData/Local/Temp/opencode/run_api4.js'], { cwd: 'C:/Users/Administrator/PI', encoding: 'utf8', timeout: 900000 });
  console.log(out);
} catch(e) {
  console.log(e.stdout || e.stderr || e.message);
}
