import { NextBaseProvider } from '@nextbasejs/react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { nb } from '@/lib/nextbase';
import { UserBadge } from './user-badge';

export const metadata: Metadata = {
  title: 'NextBase example',
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Seeding the server's session lets client components render signed in on first paint.
  const session = await (await nb()).getSession();
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
