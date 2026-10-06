import type { AuthInfo } from '@modelcontextprotocol/server';

import type { Config } from './config.js';

/*
 * AUTH SEAM (issue #2). Everything about who is calling goes through this
 * file, and nothing else in the server looks at the Authorization header.
 *
 * Today: a request must carry a bearer token, and ANY bearer token is let
 * through, unverified, to be passed to the Mesub API, which is what refuses a
 * bad one. That is not authentication, and this server must not be exposed
 * as it is.
 *
 * What #2 fills in, here:
 * - `authenticate` verifies the token (issued by Mesub's authorization server,
 *   for this server as its audience, not expired) and fills `clientId`,
 *   `scopes`, `expiresAt` and `resource` from it. The SDK has the pieces:
 *   `requireBearerAuth` and `bearerAuthChallengeResponse`.
 * - `challenge` adds `resource_metadata="<publicUrl>/.well-known/oauth-protected-resource/mcp"`
 *   to `WWW-Authenticate`, as the MCP authorization specification asks.
 * - the app serves that RFC 9728 document (`oauthMetadataResponse` in the SDK),
 *   naming Mesub's authorization server, which does not exist yet.
 */

// RFC 6750, section 2.1: the `b64token` a bearer credential is made of.
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

/**
 * Who is calling, or the response that refuses them. A token is only ever
 * read from the Authorization header, never from the URL.
 */
export function authenticate(request: Request, config: Config): AuthInfo | Response {
    const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
    if (token === undefined) return challenge(config);

    // #2: verified claims instead of these placeholders.
    return { token, clientId: 'unverified', scopes: [] };
}

/**
 * 401, with a body a JSON-RPC client can read: an error response without an
 * id, as the SDK answers its own HTTP-level refusals. `_config` is unused
 * until #2 reads the public URL from it.
 */
function challenge(_config: Config): Response {
    return Response.json(
        {
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Authentication required: send a Mesub access token as a bearer token.',
            },
            id: null,
        },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
}
