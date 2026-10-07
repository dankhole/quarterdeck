/**
 * Shared browser/runtime contract version, independent of package and build IDs.
 *
 * Increment only when either side can no longer work with the previous contract:
 * removed/changed APIs, incompatible stream shapes or semantics, or a browser
 * dependency on a new runtime feature without a fallback. Compatible additions,
 * fixes, and rebuilds keep this version. See DEVELOPMENT.md for the bump policy.
 */
export const QUARTERDECK_RUNTIME_PROTOCOL_VERSION = 4;
