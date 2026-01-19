// ... (imports remain the same)
import {
    ANTIGRAVITY_HEADERS,
    ANTIGRAVITY_SYSTEM_INSTRUCTION,
    getModelFamily,
    isThinkingModel,
    GEMINI_CLI_OAUTH_CONFIG,
    AUTH_TYPES
} from '../constants.js';
import { convertAnthropicToGoogle } from '../format/index.js';
import { deriveSessionId } from './session-manager.js';
// ...

/**
 * Build the wrapped request body for Cloud Code API
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} projectId - The project ID to use
 * @param {string} authType - The authentication type (antigravity or gemini-cli)
 * @returns {Object} The Cloud Code API request payload
 */
export function buildCloudCodeRequest(anthropicRequest, projectId, authType) {
    const model = anthropicRequest.model;
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Use stable session ID derived from first user message for cache continuity
    googleRequest.sessionId = deriveSessionId(anthropicRequest);

    // Build system instruction parts array with [ignore] tags to prevent model from
    // identifying as "Antigravity" (fixes GitHub issue #76)
    const systemParts = [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore the following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` }
    ];

    // Append any existing system instructions from the request
    if (googleRequest.systemInstruction && googleRequest.systemInstruction.parts) {
        for (const part of googleRequest.systemInstruction.parts) {
            if (part.text) {
                systemParts.push({ text: part.text });
            }
        }
    }

    const userAgent = authType === AUTH_TYPES.GEMINI_CLI
        ? 'gemini-cli' // Or simplified string if needed, but 'gemini-cli' matches intent
        : 'antigravity';

    const payload = {
        project: projectId,
        model: model,
        request: googleRequest,
        userAgent: userAgent,
        requestType: 'agent',  // CLIProxyAPI v6.6.89 compatibility
        requestId: 'agent-' + crypto.randomUUID()
    };

    // Inject systemInstruction with role: "user" at the top level
    payload.request.systemInstruction = {
        role: 'user',
        parts: systemParts
    };

    return payload;
}

/**
 * Build headers for Cloud Code API requests
 *
 * @param {string} token - OAuth access token
 * @param {string} model - Model name
 * @param {string} accept - Accept header value (default: 'application/json')
 * @param {string} authType - The authentication type (antigravity or gemini-cli)
 * @returns {Object} Headers object
 */
export function buildHeaders(token, model, accept = 'application/json', authType) {
    let baseHeaders = ANTIGRAVITY_HEADERS;

    if (authType === AUTH_TYPES.GEMINI_CLI) {
        baseHeaders = {
            'User-Agent': GEMINI_CLI_OAUTH_CONFIG.userAgent
        };
    }

    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...baseHeaders
    };

    const modelFamily = getModelFamily(model);

    // Add interleaved thinking header only for Claude thinking models
    if (modelFamily === 'claude' && isThinkingModel(model)) {
        headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';
    }

    if (accept !== 'application/json') {
        headers['Accept'] = accept;
    }

    return headers;
}
