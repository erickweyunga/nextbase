import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/** The account the provider signs in, as the user approving at its page. */
export interface Account {
  sub: string;
  email?: string;
  emailVerified?: boolean;
}

export interface Provider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Its self-signed certificate, for NODE_EXTRA_CA_CERTS. */
  certificate: string;
  /**
   * Approves the authorization request at `authorizeUrl` for `account`, and
   * returns where the provider sends the browser back to.
   */
  approve(authorizeUrl: string, account: Account): string;
  stop(): Promise<void>;
}

interface Grant {
  challenge: string;
  redirectUri: string;
  nonce: string | null;
  account: Account;
}

/**
 * A minimal OpenID Connect provider over HTTPS, as real providers are and
 * as NextBase requires: discovery, the token endpoint with PKCE, and JWKS.
 * Its authorization page is `approve()`, standing in for the user.
 */
export async function startProvider(): Promise<Provider> {
  const dir = mkdtempSync(join(tmpdir(), 'nextbase-idp-'));
  const keyFile = join(dir, 'key.pem');
  const certificate = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-keyout',
    keyFile,
    '-out',
    certificate,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
  ]);
  const keys = await generateKeyPair('RS256');
  const clientId = 'example-app';
  const clientSecret = randomBytes(16).toString('hex');
  const grants = new Map<string, Grant>();
  let issuer = '';

  const server: Server = createServer(
    { key: readFileSync(keyFile), cert: readFileSync(certificate) },
    (request, response) => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const url = new URL(request.url ?? '/', issuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        return send(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/jwks') {
        exportJWK(keys.publicKey).then((jwk) => send(200, { keys: [jwk] }));
        return;
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        let text = '';
        request.on('data', (chunk) => (text += chunk));
        request.on('end', async () => {
          const body = new URLSearchParams(text);
          const code = body.get('code') ?? '';
          const grant = grants.get(code);
          grants.delete(code);
          const verifier = createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest('base64url');
          if (
            !grant ||
            verifier !== grant.challenge ||
            body.get('redirect_uri') !== grant.redirectUri ||
            body.get('client_id') !== clientId ||
            body.get('client_secret') !== clientSecret
          ) {
            return send(400, { error: 'invalid_grant' });
          }
          const idToken = await new SignJWT({
            ...(grant.account.email !== undefined && {
              email: grant.account.email,
              email_verified: grant.account.emailVerified ?? false,
            }),
            ...(grant.nonce !== null && { nonce: grant.nonce }),
          })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(issuer)
            .setSubject(grant.account.sub)
            .setAudience(clientId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(keys.privateKey);
          send(200, {
            access_token: randomBytes(16).toString('hex'),
            token_type: 'Bearer',
            id_token: idToken,
          });
        });
        return;
      }
      send(404, { error: 'not_found' });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
  issuer = `https://localhost:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    clientId,
    clientSecret,
    certificate,
    approve(authorizeUrl, account) {
      const request = new URL(authorizeUrl);
      if (request.origin !== issuer || request.pathname !== '/authorize') {
        throw new Error(
          `Not this provider's authorization URL: ${authorizeUrl}`,
        );
      }
      const params = request.searchParams;
      if (
        params.get('client_id') !== clientId ||
        params.get('response_type') !== 'code' ||
        params.get('code_challenge_method') !== 'S256'
      ) {
        throw new Error(`Invalid authorization request: ${authorizeUrl}`);
      }
      const code = randomBytes(16).toString('hex');
      const redirectUri = params.get('redirect_uri') ?? '';
      grants.set(code, {
        challenge: params.get('code_challenge') ?? '',
        redirectUri,
        nonce: params.get('nonce'),
        account,
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state') ?? '');
      return back.href;
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
