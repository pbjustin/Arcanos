import type { HRCValidation } from '../types';
export declare class HRCCore {
    name: string;
    status: "active" | "inactive" | "error";
    initialize(): Promise<void>;
    validate(text: string, context: any, options: any): Promise<{
        success: boolean;
        data: HRCValidation;
    }>;
}
//# sourceMappingURL=hrc.d.ts.map