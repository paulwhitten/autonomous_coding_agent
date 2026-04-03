#!/usr/bin/env tsx
// Test verification tools

import { VerificationRunner } from '../src/tools/verification-tools.js';
import { Logger } from '../src/utils.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('🧪 Testing Verification Tools\n');
  
  const workingDir = path.resolve(__dirname, '..');
  const logger = new Logger(path.resolve(workingDir, 'logs/test-verification.log'));
  
  const runner = new VerificationRunner(workingDir, logger);
  
  console.log('1️⃣ Testing compilation check...');
  const compileResult = await runner.checkCompilation();
  console.log(`   Result: ${compileResult.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Output: ${compileResult.output.substring(0, 100)}\n`);
  
  console.log('2️⃣ Testing test runner...');
  const testResult = await runner.runTests();
  console.log(`   Result: ${testResult.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Output: ${testResult.output.substring(0, 100)}\n`);
  
  console.log('3️⃣ Testing linter...');
  const lintResult = await runner.runLinter();
  console.log(`   Result: ${lintResult.success ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   Output: ${lintResult.output.substring(0, 100)}\n`);
  
  console.log('4️⃣ Testing full verification suite...');
  const fullResult = await runner.runFullVerification();
  console.log(`   Result: ${fullResult.passed ? '✅ ALL PASS' : '❌ SOME FAILED'}`);
  console.log(`\n${fullResult.summary}\n`);
  
  console.log('═══════════════════════════════════════');
  if (fullResult.passed) {
    console.log('✅ All verification tools working correctly!');
  } else {
    console.log('⚠️  Some checks failed (expected if no tests configured)');
  }
  console.log('═══════════════════════════════════════\n');
}

main().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
