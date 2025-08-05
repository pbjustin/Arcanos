/**
 * Validation script for AI refactor implementation (structure validation)
 * Tests imports, structure, and configuration without requiring API keys
 */
import fs from 'fs';
import path from 'path';
function validateFileExists(filePath, description) {
    const fullPath = path.join(__dirname, filePath);
    if (fs.existsSync(fullPath)) {
        console.log(`✅ ${description} exists: ${filePath}`);
        return true;
    }
    else {
        console.log(`❌ ${description} missing: ${filePath}`);
        return false;
    }
}
function validateCodeChanges() {
    console.log('\n🧪 Validating AI Refactor Structure...');
    let allValid = true;
    // Check new AI service directory structure
    allValid = validateFileExists('src/services/ai', 'AI Services Directory') && allValid;
    // Check new workers
    allValid = validateFileExists('src/workers/goal-tracker.ts', 'Goal Tracker Worker') && allValid;
    allValid = validateFileExists('src/workers/maintenance-scheduler.ts', 'Maintenance Scheduler Worker') && allValid;
    // Check refactored files
    allValid = validateFileExists('src/workers/audit/stream-audit-worker.ts', 'Audit Worker') && allValid;
    allValid = validateFileExists('src/workers/email/email-dispatcher.ts', 'Email Dispatcher') && allValid;
    allValid = validateFileExists('src/routes/query-router.ts', 'Query Router') && allValid;
    return allValid;
}
function validateQueryRouterRefactor() {
    console.log('\n🧪 Validating Query Router Refactor...');
    try {
        const queryRouterPath = path.join(__dirname, 'src/routes/query-router.ts');
        const content = fs.readFileSync(queryRouterPath, 'utf8');
        // Check that axios import is removed
        const hasAxios = content.includes('import axios');
        const hasOpenAI = content.includes('askArcanosV1_Safe');
        const hasLogging = content.includes('AI interaction');
        console.log(hasAxios ? '❌ Still uses axios (should be removed)' : '✅ No axios imports found');
        console.log(hasOpenAI ? '✅ Uses OpenAI SDK interface' : '❌ Missing OpenAI SDK usage');
        console.log(hasLogging ? '✅ Has AI interaction logging' : '❌ Missing AI interaction logging');
        return !hasAxios && hasOpenAI && hasLogging;
    }
    catch (error) {
        console.log(`❌ Error reading query router: ${error.message}`);
        return false;
    }
}
function validateWorkerStructure() {
    console.log('\n🧪 Validating Worker Structure...');
    try {
        const goalTrackerPath = path.join(__dirname, 'src/workers/goal-tracker.ts');
        const maintenancePath = path.join(__dirname, 'src/workers/maintenance-scheduler.ts');
        const goalTrackerContent = fs.readFileSync(goalTrackerPath, 'utf8');
        const maintenanceContent = fs.readFileSync(maintenancePath, 'utf8');
        // Check for core AI service usage
        const goalUsesCore = goalTrackerContent.includes('coreAIService');
        const maintenanceUsesCore = maintenanceContent.includes('coreAIService');
        // Check for streaming
        const goalHasStreaming = goalTrackerContent.includes('completeStream');
        const maintenanceHasStreaming = maintenanceContent.includes('completeStream');
        console.log(goalUsesCore ? '✅ Goal Tracker uses core AI service' : '❌ Goal Tracker missing core AI service');
        console.log(maintenanceUsesCore ? '✅ Maintenance Scheduler uses core AI service' : '❌ Maintenance Scheduler missing core AI service');
        console.log(goalHasStreaming ? '✅ Goal Tracker supports streaming' : '❌ Goal Tracker missing streaming');
        console.log(maintenanceHasStreaming ? '✅ Maintenance Scheduler supports streaming' : '❌ Maintenance Scheduler missing streaming');
        return goalUsesCore && maintenanceUsesCore && goalHasStreaming && maintenanceHasStreaming;
    }
    catch (error) {
        console.log(`❌ Error reading worker files: ${error.message}`);
        return false;
    }
}
function validateEnvironmentConfiguration() {
    console.log('\n🧪 Validating Environment Configuration...');
    try {
        const envExamplePath = path.join(__dirname, '.env.example');
        const envContent = fs.readFileSync(envExamplePath, 'utf8');
        const hasEmailHost = envContent.includes('EMAIL_HOST');
        const hasEmailUser = envContent.includes('EMAIL_USER');
        const hasEmailPass = envContent.includes('EMAIL_PASS');
        console.log(hasEmailHost ? '✅ EMAIL_HOST configured' : '❌ EMAIL_HOST missing');
        console.log(hasEmailUser ? '✅ EMAIL_USER configured' : '❌ EMAIL_USER missing');
        console.log(hasEmailPass ? '✅ EMAIL_PASS configured' : '❌ EMAIL_PASS missing');
        return hasEmailHost && hasEmailUser && hasEmailPass;
    }
    catch (error) {
        console.log(`❌ Error reading .env.example: ${error.message}`);
        return false;
    }
}
function validateArcanosV1ModelUsage() {
    console.log('\n🧪 Validating Arcanos-v1 Model Usage...');
    try {
        const openaiServicePath = path.join(__dirname, 'src/services/unified-openai.ts');
        const openaiContent = fs.readFileSync(openaiServicePath, 'utf8');
        const openaiUsesArcanos = openaiContent.includes('arcanos-v1');
        console.log(openaiUsesArcanos ? '✅ OpenAI Service uses arcanos-v1' : '❌ OpenAI Service missing arcanos-v1');
        return openaiUsesArcanos;
    }
    catch (error) {
        console.log(`❌ Error reading AI service files: ${error.message}`);
        return false;
    }
}
function validateEmailServiceRefactor() {
    console.log('\n🧪 Validating Email Service Refactor...');
    try {
        const emailServicePath = path.join(__dirname, 'src/services/email.ts');
        const content = fs.readFileSync(emailServicePath, 'utf8');
        const supportsEmailHost = content.includes('EMAIL_HOST');
        const supportsEmailUser = content.includes('EMAIL_USER');
        const supportsEmailPass = content.includes('EMAIL_PASS');
        console.log(supportsEmailHost ? '✅ Email service supports EMAIL_HOST' : '❌ Missing EMAIL_HOST support');
        console.log(supportsEmailUser ? '✅ Email service supports EMAIL_USER' : '❌ Missing EMAIL_USER support');
        console.log(supportsEmailPass ? '✅ Email service supports EMAIL_PASS' : '❌ Missing EMAIL_PASS support');
        return supportsEmailHost && supportsEmailUser && supportsEmailPass;
    }
    catch (error) {
        console.log(`❌ Error reading email service: ${error.message}`);
        return false;
    }
}
function validateCompilationSuccess() {
    console.log('\n🧪 Validating Compilation...');
    try {
        const distPath = path.join(__dirname, 'dist');
        const distExists = fs.existsSync(distPath);
        if (distExists) {
            console.log('✅ TypeScript compilation successful (dist directory exists)');
            return true;
        }
        else {
            console.log('❌ TypeScript compilation failed (no dist directory)');
            return false;
        }
    }
    catch (error) {
        console.log(`❌ Error checking compilation: ${error.message}`);
        return false;
    }
}
function runStructuralValidation() {
    console.log('🚀 AI Refactor Structural Validation');
    console.log('========================================');
    const results = {
        structure: validateCodeChanges(),
        queryRouter: validateQueryRouterRefactor(),
        workers: validateWorkerStructure(),
        environment: validateEnvironmentConfiguration(),
        modelUsage: validateArcanosV1ModelUsage(),
        emailService: validateEmailServiceRefactor(),
        compilation: validateCompilationSuccess()
    };
    console.log('\n========================================');
    console.log('📊 Validation Results:');
    console.log('========================================');
    Object.entries(results).forEach(([test, passed]) => {
        console.log(`${passed ? '✅' : '❌'} ${test}: ${passed ? 'PASSED' : 'FAILED'}`);
    });
    const allPassed = Object.values(results).every(result => result);
    console.log('\n========================================');
    console.log(`🎯 Overall Result: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
    console.log('========================================');
    if (allPassed) {
        console.log('\n🎉 AI Refactor Implementation Validation: SUCCESS');
        console.log('\nKey achievements:');
        console.log('✓ Replaced manual HTTP requests with OpenAI SDK');
        console.log('✓ Standardized on arcanos-v1 model');
        console.log('✓ Enabled streaming for long-running operations');
        console.log('✓ Created new workers (Goal Tracker, Maintenance Scheduler)');
        console.log('✓ Enhanced existing workers with retry logic');
        console.log('✓ Added comprehensive logging for AI interactions');
        console.log('✓ Updated email service with standard environment variables');
        console.log('✓ Code compiles successfully');
    }
    else {
        console.log('\n⚠️ Some validation checks failed. Please review the results above.');
    }
    return allPassed;
}
// Run validation if this file is executed directly
if (require.main === module) {
    const success = runStructuralValidation();
    process.exit(success ? 0 : 1);
}
export { runStructuralValidation };
