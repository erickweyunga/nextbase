"use client";

import { useSession } from "@nextbase/react";

export function UserBadge() {
  const { data, isPending } = useSession();
  if (isPending) return null;
  return (
    <header>{data ? `Badge: ${String(data.email)}` : "Badge: guest"}</header>
  );
}
