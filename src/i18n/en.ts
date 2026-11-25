/**
 * English. Same keys and placeholders as zh-CN.ts (enforced by the type and by a unit test);
 * messages with a `{count}` may give one template per plural category.
 *
 * Terminology: password (any) · open password (user password) · permissions password (owner
 * password) · unlock (remove a password) · remove restrictions · lock (add protection).
 */
import type { MessageValue } from './types';
import type { zhCN } from './zh-CN';

export const en: Record<keyof typeof zhCN, MessageValue> = {
  // --- App -------------------------------------------------------------------------------------
  'app.name': 'PDF Key',
  'app.tagline': 'Unlock and lock PDFs on your device',

  // --- Top bar and mode switch ------------------------------------------------------------------
  'topbar.install': 'Install',
  'topbar.settings': 'Settings',
  'mode.label': 'Mode',
  'mode.unlock': 'Unlock',
  'mode.lock': 'Lock',

  // --- Empty state -----------------------------------------------------------------------------
  'empty.unlock.title': 'Unlock a PDF',
  'empty.unlock.body': 'Enter the password once and get a copy that opens without it.',
  'empty.lock.title': 'Lock a PDF',
  'empty.lock.body': 'Protect a PDF with a password, or restrict printing, copying and editing.',
  'empty.choose': 'Choose PDFs',
  'empty.dropHint': 'or drop files here',
  'empty.pasteHint': 'You can also paste files',
  'empty.privacy': 'Files are processed on this device and never uploaded',
  'empty.chip.aes256': 'AES-256',
  'empty.chip.batch': 'Batch processing',
  'empty.chip.offline': 'Works offline',

  // --- Drop overlay ----------------------------------------------------------------------------
  'drop.title': 'Drop to add',
  'drop.subtitle': 'Files are processed on this device and never uploaded',

  // --- File list -------------------------------------------------------------------------------
  'list.label': 'Files',
  'list.addMore': 'Add files',
  'list.separator': ', ',

  // --- Status chips ----------------------------------------------------------------------------
  'chip.analysing': 'Analysing',
  'chip.needsPassword': 'Password required',
  'chip.restricted': 'Restrictions only',
  'chip.notEncrypted': 'Not encrypted',
  'chip.encrypted': 'Encrypted',
  'chip.unlocked': 'Unlocked',
  'chip.locked': 'Encrypted',
  'chip.wrongPassword': 'Wrong password',
  'chip.queued': 'Waiting',
  'chip.processing': 'Processing',
  'chip.error': 'Can’t process',

  // --- File card -------------------------------------------------------------------------------
  'entry.note.nothingToUnlock': 'No password protection, nothing to unlock',
  'entry.note.noRestrictions': 'Has a permissions password, but nothing is restricted',
  'entry.note.willEncrypt': 'Will be encrypted',
  'entry.note.willReplace': 'Its current protection will be replaced',
  'entry.note.needsCurrentPassword': 'Enter the current password to change the protection',
  'entry.password.label': 'Password',
  'entry.password.placeholder': 'Password for this file',
  'entry.password.submit': 'Unlock',
  'entry.password.wrong': 'Wrong password',
  'entry.currentPassword.label': 'Current password',
  'entry.currentPassword.placeholder': 'This file’s current password',
  'entry.currentPassword.wrong': 'Wrong current password',
  'entry.currentPassword.required': 'Enter the current password',
  'entry.menu': 'More actions',
  'entry.menu.details': 'Details',
  'entry.menu.remove': 'Remove',
  'entry.menu.redo': 'Process again',
  'entry.cancel': 'Cancel',
  'entry.retry': 'Try again',
  'entry.save': 'Save',
  'entry.share': 'Share',
  'entry.open': 'Open',
  'entry.saved': 'Saved',
  'entry.error.details': 'Technical details',
  'entry.warnings': {
    one: '{count} problem in the file structure was repaired',
    other: '{count} problems in the file structure were repaired',
  },

  // --- Restrictions (one line on the card) -----------------------------------------------------
  'restriction.print': 'No printing',
  'restriction.printLow': 'Low-resolution printing only',
  'restriction.extract': 'No copying',
  'restriction.modify': 'No editing',
  'restriction.annotate': 'No commenting',
  'restriction.fillForms': 'No form filling',
  'restriction.assemble': 'No page changes',

  // --- Unlock: action area ---------------------------------------------------------------------
  'unlock.password.label': 'Password',
  'unlock.password.placeholder': 'Enter the PDF password',
  'unlock.password.sharedHint': 'This password is tried on every file that needs one',
  'unlock.password.wrong': 'Wrong password. Try again.',
  'password.show': 'Show password',
  'password.hide': 'Hide password',

  // --- Primary and batch actions ---------------------------------------------------------------
  'action.unlock': 'Unlock',
  'action.unlockCount': { one: 'Unlock {count} file', other: 'Unlock {count} files' },
  'action.removeRestrictions': 'Remove restrictions',
  'action.removeRestrictionsCount': {
    one: 'Remove restrictions from {count} file',
    other: 'Remove restrictions from {count} files',
  },
  'action.lock': 'Lock',
  'action.lockCount': { one: 'Lock {count} file', other: 'Lock {count} files' },
  'action.cancel': 'Cancel',
  'action.cancelAll': 'Cancel all',
  'action.saveAll': 'Save all',
  'action.saveAllZip': 'Save as ZIP',
  'action.saveAllFolder': 'Save to folder',
  'action.shareAll': 'Share all',
  'action.clear': 'Clear',
  'action.startOver': 'Process new files',
  'action.switchToLock': 'Lock instead',
  'action.switchToUnlock': 'Unlock instead',

  // --- Status line of the action area ----------------------------------------------------------
  'status.analysing': 'Analysing…',
  'status.processing': 'Processing…',
  'status.processingCount': 'Processing, {done} of {total} done',
  'status.nothingToUnlock': 'None of these files is password-protected. Nothing to unlock.',
  'status.nothingToLock': 'Enter the current password on the file card.',
  'status.nothingToDo': 'There is nothing to process.',
  'status.unlocked': { one: '{count} file unlocked', other: '{count} files unlocked' },
  'status.locked': { one: '{count} file locked', other: '{count} files locked' },
  'status.failed': {
    one: '{count} file could not be processed',
    other: '{count} files could not be processed',
  },

  // --- Lock form -------------------------------------------------------------------------------
  'lock.password.label': 'Password',
  'lock.password.openLabel': 'Open password',
  'lock.password.placeholder': 'Set a password',
  'lock.password.openOptional':
    'Optional: without it anyone can open the document, but the restrictions apply',
  'lock.confirm.label': 'Confirm password',
  'lock.confirm.placeholder': 'Enter the password again',
  'lock.generate': 'Generate strong password',
  'lock.generated': 'Strong password generated. Store it safely before you lock.',
  'lock.copy': 'Copy password',
  'lock.advanced': 'Advanced options',
  'lock.algorithm.label': 'Encryption',
  'lock.algorithm.aes-256': 'AES-256 (recommended)',
  'lock.algorithm.aes-256.description':
    'Strongest. Needs a reasonably recent reader (Acrobat X, most software since 2011)',
  'lock.algorithm.aes-128': 'AES-128 (for older readers)',
  'lock.algorithm.aes-128.description':
    'Passwords are limited to 32 Latin letters, digits and symbols',
  'lock.owner.switch': 'Separate permissions password',
  'lock.owner.description': 'A second password that restricts printing, copying and editing',
  'lock.owner.label': 'Permissions password',
  'lock.owner.placeholder': 'Set a permissions password',
  'lock.permissions.title': 'Allowed actions',
  'lock.permissions.note':
    'Restrictions rely on the reader honouring them. They are no substitute for an open password.',
  'lock.permission.print': 'Printing',
  'lock.print.full': 'Allowed',
  'lock.print.low': 'Low resolution only',
  'lock.print.none': 'Not allowed',
  'lock.permission.extract': 'Copying text and images',
  'lock.permission.modify': 'Editing content',
  'lock.permission.annotate': 'Commenting and filling in forms',
  'lock.permission.assemble': 'Organising pages',
  'lock.metadata.switch': 'Encrypt document metadata',
  'lock.metadata.description': 'Title, author and similar details are encrypted too',
  'lock.warning':
    'Remember this password. A forgotten password cannot be recovered, and the file can no longer be opened.',
  'lock.error.required': 'Enter a password',
  'lock.error.confirmRequired': 'Enter the password again',
  'lock.error.mismatch': 'The passwords do not match',
  'lock.error.tooLong.aes-256': 'Too long: at most 127 Latin characters (fewer in other scripts)',
  'lock.error.tooLong.aes-128': 'Too long: AES-128 allows at most 32 characters',
  'lock.error.notEncodable.aes-256': 'The password contains characters that cannot be used',
  'lock.error.notEncodable.aes-128':
    'AES-128 cannot use some of these characters. Switch to AES-256, or use Latin letters, digits and symbols only',
  'lock.error.ownerRequired': 'Enter a permissions password',
  'lock.error.ownerSame': 'The permissions password must differ from the open password',

  // --- Password strength -----------------------------------------------------------------------
  'strength.label': 'Password strength',
  'strength.0': 'Very weak',
  'strength.1': 'Weak',
  'strength.2': 'Fair',
  'strength.3': 'Strong',
  'strength.4': 'Very strong',
  'strength.hint.too-short': 'Too short: use at least 8 characters',
  'strength.hint.common-password': 'This is a common password and easy to guess',
  'strength.hint.repeated-characters': 'Avoid repeated characters',
  'strength.hint.sequence': 'Avoid sequences and keyboard patterns such as 1234 or qwerty',
  'strength.hint.single-character-class': 'Mix upper and lower case letters, digits and symbols',
  'strength.hint.looks-like-date': 'Avoid dates',

  // --- Algorithms ------------------------------------------------------------------------------
  'algorithm.rc4': 'RC4 {bits}-bit (outdated)',
  'algorithm.aes-128': 'AES-128',
  'algorithm.aes-256': 'AES-256',
  'algorithm.aes-256-r5': 'AES-256 (legacy R5)',
  'algorithm.unknown': 'Unknown algorithm',
  'algorithm.chip.rc4': 'RC4-{bits}',
  'algorithm.chip.aes-128': 'AES-128',
  'algorithm.chip.aes-256': 'AES-256',
  'algorithm.chip.unknown': 'Unknown',
  'algorithm.outdated': 'Outdated',

  // --- Permissions (details) -------------------------------------------------------------------
  'permission.print': 'Printing',
  'permission.modify': 'Editing content',
  'permission.extract': 'Copying text and images',
  'permission.annotate': 'Commenting',
  'permission.fillForms': 'Filling in forms',
  'permission.assemble': 'Organising pages',
  'permission.accessibility': 'Reading by assistive technology',
  'permission.allowed': 'Allowed',
  'permission.denied': 'Not allowed',
  'permission.lowResolution': 'Low resolution only',

  // --- Details ---------------------------------------------------------------------------------
  'details.title': 'File details',
  'details.close': 'Close',
  'details.protection': 'Protection',
  'details.protection.none': 'Not encrypted',
  'details.protection.password': 'Password required to open',
  'details.protection.restrictions': 'Restrictions only, opens without a password',
  'details.algorithm': 'Encryption',
  'details.keyLength': 'Key length',
  'details.bits': '{bits} bits',
  'details.pdfVersion': 'PDF version',
  'details.pages': 'Pages',
  'details.size': 'File size',
  'details.metadata': 'Metadata',
  'details.metadata.encrypted': 'Encrypted',
  'details.metadata.clear': 'Not encrypted',
  'details.fastWebView': 'Fast web view',
  'details.yes': 'Yes',
  'details.no': 'No',
  'details.unknown': 'Shown once unlocked',
  'details.permissions': 'Permissions',
  'details.permissions.all': 'A document that is not encrypted has no restrictions.',
  'details.permissions.withPassword':
    'These restrictions apply unless the document is opened with the permissions password.',
  'details.outdated': 'RC4 is outdated and no longer secure. Consider locking again with AES-256.',
  'details.warnings': 'Notes',
  'details.output': 'Output file',
  'details.duration': 'Processing time',
  'details.verified': 'The output was reopened and verified',

  // --- Settings --------------------------------------------------------------------------------
  'settings.title': 'Settings',
  'settings.close': 'Done',
  'settings.language': 'Language',
  'settings.language.auto': 'System default',
  'settings.language.zh-CN': '简体中文',
  'settings.language.en': 'English',
  'settings.theme': 'Theme',
  'settings.theme.system': 'System',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.naming': 'Output file names',
  'settings.naming.decryptSuffix': 'Suffix after unlocking',
  'settings.naming.encryptSuffix': 'Suffix after locking',
  'settings.naming.sample': 'document.pdf',
  'settings.naming.preview': 'Example: {name}',
  'settings.naming.reset': 'Reset to default',
  'settings.autoSave': 'Save automatically when done',
  'settings.autoSave.description':
    'Results go straight to the browser’s download location; several files are bundled into one ZIP.',
  'settings.output': 'Output options',
  'settings.output.optimize': 'Optimise file size',
  'settings.output.optimize.description':
    'Compresses the document’s internal data. Usually smaller, slightly slower.',
  'settings.output.linearize': 'Fast web view',
  'settings.output.linearize.description':
    'Lets a browser show the first pages while the rest is still downloading.',
  'settings.install': 'Install app',
  'settings.install.description':
    'Works offline once installed, and other apps can share PDFs straight to it.',
  'settings.install.installed': 'Installed',
  'settings.install.hint':
    'No install button here? Use “Install app” or “Add to Home Screen” in your browser’s menu.',

  // --- About -----------------------------------------------------------------------------------
  'about.title': 'About',
  'about.version': 'Version',
  'about.engine': 'PDF engine',
  'about.engine.value': 'qpdf {version}',
  'about.engine.loading': 'Loading…',
  'about.engine.unavailable': 'Could not be loaded',
  'about.engine.compatibility': 'compatibility mode',
  'about.privacy':
    'Everything is processed on this device. Files and passwords never leave it; the app uploads nothing and contains no analytics or tracking.',
  'about.licenses': 'Open-source licences',
  'about.licenses.app': 'This app is free software, released under the GNU AGPL 3.0 or later.',
  'about.licenses.thirdParty': 'It includes these open-source components:',

  // --- Toasts ----------------------------------------------------------------------------------
  'toast.dismiss': 'Dismiss',
  'toast.saved': 'Saved',
  'toast.savedCount': { one: '{count} file saved', other: '{count} files saved' },
  'toast.downloaded': 'Download started',
  'toast.autoSaved': 'Saved automatically to your downloads',
  'toast.saveFailed': 'Could not save. Try again.',
  'toast.openFailed': 'Could not open the file',
  'toast.shareUnsupported': 'This device cannot share these files. Save them instead.',
  'toast.shareFailed': 'Could not share. Try again.',
  'toast.copied': 'Copied',
  'toast.passwordCopied': 'Password copied',
  'toast.copyFailed': 'Could not copy. Select the text and copy it manually.',
  'toast.update': 'A new version is available',
  'toast.update.action': 'Refresh',
  'toast.offlineReady': 'Ready to work offline',
  'toast.notPdf': '“{name}” is not a PDF and was skipped',
  'toast.notPdfCount': {
    one: 'Skipped {count} file that is not a PDF',
    other: 'Skipped {count} files that are not PDFs',
  },
  'toast.duplicate': '“{name}” is already in the list',
  'toast.duplicateCount': {
    one: '{count} file is already in the list',
    other: '{count} files are already in the list',
  },
  'toast.engineUnavailable': 'The PDF engine could not be loaded',
  'toast.retry': 'Try again',

  // --- Archive names ---------------------------------------------------------------------------
  'zip.unlocked': 'Unlocked PDFs',
  'zip.locked': 'Locked PDFs',
  'share.title': 'PDF Key',

  // --- Engine errors: a short headline, and one sentence on what to do -----------------------
  'error.password-required.title': 'Password required',
  'error.password-required.advice': 'Enter the password that opens this file.',
  'error.password-incorrect.title': 'Wrong password',
  'error.password-incorrect.advice': 'Check capitalisation and keyboard layout, then try again.',
  'error.not-encrypted.title': 'Not encrypted',
  'error.not-encrypted.advice': 'This file has no password protection. There is nothing to unlock.',
  'error.not-pdf.title': 'Not a PDF',
  'error.not-pdf.advice': 'Choose a valid PDF document.',
  'error.damaged.title': 'File is damaged',
  'error.damaged.advice':
    'Its structure is broken and cannot be read. Download or export it again, then retry.',
  'error.unsupported-encryption.title': 'Unsupported encryption',
  'error.unsupported-encryption.advice':
    'This file is protected with a certificate or a third-party plug-in, not a password.',
  'error.password-not-encodable.title': 'Unsupported characters in the password',
  'error.password-not-encodable.advice':
    'Switch to AES-256, or use Latin letters, digits and symbols only.',
  'error.password-too-long.title': 'Password too long',
  'error.password-too-long.advice':
    'Shorten it: AES-256 allows 127 Latin characters, AES-128 allows 32.',
  'error.password-missing.title': 'No password set',
  'error.password-missing.advice': 'Enter an open password or a permissions password.',
  'error.read-failed.title': 'Could not read the file',
  'error.read-failed.advice': 'It may have been moved or deleted. Choose it again.',
  'error.out-of-memory.title': 'Not enough memory',
  'error.out-of-memory.advice': 'The file is too large. Close other tabs or apps and try again.',
  'error.cancelled.title': 'Cancelled',
  'error.cancelled.advice': 'The operation was cancelled. You can start it again.',
  'error.engine-unavailable.title': 'The PDF engine could not be loaded',
  'error.engine-unavailable.advice':
    'Reload the page and try again. The first use needs a connection once.',
  'error.internal.title': 'Processing failed',
  'error.internal.advice':
    'Something unexpected went wrong. Try again; if it keeps failing, the file may not be supported.',
  'error.unknown.title': 'Processing failed',
  'error.unknown.advice': 'Something unexpected went wrong. Try again.',

  // --- Labels for icon-only controls -------------------------------------------------------------
  'aria.close': 'Close',
  'aria.removeFile': 'Remove {name}',
  'aria.fileMenu': 'More actions for {name}',
  'aria.progress': 'Progress',
  'aria.clearField': 'Clear',
  'aria.pdfFile': 'PDF file',
  'aria.status': 'Status',
  'aria.notifications': 'Notifications',

  // --- Formats ---------------------------------------------------------------------------------
  'format.files': { one: '{count} file', other: '{count} files' },
  'format.pages': { one: '{count} page', other: '{count} pages' },
  'format.seconds': '{value} s',
  'format.minutes': '{minutes} min {seconds} s',
  'format.lessThanSecond': 'Less than a second',
};
