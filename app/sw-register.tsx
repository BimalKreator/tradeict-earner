"use client";

import { useEffect } from "react";

export function SWRegister() {
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      "serviceWorker" in navigator
    ) {
      window.addEventListener("load", () => {
        navigator.serviceWorker
          .register("/sw.js")
          .then((reg) => {
            if (reg.installing) reg.installing.addEventListener("statechange", () => {});
          })
          .catch(() => {});
      });
    }
  }, []);

  return null;
}
