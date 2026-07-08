import { useEffect, useRef } from "react";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap, history } from "@codemirror/commands";
import { EXPR_FUNCTIONS, EXPR_METHODS, EXPR_NAMESPACES, EXPR_FILE_MEMBERS, EXPR_DATE_MEMBERS } from "../lib/bases";

// Context-aware completion for the Bases expression language: after `.` offer
// members/methods (file.* members specifically after `file.`), otherwise the
// top-level functions + namespaces.
function basesCompletion(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w.]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const dot = word.text.lastIndexOf(".");
  if (dot >= 0) {
    const base = word.text.slice(0, dot);
    const options = base.endsWith("file")
      ? EXPR_FILE_MEMBERS.map((label) => ({ label, type: "property" }))
      : [
          ...EXPR_METHODS.map((label) => ({ label, type: "method" })),
          ...EXPR_DATE_MEMBERS.map((label) => ({ label, type: "property" })),
        ];
    return { from: word.from + dot + 1, options, validFor: /^\w*$/ };
  }
  return {
    from: word.from,
    options: [
      ...EXPR_FUNCTIONS.map((label) => ({ label, type: "function", apply: `${label}(` })),
      ...EXPR_NAMESPACES.map((label) => ({ label, type: "namespace" })),
    ],
    validFor: /^[\w.]*$/,
  };
}

interface Props {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  className?: string;
}

/** A single-line CodeMirror editor for a Bases expression, with language-aware
 * autocomplete (functions / namespaces / members / methods). Validation is
 * shown by the caller via validateExpr. */
export function ExprInput({ value, placeholder, onChange, onBlur, className }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        // Single-line: reject any change that would introduce a newline.
        EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr)),
        cmPlaceholder(placeholder ?? ""),
        autocompletion({ override: [basesCompletion], activateOnTyping: true }),
        keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          if (u.focusChanged && !u.view.hasFocus) onBlurRef.current?.();
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync an external value change (e.g. a resync from props) without clobbering
  // the caret while the user types (guarded by the equality check).
  useEffect(() => {
    const v = view.current;
    if (v && value !== v.state.doc.toString()) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className={`expr-input${className ? ` ${className}` : ""}`} ref={host} />;
}
