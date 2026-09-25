import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    /* Forward /api to the API process during development. The client always
       uses relative URLs, so this is what makes dev match production: one
       origin, no CORS, no host name compiled into the bundle. */
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET || "http://localhost:4000",
        changeOrigin: true
      }
    }
  }
});
