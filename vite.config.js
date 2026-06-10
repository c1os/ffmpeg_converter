import { defineConfig } from "vite"

export default defineConfig({
  server: {
    host: true,
  },
  // ffmpeg core is fetched from a CDN at runtime via blob URLs,
  // so nothing extra needs to be bundled.
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
})
