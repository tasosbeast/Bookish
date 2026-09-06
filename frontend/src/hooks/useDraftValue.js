import { useState } from 'react';

// Refresh untouched fields from the server while preserving independently edited fields.
export function useDraftValue(source) {
  const [draft, setDraft] = useState({ source, value: source });
  let value = draft.value;
  if (draft.source !== source) {
    value = draft.value === draft.source ? source : draft.value;
    setDraft({ source, value });
  }
  return [value, next => setDraft({ source, value: next })];
}
