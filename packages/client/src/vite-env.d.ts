/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_DISCORD_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Vite-specific module suffixes used in this project.
declare module '*?worker' {
  const WorkerCtor: new () => Worker;
  export default WorkerCtor;
}

declare module '*?raw' {
  const content: string;
  export default content;
}

// Vite serves binary assets imported by URL; .glb is not in the default
// client.d.ts list, so it's declared explicitly here.
declare module '*.glb' {
  const url: string;
  export default url;
}
