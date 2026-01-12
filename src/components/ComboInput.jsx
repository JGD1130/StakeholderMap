import * as React from 'react';

export default function ComboInput({ label, value, onChange, options, placeholder }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef(null);

  const normalizedOptions = React.useMemo(() => {
    const seen = new Set();
    const list = [];
    (options || []).forEach((opt) => {
      const normalized = typeof opt === 'string'
        ? { value: opt, label: opt }
        : opt;
      if (!normalized || !normalized.value) return;
      if (seen.has(normalized.value)) return;
      seen.add(normalized.value);
      list.push({
        value: normalized.value,
        label: normalized.label ?? normalized.value
      });
    });
    return list;
  }, [options]);

  const displayLabel = React.useMemo(() => {
    const match = normalizedOptions.find((opt) => opt.value === value);
    return match?.label ?? (value ?? '');
  }, [normalizedOptions, value]);

  const filteredOptions = React.useMemo(() => {
    const search = (query || '').toLowerCase();
    if (!search) return normalizedOptions;
    return normalizedOptions.filter((opt) => {
      const label = (opt.label ?? '').toLowerCase();
      const val = (opt.value ?? '').toLowerCase();
      return label.includes(search) || val.includes(search);
    });
  }, [normalizedOptions, query]);

  const inputValue = query || displayLabel || '';

  return (
    <div className="mf-form-row" style={{ position: 'relative' }}>
      <label>{label}</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
        <input
          ref={inputRef}
          className="mf-input"
          placeholder={placeholder}
          value={inputValue}
          onChange={(e) => {
            const nextValue = e.target.value;
            setQuery(nextValue);
            onChange?.(nextValue);
          }}
          onFocus={() => setOpen(true)}
        />
        <button
          type="button"
          className="mf-input"
          style={{ width: 34, padding: 0, display: 'grid', placeItems: 'center' }}
          onClick={() => {
            setOpen((prev) => {
              const next = !prev;
              if (next) {
                inputRef.current?.focus();
              }
              return next;
            });
          }}
          title="Toggle options"
        >
          ▼
        </button>
      </div>

      {open && (
        <div
          style={{
            position: 'absolute',
            zIndex: 9999,
            left: 0,
            right: 0,
            top: '100%',
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 8,
            maxHeight: 240,
            overflow: 'auto',
            marginTop: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,.12)'
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {filteredOptions.length === 0 ? (
            <div style={{ padding: 10, color: '#777' }}>No matches</div>
          ) : (
            filteredOptions.map((opt) => (
              <div
                key={opt.value}
                style={{ padding: '8px 10px', cursor: 'pointer' }}
                onClick={() => {
                  onChange?.(opt.value);
                  setQuery('');
                  setOpen(false);
                }}
              >
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
