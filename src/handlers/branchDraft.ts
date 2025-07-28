export async function createDraftBranch(_payload: any): Promise<any> {
  console.log("[BRANCH-DRAFT] Creating draft branch", _payload);
  return { success: true, branch: "draft/placeholder" };
}
