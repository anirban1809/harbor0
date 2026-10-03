'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, Mail, SearchX } from 'lucide-react';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { Input } from './ui/input';

export type RecipientUser = {
  id: string;
  username: string;
  displayName: string;
  exchangeCount?: number;
};
/** What the typed text resolves to: a known account, an invitation, or nothing sendable yet. */
export type RecipientKind = 'user' | 'invite' | 'unknown';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isEmail = (value: string) => !value.startsWith('@') && emailPattern.test(value);
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

/**
 * The “To” field for sending and sharing. It suggests frequent contacts, searches accounts
 * as you type, and offers an invitation when an email address has no account. The chosen
 * recipient is submitted as `recipient` (“@username” or an email address).
 */
export function RecipientPicker({
  search,
  allowInvite = false,
  autoFocus,
  onKindChange,
}: {
  /** GETs an API path and returns its JSON body. */
  search: (path: string) => Promise<{ users: RecipientUser[] }>;
  /** Unregistered email addresses can receive a sign-up invitation. */
  allowInvite?: boolean;
  autoFocus?: boolean;
  onKindChange?: (kind: RecipientKind) => void;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [contacts, setContacts] = useState<RecipientUser[]>([]);
  const [results, setResults] = useState<{ query: string; users: RecipientUser[] } | null>(null);
  const searchRef = useRef(search);
  searchRef.current = search;
  const query = value.trim();
  const debounced = useDebouncedValue(query, 200);

  useEffect(() => {
    let cancelled = false;
    searchRef
      .current('/v1/users/contacts')
      .then((page) => !cancelled && setContacts(page.users))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!debounced) return;
    let cancelled = false;
    searchRef
      .current('/v1/users/search?q=' + encodeURIComponent(debounced))
      .then((page) => !cancelled && setResults({ query: debounced, users: page.users }))
      .catch(() => !cancelled && setResults({ query: debounced, users: [] }));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const searched = results?.query === query;
  const selected = [...contacts, ...(results?.users ?? [])].find(
    (user) => query.toLowerCase() === `@${user.username}`,
  );
  // Matching contacts appear at once, before the account search returns.
  const needle = query.replace(/^@/, '').toLowerCase();
  const suggestions = selected
    ? []
    : !query
      ? contacts
      : [
          ...contacts.filter(
            (user) =>
              user.username.startsWith(needle) || user.displayName.toLowerCase().includes(needle),
          ),
          ...(searched ? results!.users : []),
        ].filter((user, index, all) => all.findIndex((other) => other.id === user.id) === index);
  const email = isEmail(query) ? query.toLowerCase() : null;
  const kind: RecipientKind = selected
    ? 'user'
    : email && searched && results!.users.length === 0
      ? allowInvite
        ? 'invite'
        : 'unknown'
      : email && suggestions.length
        ? 'user'
        : 'unknown';
  const kindRef = useRef(onKindChange);
  kindRef.current = onKindChange;
  useEffect(() => kindRef.current?.(kind), [kind]);

  const showList = open && suggestions.length > 0;
  const notFound =
    searched && !selected && !suggestions.length && query.replace(/^@/, '').length >= 2;
  function choose(user: RecipientUser) {
    setValue(`@${user.username}`);
    setActive(-1);
    setOpen(false);
  }

  return (
    <div className="field recipient-picker">
      <label className="field-label" htmlFor={id}>
        To
      </label>
      <div className="recipient-input">
        <Input
          id={id}
          name="recipient"
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          required
          placeholder="@username or email"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && showList) {
              // Close the suggestions without closing the dialog.
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((index) => (index + step + suggestions.length) % suggestions.length);
            } else if (event.key === 'Enter' && showList && active >= 0) {
              event.preventDefault();
              choose(suggestions[active]!);
            }
          }}
        />
        {selected && <Check className="recipient-check" size={16} aria-label="Account found" />}
      </div>
      {showList && (
        <div className="recipient-list" id={listId} role="listbox" aria-label="People">
          {!query && <div className="recipient-list-label">Frequent contacts</div>}
          {suggestions.map((user, index) => (
            <div
              key={user.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className="recipient-option"
              // Keep focus in the input so the list stays open until a choice is made.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(user)}
              onMouseEnter={() => setActive(index)}
            >
              <span className="avatar" aria-hidden="true">
                {initials(user.displayName) || user.username[0]!.toUpperCase()}
              </span>
              <span className="recipient-option-text">
                <strong>{user.displayName}</strong>
                <small>@{user.username}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      {kind === 'invite' && (
        <div className="recipient-note" role="status">
          <Mail size={16} aria-hidden="true" />
          <span>
            <strong>{email}</strong> isn’t on harbor0 yet. We’ll email them a link to sign up, along
            with a note that you shared files with them.
          </span>
        </div>
      )}
      {notFound && kind !== 'invite' && (
        <div className="recipient-note" data-tone="muted" role="status">
          <SearchX size={16} aria-hidden="true" />
          <span>
            {email
              ? 'No account uses this email address.'
              : allowInvite
                ? 'No one has that username. To invite someone new, enter their email address.'
                : 'No one has that username.'}
          </span>
        </div>
      )}
    </div>
  );
}
