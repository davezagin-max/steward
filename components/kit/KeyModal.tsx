"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isRemembered, setKey } from "./key-store";

interface KeyModalProps {
  open: boolean;
  hasKey: boolean;
  onClose: () => void;
}

/** Native <dialog>: focus trap, Escape to close, and a backdrop come for free. */
export function KeyModal({ open, hasKey, onClose }: KeyModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const key = String(form.get("key") ?? "").trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{16,}$/.test(key)) {
      setError("Anthropic keys start with sk-ant-. Check that you pasted the whole key.");
      return;
    }
    setKey(key, form.get("remember") === "on");
    setError(null);
    event.currentTarget.reset();
    onClose();
  }

  function handleRemove() {
    setKey(null, false);
    setError(null);
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-semibold">Add your Anthropic key</h2>
        <p className="text-sm text-muted">
          Your key stays in this browser tab. It is sent with each request to this app&apos;s own
          API route, which calls Claude and forgets it. It is never stored or logged on the server.
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-sm font-medium">
            API key
          </label>
          <input
            id={inputId}
            name="key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-..."
            aria-invalid={error !== null}
            aria-describedby={error ? `${inputId}-error` : undefined}
            className="rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          {error && (
            <p id={`${inputId}-error`} role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="remember"
            defaultChecked={isRemembered()}
            className="size-4 accent-(--accent)"
          />
          Remember for this tab (sessionStorage, cleared when the tab closes)
        </label>
        <p className="text-xs text-muted">
          No key? The demo replays recorded runs.{" "}
          <a
            href="https://platform.claude.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Create a key
          </a>
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {hasKey && (
            <button
              type="button"
              onClick={handleRemove}
              className="mr-auto rounded-md px-3 py-2 text-sm text-danger hover:underline"
            >
              Remove key
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-bg"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            Use this key
          </button>
        </div>
      </form>
    </dialog>
  );
}
