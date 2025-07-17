export class HRCCore {
  status = "active";
  async initialize(): Promise<void> {}
  async validate(text: string, _ctx: any): Promise<{ success: boolean; data: any }> {
    return { success: true, data: null };
  }
}