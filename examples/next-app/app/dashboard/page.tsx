import { serverClient } from "@nextbasejs/next";
import { nextbase } from "@/lib/nextbase";

// proxy.ts sends signed-out visitors to /sign-in before this renders, and
// NextBase's rules decide what this user's client may read.
export default async function Dashboard() {
  const nb = await serverClient(nextbase);
  const session = await nb.getSession();
  return (
    <main>
      <h1>Dashboard</h1>
      <p>Welcome, {String(session?.record.email ?? "")}.</p>
    </main>
  );
}
