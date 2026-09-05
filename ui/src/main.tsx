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
import { KitchenSink } from "./components/KitchenSink.tsx";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
});

const rootEl = document.getElementById("root");
if (rootEl === null) throw new Error("index.html is missing #root");

// spec 20 §1.7 step 2 / spec 26 L7: `?kitchen-sink` renders every primitive
// once instead of the shell — a query flag, not a router dependency, since
// this is the only route the shell has.
const isKitchenSink = new URLSearchParams(window.location.search).has("kitchen-sink");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {isKitchenSink ? <KitchenSink /> : <App />}
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
