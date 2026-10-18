import { connection } from "next/server";
import { nextbase } from "@/lib/nextbase";

export default async function Home() {
  // Rendered per request: the status lives in the database.
  await connection();
  const { required } = await nextbase.client().setupStatus();
  return (
    <main>
      <h1>NextBase example</h1>
      <p>
        {required
          ? "Setup required: create the first superuser with the token in the server log."
          : "Ready."}
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
