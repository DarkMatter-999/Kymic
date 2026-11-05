import { useEffect, useState } from 'react';

export interface ProfileOption {
  name: string;
  label: string;
  description: string;
}

interface ProfilePickerProps {
  value: string | undefined;
  onChange: (name: string) => void;
}

/** Chooses what the agent may use, before the conversation's first message. It cannot change afterwards. */
export function ProfilePicker({ value, onChange }: ProfilePickerProps) {
  const [options, setOptions] = useState<ProfileOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/pi/profiles')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: ProfileOption[]) => {
        if (cancelled) return;
        setOptions(list);
        if (list.length > 0 && !value) onChange(list[0].name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Load once; `value` and `onChange` only seed the initial choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (options.length < 2) return null;
  const current = options.find((o) => o.name === value);
  return (
    <div className="flex flex-col items-center gap-1 text-xs text-zinc-400">
      <label className="flex items-center gap-2">
        Tools
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className="input-field rounded-lg px-2 py-1 text-sm text-zinc-100 focus:outline-none"
        >
          {options.map((o) => (
            <option key={o.name} value={o.name}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {current && <p className="max-w-xs">{current.description}</p>}
    </div>
  );
}
