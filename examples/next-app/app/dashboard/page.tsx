import { serverClient } from "@nextbasejs/next";
import { redirect } from "next/navigation";
import { links } from "@/lib/links";
import { nextbase } from "@/lib/nextbase";
import { OAUTH2_ERRORS } from "@/lib/oauth2-errors";
import { UnlinkButton } from "./unlink-button";

// proxy.ts sends signed-out visitors to /sign-in before this renders, and
// NextBase's rules decide what this user's client may read.
export default async function Dashboard({
  searchParams,
}: PageProps<"/dashboard">) {
  const { error } = await searchParams;
  const nb = await serverClient(nextbase);
  const session = await nb.getSession();
  // The session can end between proxy.ts and this render.
  if (!session) redirect("/sign-in");
  const record = session.record;
  const collection = String(record.collectionName);
  const users = nb.collection(collection);
  const [linked, methods] = await Promise.all([
    users.listExternalAuths(record.id),
    users.listAuthMethods(),
  ]);
  const unlinked = methods.oauth2.providers.filter(
    (p) => !linked.some((l) => l.provider === p.name),
  );
  const name = (provider: string) =>
    methods.oauth2.providers.find((p) => p.name === provider)?.displayName ??
    provider;
  return (
    <main>
      <h1>Dashboard</h1>
      {/* Accounts made by phone sign-in may have no email. */}
      <p>Welcome, {String(record.email || record.phone)}.</p>
      <h2>Linked accounts</h2>
      {typeof error === "string" && (
        <p role="alert">{OAUTH2_ERRORS[error] ?? "Linking failed."}</p>
      )}
      <ul>
        {linked.map((auth) => (
          <li key={auth.id}>
            {name(auth.provider)}{" "}
            <UnlinkButton
              collection={collection}
              recordId={record.id}
              provider={auth.provider}
            />
          </li>
        ))}
        {unlinked.map((provider) => (
          <li key={provider.name}>
            <a
              href={links.collection(collection).oauth2Url(provider.name, {
                link: true,
                redirect: "/dashboard",
              })}
            >
              Connect {provider.displayName}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
