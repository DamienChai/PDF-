/**
 * The application logic layer, in one import for the components:
 *
 *   import { jobs, lockForm, mode, settings, start, toasts } from './state';
 *
 * Signals in, plain functions out. Nothing here touches the DOM by itself until `start()` runs.
 */
export { APP_VERSION, OPEN_SOURCE_COMPONENTS, aboutInfo } from './about';
export type { AboutInfo, OpenSourceComponent } from './about';
export {
  closeOverlay,
  detailsEntry,
  dragActive,
  menuEntry,
  mode,
  openDetails,
  openMenu,
  openSettings,
  overlay,
  pickFiles,
  setMode,
  start,
} from './app';
export type { Mode, Overlay } from './app';
export { engineInfo, engineState, engineStatus } from './engine';
export type { EngineState, EngineStatus } from './engine';
export type {
  AlgorithmChipView,
  ChipView,
  DetailsView,
  EntryState,
  EntryView,
  ErrorView,
  PasswordFieldView,
  PermissionRow,
  PrimaryAction,
  ResultView,
  Summary,
  Tone,
  WorkspacePhase,
} from './entries';
export { jobs } from './jobs';
export type {
  AddFilesReport,
  Entry,
  FileSource,
  JobsController,
  RunRefusal,
  RunReport,
  SaveAllTarget,
} from './jobs';
export { lockForm } from './lock-form';
export type {
  LockAlgorithm,
  LockField,
  LockForm,
  LockFormErrors,
  LockPermissions,
  LockSubmitResult,
  StrengthView,
} from './lock-form';
export {
  DEFAULT_SETTINGS,
  MAX_SUFFIX_LENGTH,
  THEME_COLORS,
  locale,
  normalizeSuffix,
  resetSettings,
  resolvedTheme,
  settings,
  updateSettings,
} from './settings';
export type {
  OutputSettings,
  ResolvedTheme,
  Settings,
  SettingsPatch,
  ThemeSetting,
} from './settings';
export { installState, isStandalone, promptInstall } from '../pwa/install';
export type { InstallState } from '../pwa/install';
export { toasts } from './toasts';
export type { Toast, ToastAction, ToastOptions, ToastQueue, ToastTone } from './toasts';
