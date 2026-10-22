import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  // @ffmpeg/ffmpeg starts its own web worker via new URL(..., import.meta.url);
  // pre-bundling would break that path, so leave these packages as they are.
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "ui-vendor": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-label",
            "@radix-ui/react-progress",
            "@radix-ui/react-select",
            "@radix-ui/react-slot",
            "@radix-ui/react-tabs",
            "@radix-ui/react-toast",
          ],
          "motion-vendor": ["framer-motion"],
          "supabase-vendor": ["@supabase/supabase-js"],
          // jspdf is intentionally NOT listed here: it's loaded with a dynamic
          // import() on PDF export, and giving it a manual chunk made the entry
          // bundle statically depend on (and preload) the whole library.
          "query-vendor": ["@tanstack/react-query"],
        },
      },
    },
  },
});
