/*
 * jconfig.h for building IJG libjpeg with Emscripten (clang, ANSI C, 32-bit WebAssembly).
 *
 * This is jconfig.cfg from the libjpeg distribution with the values its configure script selects
 * for a modern ANSI C compiler filled in by hand, so the build needs no configure run.
 */

#define HAVE_PROTOTYPES 1
#define HAVE_UNSIGNED_CHAR 1
#define HAVE_UNSIGNED_SHORT 1
/* #undef void */
/* #undef const */
/* #undef CHAR_IS_UNSIGNED */
#define HAVE_STDDEF_H 1
#define HAVE_STDLIB_H 1
#define HAVE_LOCALE_H 1
/* #undef NEED_BSD_STRINGS */
/* #undef NEED_SYS_TYPES_H */
/* #undef NEED_FAR_POINTERS */
/* #undef NEED_SHORT_EXTERNAL_NAMES */
/* #undef INCOMPLETE_TYPES_BROKEN */

#ifdef JPEG_INTERNALS

/* #undef RIGHT_SHIFT_IS_UNSIGNED */
#define INLINE __inline__
/* jmemnobs.c is used: no backing store, so there is no memory limit to configure. */
/* #undef DEFAULT_MAX_MEM */
/* #undef NO_MKTEMP */

#endif /* JPEG_INTERNALS */
