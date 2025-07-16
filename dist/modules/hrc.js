export class HRCCore {
    name = "HRCCore";
    status = "active";
    async initialize() {
        this.status = "active";
    }
    async validate(text, context, options) {
        return {
            success: true,
            data: {
                isValid: true,
                confidence: 1,
                warnings: [],
                corrections: [],
                metadata: {
                    checks: [],
                    processingTime: 0,
                    model: "hrc"
                }
            }
        };
    }
}
//# sourceMappingURL=hrc.js.map