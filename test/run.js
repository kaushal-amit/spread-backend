const { execSync } = require('child_process');
let failed = 0;
for (const s of ['migrations.test.js', 'guards.test.js', 'logic.test.js', 'contract.test.js', 'integration.test.js', 'lifecycle.test.js', 'views.test.js', 'review.test.js', 'sizing.test.js', 'fees.test.js', 'scan.test.js', 'kb.test.js', 'ai-tools.test.js']) {
  try { execSync(`node ${__dirname}/${s}`, { stdio: 'inherit' }); } catch { failed++; }
}
process.exit(failed);
