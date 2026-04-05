declare global {
  interface BunFile extends Blob {}

  const Bun:
    | {
        file(path: string | URL): BunFile;
      }
    | undefined;
}

export {};
