/**
 * Runs before first paint (see app/layout.tsx) so the saved or system theme
 * applies without a flash.
 *
 * This lives in a plain module, not in ThemeToggle.tsx, on purpose. A server
 * component that imports a value from a "use client" file gets a lazy
 * reference to it, not the value. The layout would then hand React a script
 * whose contents are only known once the page's JavaScript has loaded, and on
 * a slow chunk the whole document could fail hydration (React error 418) and
 * be rendered again from scratch.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("theme");if(t!=="light"&&t!=="dark"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=t}catch(e){}})()`;
