import "@/index.css"

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "@components/ui/theme-provider"
import { Toaster } from "@ui/sonner"
import { App } from "@/app"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
      <Toaster />
    </ThemeProvider>
  </StrictMode>
)
