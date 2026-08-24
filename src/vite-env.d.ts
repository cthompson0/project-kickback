/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  readonly VITE_KICKBACK_MODE?: 'production' | 'demo'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected at build time from public/manifest.json. */
declare const __KICKBACK_VERSION__: string
