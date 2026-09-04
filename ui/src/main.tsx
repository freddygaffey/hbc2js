// ui/src/main.tsx — entry point: tokens to :root first (so no frame ever
// paints untokened), then the query client, then the shell.
//
// Importing `./theme/ThemeProvider.tsx` pulls in `./theme/store.ts`, whose
// own module-load side effect applies the PERSISTED theme (not a hardcoded
// default) to `:root` before this module's own top-level code runs — so
// there is nothing left to do here. (Applying a hardcoded default here too
// used to be needed when `ThemeProvider` only corrected it later, in a
// post-mount effect; doing it twice now would stomp the correct persisted
// theme back to the default on every load — bur 6, docs/UI-BURS.md #6.)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./theme/theme.css";
import { App } from "./App.tsx";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
});

const rootEl = document.getElementById("root");
if (rootEl === null) throw new Error("index.html is missing #root");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
