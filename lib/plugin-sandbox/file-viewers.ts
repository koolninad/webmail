// host-patch target path:  lib/plugin-sandbox/file-viewers.ts  (NEW FILE)
//
// Resolves an opened file's extension to the active plugin (if any) that has
// claimed it as a full-view file viewer via manifest.fileViewerExtensions.
// Used by the Files page to decide whether to render the 'file-viewer' plugin
// slot instead of the built-in FilePreviewModal.
//
// Generic + reusable: nothing here is OnlyOffice-specific. Any future viewer
// plugin (CAD, video-conferencing-on-a-file, etc.) participates by declaring
// its extensions in its manifest and offering the 'file-viewer' slot.

import { all } from './registry';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Return the pluginId that claims this filename's extension, or null. When more
 * than one plugin claims the same extension, the first registered wins; the set
 * of installed viewer plugins is expected to be admin-curated and non-
 * overlapping, so this is deterministic enough without a priority field.
 */
export function fileViewerPluginFor(name: string): string | null {
  const ext = extOf(name);
  if (!ext) return null;
  for (const entry of all()) {
    const exts = entry.plugin.fileViewerExtensions;
    if (exts && exts.includes(ext)) return entry.plugin.id;
  }
  return null;
}

/** True iff any active plugin claims this file's extension. */
export function hasFileViewerFor(name: string): boolean {
  return fileViewerPluginFor(name) !== null;
}
