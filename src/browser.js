import { config } from './config.js';

// The pinned-copy approach is gone: Chrome 137+ blocks --load-extension, so the
// extension lives in the dedicated profile and updates itself. That means the
// version guard has to happen at runtime, off the panel footer, rather than by
// freezing files on disk.
export function checkPanelVersion(versionOnPage) {
  if (!versionOnPage) return { ok: true, note: 'version not visible on page' };
  if (versionOnPage !== config.expectedExtensionVersion) {
    return {
      ok: false,
      note:
        `Panel reports v${versionOnPage}, extractor targets ` +
        `v${config.expectedExtensionVersion}. Re-run \`npm run probe\`, confirm ` +
        `the two fields still parse, then bump expectedExtensionVersion.`,
    };
  }
  return { ok: true };
}
