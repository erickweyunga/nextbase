import { serverClient } from "@nextbasejs/next";
import { links, returnPath } from "@/lib/links";
import { nextbase } from "@/lib/nextbase";
import { OAUTH2_ERRORS } from "@/lib/oauth2-errors";

export default async function SignIn({ searchParams }: PageProps<"/sign-in">) {
  const { next, error } = await searchParams;
  const nb = await serverClient(nextbase);
  // No providers until a "users" collection exists and one is configured.
  const methods = await nb
    .collection("users")
    .listAuthMethods()
    .catch(() => null);
  const providers = methods?.oauth2.enabled ? methods.oauth2.providers : [];
  const redirect = returnPath(next);
  // Failures come back here rather than to the protected page, which would
  // send them on to this page without the error.
  const errorRedirect = `/sign-in?next=${encodeURIComponent(redirect)}`;
  return (
    <main>
      <h1>Sign in</h1>
      {typeof error === "string" && (
        <p role="alert">{OAUTH2_ERRORS[error] ?? "The sign-in failed."}</p>
      )}
      {providers.length > 0 ? (
        <ul>
          {providers.map((provider) => (
            <li key={provider.name}>
              <a
                href={links
                  .collection("users")
                  .oauth2Url(provider.name, { redirect, errorRedirect })}
              >
                Continue with {provider.displayName}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p>Sign in with the NextBase client to see your dashboard.</p>
      )}
    </main>
  );
}
