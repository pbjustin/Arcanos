export async function runRefactor(_payload: any): Promise<any> {
  console.log('[REFACTOR] Request received', _payload);
  return { success: true, message: 'Refactor task queued' };
}
