import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// Guide module - handles AI guides and documentation
router.get('/guide', async (req, res) => {
  try {
    const { topic, section } = req.query;
    
    // Check for existing guides in docs/ai-guides
    const guidesPath = path.join(process.cwd(), 'docs', 'ai-guides');
    const guides = [];
    
    if (fs.existsSync(guidesPath)) {
      const files = fs.readdirSync(guidesPath);
      files.forEach(file => {
        if (file.endsWith('.md')) {
          guides.push({
            name: file.replace('.md', ''),
            file: file,
            path: path.join(guidesPath, file)
          });
        }
      });
    }
    
    const result = {
      status: 'success',
      message: 'Guide request processed',
      data: {
        topic: topic || 'general',
        section: section || 'overview',
        availableGuides: guides,
        timestamp: new Date().toISOString()
      }
    };
    
    console.log(`[📚 GUIDE] Processing guide request - Topic: ${topic}, Section: ${section}`);
    res.json(result);
  } catch (error) {
    console.error('[📚 GUIDE] Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Guide operation failed',
      error: error.message
    });
  }
});

// Guide content endpoint
router.get('/guide/:guideName', async (req, res) => {
  try {
    const { guideName } = req.params;
    const guidePath = path.join(process.cwd(), 'docs', 'ai-guides', `${guideName}.md`);
    
    if (fs.existsSync(guidePath)) {
      const content = fs.readFileSync(guidePath, 'utf8');
      res.json({
        status: 'success',
        guide: guideName,
        content: content
      });
    } else {
      res.status(404).json({
        status: 'error',
        message: `Guide '${guideName}' not found`
      });
    }
  } catch (error) {
    console.error('[📚 GUIDE] Error reading guide:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to read guide',
      error: error.message
    });
  }
});

// Guide status endpoint
router.get('/guide/status', (req, res) => {
  res.json({
    module: 'guide',
    status: 'active',
    version: '1.0.0',
    endpoints: ['/guide', '/guide/:guideName', '/guide/status']
  });
});

export default router;