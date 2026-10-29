/**
 * Kept as a re-export shim so existing imports (`./env.js`) keep working.
 * The single source of truth for every directory/filename is `./paths.js` —
 * see that file for why this indirection exists.
 */
export {
  getDefaultSharedDir,
  getDefaultContainerSharedDir,
  getVoiceWorkRoot,
  fileUriToPath,
} from "./paths.js";
