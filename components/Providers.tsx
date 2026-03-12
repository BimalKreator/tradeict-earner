"use client";

import { SessionProvider } from "next-auth/react";
import { ReactNode } from "react";
import { ApiKeysProvider } from "@/contexts/ApiKeysContext";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ApiKeysProvider>{children}</ApiKeysProvider>
    </SessionProvider>
  );
}
