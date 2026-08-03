// STUB — FIXME(MJX-106): the desktop PreviewStatusRow surfaces localhost /
// on-disk preview artifacts recorded per session, opening them in the browser via
// window.hermesDesktop.openPreviewInBrowser. The feed it reads IS ported —
// `store/preview-status.ts` ($previewStatusBySession) is a direct port and is
// already written by components/assistant-ui/tool/fallback.tsx. What's missing is
// this row plus an openPreviewInBrowser equivalent; note nothing imports this
// file yet, so mounting it in status-stack/index.tsx is part of the work.
export function PreviewStatusRow() {
  return null
}
