// Release metadata carried over the wire. Type only, deliberately: the shared
// package is ESM and the extension host is CommonJS, so a *runtime* import of
// this package from the extension emits a require() that cannot resolve inside
// the packaged VSIX (which ships no node_modules next to dist/). Types are
// erased at compile time and are therefore always safe to share.
//
// The functions that read this shape live with their consumers:
// extension/src/release.ts and daemon/src/releaseWatcher.ts.

export interface ReleaseInfo {
  /** Git tag, e.g. "v0.7.12". */
  tagName: string;
  htmlUrl: string;
  /** Direct download for the packaged extension, when the release has one. */
  vsixUrl?: string;
  vsixName?: string;
}
