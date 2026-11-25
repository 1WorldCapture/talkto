// Swarm memory's Artifacts namespace (docs/swarm-server-spec.md, 14). A binding of its own, never
// `ARTIFACTS`: that name would bring back the retired Git file sharing (capabilities.ts). Each
// deployment binds its own namespace.
interface Env {
  readonly MEMORY_ARTIFACTS?: Artifacts;
}
/**
 * A reply of a repository read method before memory/artifacts.ts decodes it: an RPC value whose
 * shape Cloudflare has not published in the generated types yet.
 */
type ArtifactsUndecoded = object | string | null;
// The read methods Artifacts offers on a repository handle that wrangler 4.130's generated types
// do not list yet, as real Artifacts answered them at compatibility date 2026-09-08 (November 25,
// 2026): `log`, `readCommit` and `readTree` work. `readBlob` and `readFile` (on any present file)
// fail with "Cannot serialize value: [object Blob]", so TalkTo reads file bytes over Git instead
// and lists neither. On an RPC stub every name is a function: a runtime without one of these
// answers "The RPC receiver does not implement the method". memory/artifacts.ts decodes every
// reply, and disposes every handle it gets.
interface ArtifactsRepo {
  log(options: { ref: string; limit?: number; offset?: number }): Promise<ArtifactsUndecoded>;
  readCommit(hash: string): Promise<ArtifactsUndecoded>;
  readTree(hash: string): Promise<ArtifactsUndecoded>;
  [Symbol.dispose](): void;
}
