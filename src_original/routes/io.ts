import path from 'path';
import { promises as fs } from 'fs';

const BASE_DIR = path.join(process.cwd(), 'storage');

export async function handleFileRead(payload: any): Promise<any> {
  const file = payload?.file;
  if (!file || typeof file !== 'string') {
    throw new Error('file path required');
  }
  const safePath = file.replace(/(\.\.|\/)*/g, '');
  const filePath = path.join(BASE_DIR, safePath);
  const data = await fs.readFile(filePath, 'utf8');
  return { file: safePath, data };
}
