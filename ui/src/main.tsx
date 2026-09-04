// ui/src/main.tsx — entry point: tokens to :root first (so no frame ever
// paints untokened), then the query client, then the shell.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./theme/theme.css";
import { App } from "./App.tsx";
import { ThemeProvider } from "./theme/ThemeProvider.tsx";
import { applyTheme, DEFAULT_PRESET, resolveTheme } from "./theme/apply.ts";

const initial = resolveTheme(DEFAULT_PRESET);
applyTheme(initial, initial.density);

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
