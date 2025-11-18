import * as React from 'react';

export default function ComboInput({ label, value, onChange, options, placeholder }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef(null);

  const list = React.useMemo(() => {
    const uniq = Array.from(new Set((options || []).map(String))).sort();
    if (!query) return uniq;
    const q = query.toLowerCase();
    return uniq.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="mf-form-row" style={{ position: 'relative' }}>
      <label>{label}</label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
        <input
          ref={inputRef}
          className="mf-input"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setQuery(e.target.value);
            onChange?.(e.target.value);
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
          ▾
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
          {list.length === 0 ? (
            <div style={{ padding: 10, color: '#777' }}>No matches</div>
          ) : (
            list.map((opt) => (
              <div
                key={opt}
                style={{ padding: '8px 10px', cursor: 'pointer' }}
                onClick={() => {
                  onChange?.(opt);
                  setQuery('');
                  setOpen(false);
                }}
              >
                {opt}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
