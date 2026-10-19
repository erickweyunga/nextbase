import { serverClient } from "@nextbase/next";
import { NextBaseProvider } from "@nextbase/react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { nextbase } from "@/lib/nextbase";
import { UserBadge } from "./user-badge";

export const metadata: Metadata = {
  title: "NextBase example",
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The server's view of the session seeds the browser's, so client
  // components render signed in from the first paint.
  const session = await (await serverClient(nextbase)).getSession();
  return (
    <html lang="en">
      <body>
        <NextBaseProvider session={session}>
          <UserBadge />
          {children}
        </NextBaseProvider>
      </body>
    </html>
  );
}
