// API server entry point

import path from 'path';
import { fileURLToPath } from 'url';
import { createApiServer } from './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

const port = parseInt(process.env.API_PORT || '3001', 10);

(async () => {
  try {
    const { httpServer } = await createApiServer(projectRoot, port);
    httpServer.listen(port, () => {
      console.log(`\n🚀 Autonomous Agent API server running at http://localhost:${port}`);
      console.log(`📚 Swagger docs at http://localhost:${port}/api-docs`);
      console.log(`🔌 WebSocket ready on port ${port}\n`);
    });
  } catch (error) {
    console.error('Failed to start API server:', error);
    process.exit(1);
  }
})();
