import { links, returnPath } from "@/lib/links";
import { nb } from "@/lib/nextbase";
import { OAUTH2_ERRORS } from "@/lib/oauth2-errors";
import { PhoneSignIn } from "./phone-sign-in";

export default async function SignIn({ searchParams }: PageProps<"/sign-in">) {
  const { next, error } = await searchParams;
  const client = await nb();
  // No providers until a "users" collection exists and one is configured.
  const methods = await client
    .collection("users")
    .listAuthMethods()
    .catch(() => null);
  const providers = methods?.oauth2.enabled ? methods.oauth2.providers : [];
  const redirect = returnPath(next);
  // Failures return here: the protected page would redirect here and drop the error.
  const errorRedirect = `/sign-in?next=${encodeURIComponent(redirect)}`;
  return (
    <main>
      <h1>Sign in</h1>
      {typeof error === "string" && (
        <p role="alert">{OAUTH2_ERRORS[error] ?? "The sign-in failed."}</p>
      )}
      {methods?.phone.enabled && <PhoneSignIn redirect={redirect} />}
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
