// Fails the build if a client component imports this module.
import "server-only";
import { NextBase, type OAuth2Options } from "@nextbasejs/core";

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

/** The app's one NextBase instance, shared by the route handler and server components. */
export const nextbase = new NextBase({
  appUrl: process.env.APP_URL,
  oauth2: providers(process.env),
});
