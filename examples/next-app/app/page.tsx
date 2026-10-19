import { serverClient } from "@nextbase/next";
import { nextbase } from "@/lib/nextbase";

export default async function Home() {
  // Reads the session cookie, so this page renders per request as the
  // signed-in user, with the same rules as the API.
  const nb = await serverClient(nextbase);
  const [session, { required }] = await Promise.all([
    nb.getSession(),
    nb.setupStatus(),
  ]);
  return (
    <main>
      <h1>NextBase example</h1>
      <p>
        {required
          ? "Setup required: create the first superuser with the token in the server log."
          : "Ready."}
      </p>
      <p>
        {session
          ? `Signed in as ${String(session.record.email)}.`
          : "Not signed in."}
      </p>
      <ul>
        <li>
          <a href="/api/nextbase/health">API health</a>
        </li>
        <li>
          <a href="/api/nextbase/_">Admin UI</a>
        </li>
      </ul>
    </main>
  );
}
