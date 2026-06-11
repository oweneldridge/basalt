import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  defaultValue: string;
  confirmLabel: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

export function PromptModal({ title, defaultValue, confirmLabel, onConfirm, onClose }: Props) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus with the basename (after the last /) selected — the common edit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const slash = defaultValue.lastIndexOf("/");
    el.setSelectionRange(slash + 1, defaultValue.length);
  }, [defaultValue]);

  const submit = () => {
    const v = value.trim();
    if (v && v !== defaultValue) onConfirm(v);
    else onClose();
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="prompt" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prompt-title">{title}</div>
        <input
          ref={inputRef}
          className="prompt-input"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="prompt-actions">
          <button className="badge-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="primary prompt-confirm" onClick={submit}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
