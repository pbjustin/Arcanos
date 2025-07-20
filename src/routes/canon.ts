import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const canonRouter = Router();

// 📚 BACKSTAGE BOOKER — COPILOT COMMAND BLOCK: CANON FOLDER ACCESS API
// Purpose: Enable complete file-level access to canon data from backend
const CANON_PATH = path.join(__dirname, '../../containers/backstage-booker/canon');

// ✅ LIST FILES
canonRouter.get('/files', (req, res) => {
  console.log('📂 Canon files list endpoint called');
  fs.readdir(CANON_PATH, (err, files) => {
    if (err) {
      console.error('❌ Failed to list canon files:', err.message);
      return res.status(500).json({ error: 'Failed to list canon files' });
    }
    console.log('✅ Canon files listed successfully:', files.length, 'files');
    res.json(files);
  });
});

// ✅ READ FILE
canonRouter.get('/files/:name', (req, res) => {
  const fileName = req.params.name;
  const filePath = path.join(CANON_PATH, fileName);
  
  console.log('📖 Canon file read endpoint called for:', fileName);
  
  // Basic security check - prevent directory traversal
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    console.error('❌ Invalid filename detected:', fileName);
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  fs.readFile(filePath, 'utf-8', (err, data) => {
    if (err) {
      console.error('❌ Canon file not found:', fileName, err.message);
      return res.status(404).json({ error: 'Canon file not found' });
    }
    console.log('✅ Canon file read successfully:', fileName);
    res.json({ name: fileName, content: data });
  });
});

// ✅ WRITE FILE
canonRouter.post('/files/:name', (req, res) => {
  const fileName = req.params.name;
  const filePath = path.join(CANON_PATH, fileName);
  const { content } = req.body;
  
  console.log('💾 Canon file write endpoint called for:', fileName);
  
  // Basic security check - prevent directory traversal
  if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    console.error('❌ Invalid filename detected:', fileName);
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  if (content === undefined) {
    console.error('❌ Missing content for canon file:', fileName);
    return res.status(400).json({ error: 'Content is required' });
  }
  
  fs.writeFile(filePath, content, 'utf-8', (err) => {
    if (err) {
      console.error('❌ Failed to write canon file:', fileName, err.message);
      return res.status(500).json({ error: 'Failed to write canon file' });
    }
    console.log('✅ Canon file saved successfully:', fileName);
    res.json({ message: 'Canon file saved' });
  });
});

export default canonRouter;