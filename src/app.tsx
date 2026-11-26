/** The application shell: top bar, workspace, action area, and the layers above them. */
import { useEffect } from 'preact/hooks';
import { closeOverlay, jobs, mode, overlay, pickFiles } from './state';
import { Announcer } from './ui/announcer';
import { DetailsSheet } from './ui/details-sheet';
import { Dock } from './ui/dock';
import { DropOverlay } from './ui/drop-overlay';
import { EmptyState } from './ui/empty-state';
import { FileList } from './ui/file-list';
import { FileMenu } from './ui/file-menu';
import { SettingsSheet } from './ui/settings-sheet';
import { Toaster } from './ui/toaster';
import { TopBar } from './ui/topbar';

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      // Ctrl+O / ⌘O: choose files, instead of the browser's "open file" (which would leave the app).
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        if (overlay.peek() === null) pickFiles();
      } else if (event.key === 'Escape' && overlay.peek() !== null) {
        closeOverlay();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

export function App() {
  useGlobalShortcuts();
  const summary = jobs.summary.value;
  const empty = summary.phase === 'empty';
  return (
    <div class="app" data-mode={mode.value} data-phase={summary.phase}>
      <div class="page" id="page">
        <TopBar />
        <main class={`main ${empty ? 'main--empty' : 'main--files'}`} id="main" tabIndex={-1}>
          {empty ? (
            <EmptyState />
          ) : (
            <>
              <FileList />
              <Dock />
            </>
          )}
        </main>
      </div>
      <DetailsSheet />
      <SettingsSheet />
      <FileMenu />
      <Toaster />
      <DropOverlay />
      <Announcer />
    </div>
  );
}
