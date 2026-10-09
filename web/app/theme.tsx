"use client";

import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

// The switch between the light look and the dark one: a round key beside the
// way out. Its sign says what is chosen (a screen: the same as this device),
// and each press goes to the next choice. The page changes there and then;
// the cookie is for the next page the server draws.

const YEAR = 60 * 60 * 24 * 365;

// `theme` is the choice, null where none was made. `turn` goes to the next
// one. From "same as this device" the first press goes to the look the device
// does not have, so a press always changes what is on the screen.
export function useTheme(initial: Theme | null) {
  const [theme, setTheme] = useState(initial);
  const turn = () => {
    const deviceDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const order: (Theme | null)[] = deviceDark ? [null, "light", "dark"] : [null, "dark", "light"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    const root = document.documentElement;
    if (next) root.dataset.theme = next;
    else delete root.dataset.theme;
    document.cookie = next ? `${THEME_COOKIE}=${next}; path=/; max-age=${YEAR}; samesite=lax` : `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
    setTheme(next);
  };
  return [theme, turn] as const;
}

// The key itself. The menu shows it twice (in the menu and in the folded
// rail's card), so what is chosen is held by whoever draws it.
export function ThemeButton({ theme, turn }: { theme: Theme | null; turn: () => void }) {
  const Sign = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const say = `Look: ${theme === "dark" ? "dark" : theme === "light" ? "light" : "the same as this device"}. Press to change it.`;
  return (
    <button type="button" onClick={turn} title={say} aria-label={say}>
      <Sign aria-hidden="true" />
    </button>
  );
}

// Where it is shown once (/admin's bar).
export function ThemeSwitch({ initial }: { initial: Theme | null }) {
  const [theme, turn] = useTheme(initial);
  return <ThemeButton theme={theme} turn={turn} />;
}
