/**
 * Request Builder for Cloud Code
 *
 * Builds request payloads and headers for the Cloud Code API.
 */

import crypto from 'crypto';
import {
    ANTIGRAVITY_HEADERS,
    ANTIGRAVITY_SYSTEM_INSTRUCTION,
    getModelFamily,
    isThinkingModel,
    GEMINI_CLI_OAUTH_CONFIG,
    AUTH_TYPES,
    MODEL_ALIASES
} from '../constants.js';
import { convertAnthropicToGoogle } from '../format/index.js';
import { deriveSessionId } from './session-manager.js';

/**
 * Build the wrapped request body for Cloud Code API
 *
 * @param {Object} anthropicRequest - The Anthropic-format request
 * @param {string} projectId - The project ID to use
 * @param {string} authType - The authentication type (antigravity or gemini-cli)
 * @returns {Object} The Cloud Code API request payload
 */
export function buildCloudCodeRequest(anthropicRequest, projectId, authType) {
    let model = anthropicRequest.model;

    // Strip "gc/" prefix (used to coerce Gemini CLI auth)
    if (model.startsWith('gc/')) {
        model = model.substring(3);
    }

    // Apply model aliases if defined for this auth type
    // e.g., gemini-3-flash -> gemini-3-flash-preview for gemini-cli
    if (authType && MODEL_ALIASES[authType] && MODEL_ALIASES[authType][model]) {
        model = MODEL_ALIASES[authType][model];
    }
    const googleRequest = convertAnthropicToGoogle(anthropicRequest);

    // Use stable session ID derived from first user message for cache continuity
    googleRequest.sessionId = deriveSessionId(anthropicRequest);

    // Build system instruction parts array with [ignore] tags to prevent model from
    // identifying as "Antigravity" (fixes GitHub issue #76)
    // Reference: CLIProxyAPI, gcli2api, AIClient-2-API all use this approach
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
        ? 'gemini-cli'
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
 * @param {Object} fingerprint - Optional device fingerprint object (unused)
 * @returns {Object} Headers object
 */
export function buildHeaders(token, model, accept = 'application/json', authType, fingerprint = null) {
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
