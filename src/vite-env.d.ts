/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  readonly VITE_KICKBACK_MODE?: 'production' | 'demo' | 'test_lab'
  /**
   * Which cohort this build's analytics belong to. Separate from MODE on
   * purpose: a development build and a beta build are both "production mode"
   * as far as the backend is concerned, but their numbers must never be mixed.
   */
  readonly VITE_KICKBACK_ENV?: 'development' | 'private_beta' | 'production'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Injected at build time from public/manifest.json. */
declare const __KICKBACK_VERSION__: string
