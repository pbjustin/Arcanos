/**
 * PR Assistant Templates and Titles
 * Centralized configuration for report generation strings to keep service logic lean.
 */

export const CHECK_TITLES = {
  deadCodeRemoval: '1. **Dead/Bloated Code Removal**',
  simplification: '2. **Simplification & Streamlining**',
  openaiCompatibility: '3. **OpenAI SDK Compatibility**',
  railwayReadiness: '4. **Railway Deployment Readiness**',
  automatedValidation: '5. **Automated Validation**',
  finalDoubleCheck: '6. **Final Double-Check**'
} as const;

export const REPORT_TEMPLATE = {
  header: '# 🤖 ARCANOS PR Analysis Report',
  summarySection: '## {status} Summary',
  detailsSection: '## 📋 Detailed Checks',
  reasoningSection: '## 🔍 Analysis Reasoning',
  recommendationsSection: '## 💡 Recommendations',
  footer: {
    divider: '---',
    completedBy: '*Analysis completed by ARCANOS PR Assistant*',
    sdkVersion: '*OpenAI SDK Version: 5.15.0+ ✅*',
    railwayStatus: '*Railway Deployment: {status} {icon}*',
    productionStatus: '*Status: {statusMessage}*'
  },
  statusMessages: {
    approved: '🎉 **PRODUCTION READY**',
    conditional: '⚠️ **REVIEW RECOMMENDED**',
    rejected: '❌ **FIXES REQUIRED**'
  }
} as const;
