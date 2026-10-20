// Fails the build if a client component imports this module.
import "server-only";
import {
  NextBase,
  type OAuth2Options,
  type SmsOptions,
} from "@nextbasejs/core";
import { serverClient } from "@nextbasejs/next";

/** The OAuth2 providers whose credentials are set: see .env.example. */
function providers(env: NodeJS.ProcessEnv): OAuth2Options {
  const oauth2: OAuth2Options = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    oauth2.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    oauth2.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    oauth2.oidc = {
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      displayName: env.OIDC_NAME ?? "OpenID Connect",
    };
  }
  return oauth2;
}

/**
 * Texts through your SMS gateway: SMS_WEBHOOK_URL receives a POST of
 * `{ to, text }` as JSON, and sends it on with your provider. Without it,
 * codes are logged in development.
 */
function sms(env: NodeJS.ProcessEnv): SmsOptions | undefined {
  const url = env.SMS_WEBHOOK_URL;
  if (!url) return undefined;
  return {
    ...(env.SMS_COUNTRIES && { countries: env.SMS_COUNTRIES.split(",") }),
    async send(message) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        throw new Error(`The SMS gateway answered ${response.status}.`);
      }
    },
  };
}

/** The app's one NextBase instance, shared by the route handler and server components. */
export const nextbase = new NextBase({
  appUrl: process.env.APP_URL,
  oauth2: providers(process.env),
  sms: sms(process.env),
});

/**
 * A client acting as the signed-in user, through the session cookie, for
 * server components and server actions. Call it once per request.
 */
export const nb = () => serverClient(nextbase);
