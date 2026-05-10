"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

export type SelectOption = { value: string; label: string };

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  variant?: "pill" | "input";
  placeholder?: string;
};

export default function CustomSelect({
  value,
  options,
  onChange,
  className = "",
  variant = "input",
  placeholder,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerBase =
    variant === "pill"
      ? "rounded-full border border-[var(--border-soft)] bg-[rgba(148,163,184,0.04)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:border-[var(--border-mid)]"
      : "w-full rounded-lg border border-[var(--border-mid)] bg-[var(--bg-panel-2)] px-3 py-2 text-[13px] text-[var(--text-primary)] hover:border-[var(--border-strong)]";

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center justify-between gap-2 transition-colors focus:outline-none focus:border-[var(--accent-teal)] ${triggerBase}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate text-left">
          {selected?.label ?? placeholder ?? "Select…"}
        </span>
        <ChevronDown
          size={14}
          className={`text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute z-[200] mt-1 w-full overflow-hidden rounded-lg border border-[var(--border-mid)] bg-[var(--bg-elevated)] shadow-lg shadow-black/40 backdrop-blur"
        >
          {options.map((opt) => {
            const isSel = opt.value === value;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSel}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`cursor-pointer px-3 py-2 text-[13px] transition-colors ${
                  isSel
                    ? "bg-[var(--accent-teal-soft)] text-[var(--accent-teal)]"
                    : "text-[var(--text-secondary)] hover:bg-white/[0.04] hover:text-[var(--text-primary)]"
                }`}
              >
                {opt.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
