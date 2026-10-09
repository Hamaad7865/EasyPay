// The look of the back office, of /admin and of the sign-in pages in one
// browser: light, dark, or whatever the device itself is set to. A choice is
// kept in a cookie, so the server knows it before it draws the page and the
// page never opens one way and turns to the other. No cookie means nothing was
// chosen and the device decides, which the stylesheet does by itself
// (globals.css, "the dark look").
export const THEME_COOKIE = "ep-theme";

export type Theme = "light" | "dark";

export const themeOf = (v: string | undefined): Theme | null => (v === "light" || v === "dark" ? v : null);
