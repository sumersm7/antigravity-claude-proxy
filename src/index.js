/**
 * Antigravity Claude Proxy
 * Entry point - starts the proxy server
 */

import app from './server.js';
import { DEFAULT_PORT } from './constants.js';
import { logger } from './utils/logger.js';
import path from 'path';
import os from 'os';

// Parse command line arguments
const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || process.env.DEBUG === 'true';

// Initialize logger
logger.setDebug(isDebug);

if (isDebug) {
    logger.debug('Debug mode enabled');
}

const PORT = process.env.PORT || DEFAULT_PORT;

// Home directory for account storage
const HOME_DIR = os.homedir();
const CONFIG_DIR = path.join(HOME_DIR, '.antigravity-claude-proxy');

app.listen(PORT, () => {
    // Clear console for a clean start
    console.clear();

    logger.log(`
╔══════════════════════════════════════════════════════════════╗
║           Antigravity Claude Proxy Server                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Server running at: http://localhost:${PORT}                 ║
║                                                              ║
║  Control:                                                    ║
║    --debug            Enable debug logging                   ║
║    Ctrl+C             Stop server                            ║
║                                                              ║
║  Control:                                                    ║
║    --debug            Enable debug logging                   ║
║    Ctrl+C             Stop server                            ║
║                                                              ║
║  Endpoints:                                                  ║
║    POST /v1/messages         - Anthropic Messages API        ║
║    POST /openai/v1/chat...   - OpenAI Chat API               ║
║    GET  /v1/models           - List available models         ║
║    GET  /health              - Health check                  ║
║    GET  /account-limits      - Account status & quotas       ║
║    POST /refresh-token       - Force token refresh           ║
║                                                              ║
║  Configuration:                                              ║
║    Storage: ${CONFIG_DIR}                                    ║
║                                                              ║
║  Usage with Claude Code:                                     ║
║    export ANTHROPIC_BASE_URL=http://localhost:${PORT}        ║
║    export ANTHROPIC_API_KEY=dummy                            ║
║    claude                                                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
    
    logger.success(`Server started successfully on port ${PORT}`);
    if (isDebug) {
        logger.warn('Running in DEBUG mode - verbose logs enabled');
    }
});
